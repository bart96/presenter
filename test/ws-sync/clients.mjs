/**
 * Client models for the relay integration test.
 *
 * These are deliberately thin PORTS of the app's real clients: each one implements
 * the same wire protocol and the same state machine as its counterpart, with the
 * source it mirrors named above every class. They exist because the real clients are
 * React hooks / an Electron renderer / a PHP-rendered page that cannot all be booted
 * headlessly at once.
 *
 * What that buys, and what it does not: the relay under test is the real server, and
 * the MESSAGE SHAPES here are copied field-for-field from the senders — so anything
 * that goes wrong because one client sends a payload another client cannot handle is
 * caught. Rendering, React scheduling and Electron IPC are out of scope.
 *
 * Keep the ports honest: when the source changes, change these to match, and note the
 * line references so the next reader can diff them.
 */
import { WebSocket } from 'ws';
import { resolveSyncIndex, showOrderSignature } from './syncProtocol.mjs';

let clientSeq = 0;

/** Close code the relay uses for `disconnect_peers` (ws-server/src/server.ts:98). */
export const WS_CLOSE_OPERATOR_DISCONNECT = 4010;

// ── Base ────────────────────────────────────────────────────────────────────

class BaseClient {
  /**
   * @param {object} opts
   * @param {string} opts.url    relay URL
   * @param {number} opts.account account number for auth
   * @param {string} opts.name    label used in the test log
   * @param {object} opts.clientInfo `{ role, mode?, name? }` descriptor sent on auth
   */
  constructor({ url, account, name, clientInfo }) {
    this.url = url;
    this.account = account;
    this.name = name ?? `client-${++clientSeq}`;
    this.clientInfo = clientInfo;
    this.ws = null;
    this.authed = false;
    this.lastMessageAt = 0;
    /** Every message received, in order — scenarios assert over this. */
    this.received = [];
    /** Every message sent, in order. */
    this.sent = [];
    this.closeCode = null;
    this.closedByOperator = false;
    this.peerCount = 0;
    this.peers = [];
    this.syncTtlSeconds = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const failTimer = setTimeout(() => reject(new Error(`${this.name}: auth timed out`)), 5000);

      ws.on('open', () => {
        this.send({ action: 'auth', account: this.account, client: this.clientInfo });
      });

      ws.on('message', (raw) => {
        this.lastMessageAt = Date.now();
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.received.push(msg);

        if (msg.type === 'auth_ok') {
          this.authed = true;
          this.peerCount = typeof msg.others === 'number' ? msg.others : Math.max(0, (msg.count ?? 1) - 1);
          this.peers = Array.isArray(msg.peers) ? msg.peers : [];
          if (typeof msg.syncTtlSeconds === 'number') this.syncTtlSeconds = msg.syncTtlSeconds;
          clearTimeout(failTimer);
          this.onAuthOk?.(msg);
          resolve(this);
          return;
        }
        if (msg.type === 'peer_count') {
          this.peerCount = typeof msg.others === 'number' ? msg.others : Math.max(0, (msg.count ?? 1) - 1);
          this.peers = Array.isArray(msg.peers) ? msg.peers : this.peers;
          return;
        }
        this.onMessage?.(msg);
      });

      ws.on('close', (code) => {
        this.authed = false;
        this.closeCode = code;
        if (code === WS_CLOSE_OPERATOR_DISCONNECT) this.closedByOperator = true;
        this.onClose?.(code);
      });

      ws.on('error', (err) => {
        clearTimeout(failTimer);
        reject(err);
      });
    });
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.sent.push(obj);
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /** `{ type: 'broadcast', action, data }` — the envelope every app client uses. */
  broadcast(action, data) {
    return this.send({ type: 'broadcast', action, data });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  /** Every `musician_sync` payload this client saw, oldest first. */
  syncs() {
    return this.received
      .filter((m) => m.action === 'musician_sync' && m.data)
      .map((m) => ({ ...m.data, __replay: !!m.replay, __ageMs: m.ageMs }));
  }
}

// ── Content fixtures ────────────────────────────────────────────────────────

/**
 * A show + song library shared by the operator and the musicians. Small on purpose:
 * two songs with distinguishable block names, plus one media item, which is enough to
 * exercise the song-match guards without turning assertions into arithmetic puzzles.
 */
export function makeShow() {
  const song101 = {
    songNumber: 101,
    title: 'Großer Gott, wir loben Dich',
    blocks: [
      { name: 'Verse 1', lines: [{ text: '[101 v1 line 1]' }, { text: '[101 v1 line 2]' }] },
      { name: 'Chorus', lines: [{ text: '[101 chorus line 1]' }] },
      { name: 'Verse 2', lines: [{ text: '[101 v2 line 1]' }] },
      { name: 'Bridge', lines: [{ text: '[101 bridge line 1]' }] },
    ],
  };
  const song202 = {
    songNumber: 202,
    title: 'Der Herr ist mein Hirte',
    blocks: [
      { name: 'Verse 1', lines: [{ text: '[202 v1 line 1]' }] },
      { name: 'Chorus', lines: [{ text: '[202 chorus line 1]' }] },
      { name: 'Verse 2', lines: [{ text: '[202 v2 line 1]' }] },
    ],
  };
  return {
    title: 'Gottesdienst 15.08.',
    order: [
      { type: 'song', songNumber: 101 },
      { type: 'media', mediaSubType: 'image', label: 'Ankündigungen' },
      { type: 'song', songNumber: 202 },
    ],
    songs: { 101: song101, 202: song202 },
  };
}

// ── Operator ────────────────────────────────────────────────────────────────

/**
 * Mirrors `usePresentationSync` + `useWsOperator`.
 *
 * - incoming musician_sync         → usePresentationSync.ts:103-121 (handleMusicianSync)
 * - incoming get_state             → usePresentationSync.ts:126-130 (handleGetState)
 * - incoming remote_command        → usePresentationSync.ts:185-267 (handleRemoteCommand)
 * - outgoing musician_sync payload → usePresentationSync.ts:633-659
 * - broadcast dedupe (contentKey)  → usePresentationSync.ts:664-677
 * - replay is ignored              → useWsOperator.ts:137-145
 * - other operators are ignored    → useWsOperator.ts:144-155
 * - live-operator gate             → usePresentationSync.ts (isLiveOperator)
 * - show-version gate              → usePresentationSync.ts (resolveSyncIndex)
 *
 * `isLive` stands in for `isLiveOperator()`: the real hook derives it from whether this
 * instance has a presentation window open, which has no meaning here, so scenarios set it
 * directly. It defaults to true — a lone operator in a test is the one driving the show.
 */
export class OperatorClient extends BaseClient {
  constructor({
    url,
    account,
    show,
    midiTrackingMaster = 'midi',
    remoteControlCommands = {},
    resetBlackOnSwitch = false,
    isLive = true,
    deviceId,
    name = 'operator',
  }) {
    super({ url, account, name, clientInfo: { role: 'operator' } });
    this.show = show;
    this.isLive = isLive;
    this.deviceId = deviceId ?? `operator-${Math.random().toString(36).slice(2, 10)}`;
    /** Peers whose state we refused because they hold a different show order. */
    this.rejectedStale = [];
    this.midiTrackingMaster = midiTrackingMaster;
    this.remoteControlCommands = remoteControlCommands;
    this.resetBlackOnSwitch = resetBlackOnSwitch;
    this.state = { activeItemIndex: 0, activeBlockIndex: 0, activeLineIndex: 0, isBlack: false, isTextHidden: false, videoVisible: true };
    this.lastKey = '';
    /** Every payload this operator put on the wire — used to assert it did/did not resend. */
    this.broadcasts = [];
    /** Positions adopted from a musician, for the "operator followed" assertions. */
    this.followed = [];
  }

  onAuthOk() {
    // Following a MIDI master: ask where the show is rather than assume our own position
    // is the truth — useWsOperator.ts (requestStateOnConnect).
    if (this.midiTrackingMaster === 'midi') this.send({ action: 'get_state', id: 'operator-init' });
    this.emit();
  }

  onMessage(msg) {
    if (msg.action === 'musician_sync' && msg.data) {
      if (msg.replay) return; // useWsOperator.ts:142
      // Another operator is not navigation input for this one — useWsOperator.ts:152.
      if (msg.data.senderRole === 'operator') return;
      this.handleMusicianSync(msg.data);
    } else if (msg.action === 'get_state') {
      if (!this.isLive) return; // usePresentationSync.ts — handleGetState
      this.lastKey = ''; // usePresentationSync.ts:128
      this.emit();
    } else if (msg.action === 'remote_command' && msg.data) {
      if (!this.isLive) return; // usePresentationSync.ts — handleRemoteCommand
      this.handleRemoteCommand(msg.data);
    }
  }

  get itemCount() {
    return this.show.order.length;
  }

  get activeItem() {
    return this.show.order[this.state.activeItemIndex];
  }

  get currentSong() {
    const item = this.activeItem;
    return item?.type === 'song' ? this.show.songs[item.songNumber] : undefined;
  }

  /** Renderable blocks (usePresentationSync filters the copyright block out). */
  get blocks() {
    return this.currentSong?.blocks ?? [];
  }

  /** `getBlocks(order)` — includes the trailing copyright block, as remote nav does. */
  get allBlocks() {
    const song = this.currentSong;
    if (!song) return [];
    return [...song.blocks, { name: 'Copyright', copyright: true }];
  }

  get showSig() {
    return showOrderSignature(this.show);
  }

  handleMusicianSync(state) {
    if (this.midiTrackingMaster !== 'midi') return;
    const hasItem = typeof state.activeItemIndex === 'number';
    const hasBlock = typeof state.activeBlockIndex === 'number';

    const match = resolveSyncIndex({
      theirSig: state.showSig,
      ourSig: this.showSig,
      theirItemIndex: state.activeItemIndex,
      theirSongNumber: state.songNumber,
      ourItems: this.show.order,
    });
    if (match.kind === 'stale') {
      this.rejectedStale.push({ songNumber: state.songNumber, itemIndex: state.activeItemIndex });
      return;
    }
    const itemIndex = match.kind === 'resolved' ? match.itemIndex : state.activeItemIndex;

    const clampItem = (idx) => Math.max(0, Math.min(idx, Math.max(0, this.itemCount - 1)));
    if (hasItem && hasBlock) {
      this.setItemAndBlock(clampItem(itemIndex), state.activeBlockIndex);
    } else if (hasItem) {
      this.setActiveItemIndex(clampItem(itemIndex));
    } else if (hasBlock) {
      this.setActiveBlockIndex(state.activeBlockIndex);
    }
    this.followed.push({ item: this.state.activeItemIndex, block: this.state.activeBlockIndex, from: state.clientId ?? null });
  }

  handleRemoteCommand(data) {
    const command = typeof data.command === 'string' ? data.command : '';
    const allowed = (id) => this.remoteControlCommands[id] !== false;
    if (command === 'set_item') {
      if (!allowed('next_item') && !allowed('prev_item')) return;
    } else if (command === 'set_block') {
      if (!allowed('next_block') && !allowed('prev_block')) return;
    } else if (!allowed(command)) {
      return;
    }
    switch (command) {
      case 'prev_item':
        if (this.state.activeItemIndex > 0) {
          this.setActiveItemIndex(this.state.activeItemIndex - 1);
          if (this.resetBlackOnSwitch) this.setBlack(false);
        }
        break;
      case 'next_item':
        if (this.state.activeItemIndex < this.itemCount - 1) {
          this.setActiveItemIndex(this.state.activeItemIndex + 1);
          if (this.resetBlackOnSwitch) this.setBlack(false);
        }
        break;
      case 'set_item': {
        const idx = typeof data.index === 'number' ? Math.floor(data.index) : null;
        if (idx != null) {
          this.setActiveItemIndex(Math.max(0, Math.min(idx, Math.max(0, this.itemCount - 1))));
          if (this.resetBlackOnSwitch) this.setBlack(false);
        }
        break;
      }
      case 'prev_block':
        if (this.state.activeBlockIndex > 0) this.setActiveBlockIndex(this.state.activeBlockIndex - 1);
        break;
      case 'next_block': {
        if (!this.currentSong) break;
        if (this.state.activeBlockIndex < this.allBlocks.length - 1) this.setActiveBlockIndex(this.state.activeBlockIndex + 1);
        break;
      }
      case 'set_block': {
        const idx = typeof data.index === 'number' ? Math.floor(data.index) : null;
        if (idx != null && this.currentSong) {
          this.setActiveBlockIndex(Math.max(0, Math.min(idx, Math.max(0, this.allBlocks.length - 1))));
        }
        break;
      }
      case 'toggle_black':
        this.setBlack(!this.state.isBlack);
        break;
      case 'toggle_text':
        this.state.isTextHidden = !this.state.isTextHidden;
        this.emit();
        break;
      case 'toggle_video':
        this.state.videoVisible = !this.state.videoVisible;
        this.emit();
        break;
      default:
        break;
    }
  }

  // ── Local operator actions (keyboard / sidebar) ──
  setActiveItemIndex(idx) {
    this.state.activeItemIndex = idx;
    this.state.activeBlockIndex = 0;
    this.state.activeLineIndex = 0;
    this.emit();
  }
  setActiveBlockIndex(idx) {
    this.state.activeBlockIndex = idx;
    this.state.activeLineIndex = 0;
    this.emit();
  }
  setItemAndBlock(itemIndex, blockIndex) {
    this.state.activeItemIndex = itemIndex;
    this.state.activeBlockIndex = blockIndex;
    this.state.activeLineIndex = 0;
    this.emit();
  }
  setBlack(value) {
    this.state.isBlack = value;
    this.emit();
  }
  toggleBlack() {
    this.setBlack(!this.state.isBlack);
  }
  nextBlock() {
    if (this.state.activeBlockIndex < this.allBlocks.length - 1) this.setActiveBlockIndex(this.state.activeBlockIndex + 1);
  }
  nextItem() {
    if (this.state.activeItemIndex < this.itemCount - 1) this.setActiveItemIndex(this.state.activeItemIndex + 1);
  }

  /** Build the payload exactly as usePresentationSync.ts:633-659 does. */
  buildPayload() {
    const item = this.activeItem;
    const song = this.currentSong;
    const contentType =
      item?.type === 'song' ? 'song' : item?.type === 'media' ? 'media' : item?.type === 'bible_verse' ? 'bible_verse' : 'empty';
    const blocks = this.blocks;
    const activeBlock = blocks[this.state.activeBlockIndex];
    const itemTitle =
      contentType === 'song'
        ? (song?.title ?? '')
        : contentType === 'bible_verse'
          ? item?.bibleRef || item?.label || 'Bible'
          : contentType === 'media'
            ? item?.label || 'Media'
            : '';
    return {
      senderRole: 'operator',
      senderId: this.deviceId,
      showSig: this.showSig,
      activeItemIndex: this.state.activeItemIndex,
      activeBlockIndex: this.state.activeBlockIndex,
      activeLineIndex: this.state.activeLineIndex,
      isBlack: this.state.isBlack,
      isTextHidden: this.state.isTextHidden,
      videoVisible: this.state.videoVisible,
      songNumber: song?.songNumber,
      songTitle: song?.title,
      showTitle: this.show.title,
      orderName: 'Default',
      contentType,
      blockName: activeBlock?.name,
      blockLines: activeBlock?.lines,
      itemTitle,
      mediaSubType: item?.mediaSubType,
      agenda: this.show.order.map((i) => ({
        type: i.type,
        label: i.type === 'song' ? (this.show.songs[i.songNumber]?.title ?? `#${i.songNumber}`) : i.label || 'Media',
      })),
      blockNames: blocks.map((b) => b.name),
      remoteCommands: [
        'prev_block',
        'next_block',
        'prev_item',
        'next_item',
        'toggle_text',
        'toggle_video',
        'toggle_video_playback',
        'toggle_black',
      ].filter((id) => this.remoteControlCommands[id] !== false),
    };
  }

  /** The dedupe key from usePresentationSync.ts:665, trimmed to the fields this suite varies. */
  contentKey() {
    const p = this.buildPayload();
    return [
      p.contentType,
      p.activeItemIndex,
      p.activeBlockIndex,
      p.activeLineIndex,
      p.isBlack,
      p.isTextHidden,
      p.videoVisible,
      this.blocks.length,
      p.remoteCommands.join(','),
    ].join('|');
  }

  /** Broadcast unless the dedupe key says nothing observable changed — and unless this
   *  instance is passive, in which case it has nothing anyone should hear. */
  emit() {
    if (!this.isLive) return false;
    const key = this.contentKey();
    if (key === this.lastKey) return false;
    this.lastKey = key;
    const payload = this.buildPayload();
    this.broadcasts.push(payload);
    this.broadcast('musician_sync', payload);
    return true;
  }

  /**
   * `presenter:disconnect-ws-peers` → usePresentationSync.ts:290. The app sends it through
   * `wsBroadcast`, so `action` rides on the broadcast envelope where the relay reads it.
   */
  disconnectPeers() {
    this.broadcast('disconnect_peers');
  }
}

// ── Musician ────────────────────────────────────────────────────────────────

/** MusicianPage.tsx — LOCAL_AUTHORITY_MS. */
export const LOCAL_AUTHORITY_MS = 600;

/**
 * Mirrors `MusicianPage` + `useWsSync`.
 *
 * - incoming musician_sync   → MusicianPage.tsx:198-262 (onStateUpdate)
 * - MIDI navigation          → MusicianPage.tsx:603-669 (handleMidiAction)
 * - manual item nav          → MusicianPage.tsx:578-600 (handleManualNav)
 * - order-tag / mapping tap  → MusicianPage.tsx:676-705
 * - outgoing sync payload    → MusicianPage.tsx:544-550 (broadcastMidiSync)
 * - get_state on auth        → useWsSync.ts:132-138
 * - local-authority window   → MusicianPage.tsx (LOCAL_AUTHORITY_MS)
 * - show-version gate        → MusicianPage.tsx (resolveSyncIndex)
 *
 * `now()` is injectable so a scenario can drive the authority window without sleeping.
 */
export class MusicianClient extends BaseClient {
  constructor({ url, account, show, syncMode = 'midi', musicianName = 'Musician', deviceId, now, name }) {
    super({ url, account, name: name ?? `musician(${syncMode})`, clientInfo: { role: 'musician', mode: syncMode, name: musicianName } });
    this.show = show;
    this.syncMode = syncMode;
    this.clientId = `musician-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.deviceId = deviceId ?? this.clientId;
    /** Injectable clock for the local-authority window. */
    this.now = now ?? (() => Date.now());
    this.lastLocalNavAt = 0;
    /** Peers whose state we refused because they hold a different show order. */
    this.rejectedStale = [];
    /** This page's own item selection (activeItemIndex in MusicianPage). */
    this.localItemIndex = 0;
    /** Redux mirror of the operator position (operatorItemIndex / operatorActiveBlockIndex). */
    this.operatorItemIndex = 0;
    this.operatorBlockIndex = 0;
    this.pendingWsState = null;
    this.operatorSongNumber = undefined;
    this.operatorShowTitle = undefined;
    this.broadcasts = [];
    this.remoteCommandFailed = false;
  }

  onAuthOk() {
    if (this.syncMode !== 'off') this.send({ action: 'get_state', id: 'init' }); // useWsSync.ts:134
  }

  /** A peer asked where the show is; in MIDI mode we are the one who knows. */
  answerGetState() {
    if (this.syncMode !== 'midi') return;
    this.broadcastMidiSync(
      {
        activeItemIndex: this.localItemIndex,
        activeBlockIndex: this.operatorBlockIndex,
        activeLineIndex: 0,
        songNumber: this.activeSongNumber,
      },
      { local: false },
    );
  }

  get showSig() {
    return showOrderSignature(this.show);
  }

  onMessage(msg) {
    if (msg.action === 'get_state') {
      this.answerGetState();
      return;
    }
    if (msg.action !== 'musician_sync' || !msg.data) return;
    const state = { ...msg.data, replay: !!msg.replay };
    if (this.syncMode === 'off') return; // MusicianPage.tsx:201
    if (state.clientId && state.clientId === this.clientId) return; // :205
    if (state.senderRole === 'musician' && state.senderId && state.senderId === this.deviceId) return;
    if (state.replay && this.syncMode === 'midi') return; // :212
    // Our own recent input outranks an echo of it — MusicianPage.tsx (LOCAL_AUTHORITY_MS).
    if (this.syncMode === 'midi' && this.now() - this.lastLocalNavAt < LOCAL_AUTHORITY_MS) return;

    const match = resolveSyncIndex({
      theirSig: state.showSig,
      ourSig: this.showSig,
      theirItemIndex: state.activeItemIndex,
      theirSongNumber: state.songNumber,
      ourItems: this.show.order,
    });
    if (match.kind === 'stale') {
      this.rejectedStale.push({ songNumber: state.songNumber, itemIndex: state.activeItemIndex });
      return;
    }
    const incomingItemIndex = match.kind === 'resolved' ? match.itemIndex : state.activeItemIndex;

    this.pendingWsState = {
      activeItemIndex: typeof incomingItemIndex === 'number' ? incomingItemIndex : undefined,
      activeBlockIndex: typeof state.activeBlockIndex === 'number' ? state.activeBlockIndex : undefined,
    };
    if (typeof state.songNumber === 'number') this.operatorSongNumber = state.songNumber;
    if (typeof state.showTitle === 'string') this.operatorShowTitle = state.showTitle;

    let shownItemIndex = this.localItemIndex;
    // Followed in every mode but 'off' now — including MIDI, so a second device can
    // correct the one holding the footswitch (MusicianPage.tsx onStateUpdate).
    if (typeof incomingItemIndex === 'number') {
      const targetItem = this.show.order[incomingItemIndex];
      if (targetItem && targetItem.type === 'song') {
        this.localItemIndex = incomingItemIndex;
        shownItemIndex = incomingItemIndex;
      }
    }

    const shownItem = this.show.order[shownItemIndex];
    const matchesSong = typeof state.songNumber === 'number' && shownItem?.type === 'song' && state.songNumber === shownItem.songNumber;

    const nextItemIndex = typeof incomingItemIndex === 'number' ? incomingItemIndex : this.operatorItemIndex;
    const nextBlockIndex = matchesSong && typeof state.activeBlockIndex === 'number' ? state.activeBlockIndex : this.operatorBlockIndex;
    if (nextItemIndex !== this.operatorItemIndex || nextBlockIndex !== this.operatorBlockIndex) {
      this.operatorItemIndex = nextItemIndex;
      this.operatorBlockIndex = nextBlockIndex;
    }
  }

  get activeItem() {
    return this.show.order[this.localItemIndex];
  }
  get activeSongNumber() {
    return this.activeItem?.type === 'song' ? this.activeItem.songNumber : undefined;
  }
  get lyricsBlocks() {
    const n = this.activeSongNumber;
    return n != null ? (this.show.songs[n]?.blocks ?? []) : [];
  }

  /** broadcastMidiSync — the PARTIAL payload a musician puts on the wire. */
  broadcastMidiSync(data, opts) {
    // Only real local navigation opens the authority window — MusicianPage.tsx.
    if (opts?.local !== false) this.lastLocalNavAt = this.now();
    const tagged = {
      ...data,
      clientId: this.clientId,
      senderRole: 'musician',
      senderId: this.deviceId,
      showSig: this.showSig,
    };
    this.broadcasts.push(tagged);
    this.broadcast('musician_sync', tagged);
  }

  /** MIDI `next_song` / `prev_song` → handleManualNav (MusicianPage.tsx:578). */
  midiNextItem() {
    if (this.syncMode !== 'midi') return;
    const idx = this.localItemIndex;
    if (idx >= this.show.order.length - 1) return;
    this._midiSelectItem(idx + 1);
  }
  midiPrevItem() {
    if (this.syncMode !== 'midi') return;
    if (this.localItemIndex <= 0) return;
    this._midiSelectItem(this.localItemIndex - 1);
  }
  _midiSelectItem(index) {
    this.localItemIndex = index;
    this.operatorItemIndex = index;
    this.operatorBlockIndex = 0;
    const newItem = this.show.order[index];
    this.broadcastMidiSync({
      activeItemIndex: index,
      activeBlockIndex: 0,
      activeLineIndex: 0,
      songNumber: newItem?.type === 'song' ? newItem.songNumber : undefined,
    });
  }

  /** MIDI `next_block` (MusicianPage.tsx:619). */
  midiNextBlock() {
    if (this.syncMode !== 'midi') return;
    const blockCount = this.lyricsBlocks.length;
    if (blockCount === 0) return;
    const next = Math.min(Math.max(this.operatorBlockIndex, -1), blockCount - 1) + 1;
    if (next >= blockCount || next === this.operatorBlockIndex) return;
    this.operatorBlockIndex = next;
    this.broadcastMidiSync({
      activeItemIndex: this.localItemIndex,
      activeBlockIndex: next,
      activeLineIndex: 0,
      songNumber: this.activeSongNumber,
    });
  }

  /** MIDI `prev_block` (MusicianPage.tsx:634). */
  midiPrevBlock() {
    if (this.syncMode !== 'midi') return;
    const blockCount = this.lyricsBlocks.length;
    if (blockCount === 0) return;
    const prev = Math.min(this.operatorBlockIndex, blockCount) - 1;
    if (prev < 0 || prev === this.operatorBlockIndex) return;
    this.operatorBlockIndex = prev;
    this.broadcastMidiSync({
      activeItemIndex: this.localItemIndex,
      activeBlockIndex: prev,
      activeLineIndex: 0,
      songNumber: this.activeSongNumber,
    });
  }

  /**
   * Tapping a mapped block region in the PDF, or an order tag (MusicianPage.tsx:676 / :692).
   * Note there is no "already there" guard in either handler — re-tapping the current block
   * broadcasts again.
   */
  tapBlock(idx) {
    if (this.syncMode !== 'midi') return;
    if (idx < 0 || idx >= this.lyricsBlocks.length) return;
    this.operatorBlockIndex = idx;
    this.broadcastMidiSync({
      activeItemIndex: this.localItemIndex,
      activeBlockIndex: idx,
      activeLineIndex: 0,
      songNumber: this.activeSongNumber,
    });
  }

  /** MIDI `toggle_black` — relayed as a remote_command (MusicianPage.tsx:659-665). */
  midiToggleBlack() {
    if (!this.broadcast('remote_command', { command: 'toggle_black' })) this.remoteCommandFailed = true;
  }

  /** Switching sync mode sends a fresh descriptor (useWsSync.ts:210-218). */
  setSyncMode(mode) {
    this.syncMode = mode;
    this.clientInfo = { ...this.clientInfo, mode };
    this.send({ action: 'client_info', client: this.clientInfo });
  }
}

// ── Text viewer ─────────────────────────────────────────────────────────────

/**
 * Mirrors the text viewer page (`viewer/index.php`).
 *
 * - render()      → viewer/index.php:680
 * - showNoText()  → viewer/index.php:634
 * - auth_ok       → viewer/index.php:748
 * - sync_expired  → viewer/index.php:761
 *
 * `renders` keeps every rendered frame, because the interesting failures here are
 * transient: a frame that briefly blanks the lyrics is a visible flicker on a screen
 * in a church hall even if the next frame repairs it.
 */
export class ViewerClient extends BaseClient {
  constructor({ url, account, name = 'viewer' }) {
    super({ url, account, name, clientInfo: { role: 'viewer' } });
    /** What is on screen right now. */
    this.screen = { black: false, show: '', song: '', block: '', lines: [], waiting: true, noText: false };
    /** Every frame this viewer painted, oldest first. */
    this.renders = [];
    /** Syncs that were not presentation states, so nothing was painted for them. */
    this.ignored = [];
  }

  onAuthOk() {
    this.screen.waiting = true;
  }

  onMessage(msg) {
    if (msg.type === 'sync_expired') {
      this.showNoText();
      return;
    }
    if (msg.action === 'musician_sync' && msg.data) {
      // A bare position report from a musician is not a presentation state — only the
      // operator's payload carries `contentType` (viewer/index.php:792).
      if (typeof msg.data.contentType !== 'string') {
        this.ignored.push(msg.data);
        return;
      }
      this.render(msg.data, msg.ageMs);
    }
  }

  render(data, ageMs) {
    const lines = Array.isArray(data.blockLines) ? data.blockLines : [];
    const blockName = data.blockName || '';
    const songTitle = data.songTitle || '';
    const showTitle = data.showTitle || '';

    this.screen = {
      black: !!data.isBlack,
      show: showTitle,
      song: songTitle,
      block: blockName,
      lines: lines.map((l) => l.text ?? ''),
      waiting: lines.length === 0,
      noText: false,
      ageMs,
    };
    this.renders.push({ ...this.screen, at: Date.now() });
  }

  showNoText() {
    this.screen = { black: false, show: '', song: '', block: '', lines: [], waiting: true, noText: true };
    this.renders.push({ ...this.screen, at: Date.now() });
  }
}

// ── Mobile remote (/control) ────────────────────────────────────────────────

/**
 * Mirrors the mobile control page (`control.tsx`).
 *
 * - get_state on auth        → control.tsx:522-525
 * - partial-state merge      → control.tsx:529-536
 * - sendCommand / pickItem   → control.tsx:681-745
 */
export class RemoteClient extends BaseClient {
  constructor({ url, account, name = 'remote' }) {
    super({ url, account, name, clientInfo: { role: 'remote' } });
    this.sync = {};
  }

  onAuthOk() {
    this.broadcast('get_state');
  }

  onMessage(msg) {
    if (msg.action !== 'musician_sync' || !msg.data) return;
    // Merge only the keys present — musician clients broadcast partial states.
    for (const [k, v] of Object.entries(msg.data)) {
      if (v !== undefined) this.sync[k] = v;
    }
  }

  sendCommand(command) {
    this.broadcast('remote_command', { command });
  }
  pickItem(index) {
    this.broadcast('remote_command', { command: 'set_item', index });
  }
  pickBlock(index) {
    this.broadcast('remote_command', { command: 'set_block', index });
  }
}
