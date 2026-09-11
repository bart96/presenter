import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppSelector, useAppDispatch } from '@/store';
import { selectCurrentSongOrder, useGetSongs } from '@/store/songsSlice';
import { broadcastContent, getOpenWindowsSync, invalidateSentContentCache, setWindowStyleResolver } from '@/utils/presentationBridge';
import { SONG_TRANSLATION_LINE_REGEX, inferSongLanguages, resolvePrimaryLanguage } from '@/song';
import type { ContentType, PresentationBlock, PresentationContent, PresentationLine } from '@/presentation/types';
import { DEFAULT_STYLE, mergeStyles, type ResolvedStyle, resolveStyleCascade, resolveStyleData } from '@/utils/styleUtils';
import { useGetStylesQuery } from '@/api/styles.api';
import { resolveMediaUrl } from '@/utils/mediaUrl';
import { useUpdateSetting, useGetSettings } from '@/store/settingsSlice';
import { useGetMusicianSettings } from '@/store/musicianSlice';
import { configIdForRuntimeId, upsertWindowConfig, useGetWindows, WindowConfig } from '@/store/windowSlice';
import { useGetPresentationSettings } from '@/store/presentationSlice';
import {
  setActiveItemIndex,
  setActiveBlockIndex,
  setActiveItemAndBlock,
  setBlack,
  toggleBlack,
  toggleTextHidden,
  toggleVideoVisible,
  setWsConnectedCount,
  setWsPeers,
  setWsMidiSyncAt,
  setWsOperatorConnected,
} from '@/store/presentationSlice';
import { isRemoteCommandAllowed, allowedRemoteCommands } from '@/utils/remoteCommands';
import { useGetShow } from '@/store/showSlice';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetSessionQuery } from '@/api/session.api';
import { useWsOperator, type WsOperatorIncomingSync } from '@/hooks/useWsOperator';
import { useAudioMixerHost } from '@/hooks/useAudioMixerHost';
import { resolveSyncIndex, showOrderSignature } from '@/utils/syncProtocol';

/**
 * Parse song block lines to extract language tags.
 * Lines like "[EN] Some text" are tagged with the language.
 * Lines without tags are considered universal (no language).
 */
const parseSongLines = (rawLines: string[]): PresentationLine[] => {
  return rawLines.map((line) => {
    const match = line.match(SONG_TRANSLATION_LINE_REGEX);
    if (match) {
      return {
        text: match[2],
        language: match[1].toUpperCase(),
      };
    }
    return { text: line };
  });
};

/**
 * Hook that watches Redux state and broadcasts presentation content
 * to all open presentation windows whenever relevant state changes.
 */
export const usePresentationSync = (): void => {
  const { LL } = useI18nContext();
  const dispatch = useAppDispatch();
  const {
    nextLinePreview,
    globalStyleId,
    transitionMode,
    transitionDuration,
    offlineMode,
    cachedStyles,
    showLicenseNumber,
    resetBlackOnSwitch,
    remoteControlCommands,
    hideTransitionMode,
    hideTransitionDuration,
    videoFadeDuration,
    operatorSyncAuthority,
    deviceId,
  } = useGetSettings();
  const { midiTrackingMaster } = useGetMusicianSettings();

  // Keep midiTrackingMaster in a ref so the WS callback always sees the latest value
  // without re-registering the callback (which would cause reconnects).
  const midiTrackingMasterRef = useRef(midiTrackingMaster);
  midiTrackingMasterRef.current = midiTrackingMaster;
  const { windowConfigs } = useGetWindows();
  const { currentShow } = useGetShow();
  const { songs } = useGetSongs();

  // Session — needed for the account number and WS host used in WS auth
  const { data: sessionData } = useGetSessionQuery(undefined, { skip: offlineMode });
  const wsAccount = useMemo(() => {
    const acc = sessionData?.account;
    return typeof acc === 'number' ? acc : null;
  }, [sessionData?.account]);

  // Derive wsUrl from global session ws_hosts (configured in config.php)
  const wsUrl = useMemo(() => {
    const h = sessionData?.settings?.wsHost;
    if (h?.host && h?.port) {
      const path = h.path && h.path !== '/' ? h.path : '';
      return `${h.wss ? 'wss' : 'ws'}://${h.host}:${h.port}${path}`;
    }
    return '';
  }, [sessionData?.settings?.wsHost]);

  /**
   * Is THIS app instance the one actually driving the show?
   *
   * Only a live operator broadcasts its position, answers `get_state` and acts on remote
   * commands. Everything else is a passive listener. Without the distinction every open
   * copy of the app — a second laptop, a phone left on the page — answered on the show's
   * behalf, and because those instances sit on whatever position they were opened at, the
   * last one to answer won: the projection snapped back to their item.
   *
   * `auto` reads it off the only fact that actually settles it: an instance with no
   * presentation window open is not presenting anything. `always`/`never` let the operator
   * override for setups the heuristic gets wrong.
   */
  const syncAuthorityRef = useRef(operatorSyncAuthority);
  syncAuthorityRef.current = operatorSyncAuthority;
  const isLiveOperator = useCallback(() => {
    const mode = syncAuthorityRef.current;
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return getOpenWindowsSync().some((w) => !w.closed);
  }, []);

  /** Fingerprint of the show we are holding — see `resolveSyncIndex`. */
  const showSigRef = useRef<string | undefined>(undefined);
  showSigRef.current = showOrderSignature(currentShow);
  /** Items of our show, for resolving a peer's index by song when the orders differ. */
  const showItemsRef = useRef<Array<{ type?: string; songNumber?: number }>>([]);
  showItemsRef.current = (currentShow?.order ?? []) as Array<{ type?: string; songNumber?: number }>;

  // Called when a musician broadcasts their position — only applied when
  // midiTrackingMaster === 'midi' (operator follows the MIDI musician).
  const handleMusicianSync = useCallback(
    (state: WsOperatorIncomingSync) => {
      if (midiTrackingMasterRef.current !== 'midi') return;
      const hasItem = typeof state.activeItemIndex === 'number';
      const hasBlock = typeof state.activeBlockIndex === 'number';

      // The protocol addresses items by index, so an index only means something between
      // two clients holding the same show order. When the show is edited mid-service the
      // peers that have not reloaded are one item off — following them lands on the wrong
      // song. Fall back to the song number they sent, and refuse rather than jump blind.
      const match = resolveSyncIndex({
        theirSig: state.showSig,
        ourSig: showSigRef.current,
        theirItemIndex: state.activeItemIndex,
        theirSongNumber: state.songNumber,
        ourItems: showItemsRef.current,
      });
      if (match.kind === 'stale') {
        // Silently dropping it would leave the footswitch looking broken, so tell the UI:
        // one side has to reload before indices mean the same thing again.
        window.dispatchEvent(
          new CustomEvent('presenter:sync-show-mismatch', {
            detail: { songTitle: state.songTitle, songNumber: state.songNumber, at: Date.now() },
          }),
        );
        return;
      }
      const itemIndex = match.kind === 'resolved' ? match.itemIndex : state.activeItemIndex;

      // Clamp against OUR order — the musician's show may be longer when this app missed a
      // reload; an out-of-range index would land the presentation on nothing at all.
      // (Block indices are intentionally not clamped: >= blocks.length means "copyright".)
      const clampItem = (idx: number) => Math.max(0, Math.min(idx, Math.max(0, remoteCtxRef.current.showItemCount - 1)));
      if (hasItem && hasBlock) {
        dispatch(setActiveItemAndBlock({ itemIndex: clampItem(itemIndex!), blockIndex: state.activeBlockIndex! }));
      } else if (hasItem) {
        dispatch(setActiveItemIndex(clampItem(itemIndex!)));
      } else if (hasBlock) {
        dispatch(setActiveBlockIndex(state.activeBlockIndex!));
      }
    },
    [dispatch],
  );

  // Counter incremented whenever a peer requests the current state — forces a re-broadcast
  // even if nothing in the presentation has changed.
  const [forceBroadcastCount, setForceBroadcastCount] = useState(0);
  const handleGetState = useCallback(() => {
    // Only the instance actually presenting answers. Every open copy of the app used to
    // reply to this, and a musician connecting or resyncing was enough to make the passive
    // ones publish their stale position — which then also became the relay's cached state
    // for the next client to connect.
    if (!isLiveOperator()) return;
    // Reset the dedup key so the next effect run always sends the current state.
    lastKeyRef.current = '';
    setForceBroadcastCount((c) => c + 1);
  }, [isLiveOperator]);

  // Listen for a custom DOM event dispatched by Footer (or other renderers) after
  // presentation windows are opened/restored, so they get content immediately.
  useEffect(() => {
    const handler = () => {
      lastKeyRef.current = '';
      setForceBroadcastCount((c) => c + 1);
    };
    window.addEventListener('presenter:force-broadcast', handler);
    return () => window.removeEventListener('presenter:force-broadcast', handler);
  }, []);

  // A presentation window (re)mounted its renderer. Main already replayed what it had,
  // but that snapshot predates this session's style/show state — re-broadcast from here
  // so the window gets content resolved through the current per-window style cascade.
  // Without this, windows restored on app start stay black until the operator navigates.
  useEffect(() => {
    const cleanup = window.api?.onPresentationWindowReady?.(({ id }) => {
      // The window we "already sent" this content to is a fresh renderer that never
      // received it — clear the dedupe snapshot or the re-broadcast below is a no-op.
      invalidateSentContentCache(id);
      lastKeyRef.current = '';
      setForceBroadcastCount((c) => c + 1);
    });
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  // ── Remote-control commands (mobile control page, relayed as 'remote_command') ──
  // Context ref is assigned further below once song/show/order are derived.
  const remoteCtxRef = useRef<{
    showItemCount: number;
    currentSong: { getBlocks: (order: string) => { name: string; copyright: boolean }[] } | undefined;
    orderName: string;
    resetBlackOnSwitch: boolean;
    /** Per-command permission map from settings — missing key = allowed */
    allowed: Record<string, boolean>;
    videoVisible: boolean;
    hideTransitionMode: 'cut' | 'fade';
    hideTransitionDuration: number;
    videoFadeDuration: number;
  }>({
    showItemCount: 0,
    currentSong: undefined,
    orderName: 'Default',
    resetBlackOnSwitch: false,
    allowed: {},
    videoVisible: true,
    hideTransitionMode: 'cut',
    hideTransitionDuration: 300,
    videoFadeDuration: 0,
  });

  const handleRemoteCommand = useCallback(
    (data: Record<string, unknown>) => {
      // A passive instance must not act on this. Acting flips its own black/item state,
      // which in turn fires the broadcast effect below — that is how a single footswitch
      // `toggle_black` used to end with two background instances publishing item 0 and the
      // live operator dutifully following them back to the first song.
      if (!isLiveOperator()) return;
      const command = typeof data.command === 'string' ? data.command : '';
      const nav = navStateRef.current;
      const ctx = remoteCtxRef.current;
      // Permission gate — set_item/set_block (agenda/order jumps) are allowed when
      // item/block navigation is permitted in either direction.
      if (command === 'set_item') {
        if (!isRemoteCommandAllowed(ctx.allowed, 'next_item') && !isRemoteCommandAllowed(ctx.allowed, 'prev_item')) return;
      } else if (command === 'set_block') {
        if (!isRemoteCommandAllowed(ctx.allowed, 'next_block') && !isRemoteCommandAllowed(ctx.allowed, 'prev_block')) return;
      } else if (!isRemoteCommandAllowed(ctx.allowed, command)) {
        return;
      }
      switch (command) {
        case 'prev_item':
          if (nav.activeItemIndex > 0) {
            dispatch(setActiveItemIndex(nav.activeItemIndex - 1));
            if (ctx.resetBlackOnSwitch) dispatch(setBlack(false));
          }
          break;
        case 'next_item':
          if (nav.activeItemIndex < ctx.showItemCount - 1) {
            dispatch(setActiveItemIndex(nav.activeItemIndex + 1));
            if (ctx.resetBlackOnSwitch) dispatch(setBlack(false));
          }
          break;
        case 'set_item': {
          const idx = typeof data.index === 'number' ? Math.floor(data.index) : null;
          if (idx != null) {
            dispatch(setActiveItemIndex(Math.max(0, Math.min(idx, Math.max(0, ctx.showItemCount - 1)))));
            if (ctx.resetBlackOnSwitch) dispatch(setBlack(false));
          }
          break;
        }
        case 'prev_block':
          if (nav.activeBlockIndex > 0) {
            dispatch(setActiveBlockIndex(nav.activeBlockIndex - 1));
          }
          break;
        case 'next_block': {
          if (!ctx.currentSong) break;
          const allBlocks = ctx.currentSong.getBlocks(ctx.orderName);
          if (nav.activeBlockIndex < allBlocks.length - 1) {
            dispatch(setActiveBlockIndex(nav.activeBlockIndex + 1));
          }
          break;
        }
        case 'set_block': {
          const idx = typeof data.index === 'number' ? Math.floor(data.index) : null;
          if (idx != null && ctx.currentSong) {
            const max = Math.max(0, ctx.currentSong.getBlocks(ctx.orderName).length - 1);
            dispatch(setActiveBlockIndex(Math.max(0, Math.min(idx, max))));
          }
          break;
        }
        case 'toggle_black':
          dispatch(toggleBlack());
          break;
        case 'toggle_text':
          dispatch(toggleTextHidden());
          break;
        case 'toggle_video':
          // Mirrors the keyboard action — Electron only (window.api), like useKeyboardNavigation
          if (window.api?.setVideoVisible) {
            const nextVisible = !ctx.videoVisible;
            dispatch(toggleVideoVisible());
            window.api.setVideoVisible({
              value: nextVisible,
              mode: ctx.hideTransitionMode,
              durationMs: ctx.hideTransitionDuration,
            });
          }
          break;
        case 'toggle_video_playback':
          if (window.api?.videoCommand) {
            window.api.videoCommand({ action: 'toggle', fadeDuration: ctx.videoFadeDuration });
          }
          break;
      }
    },
    [dispatch, isLiveOperator],
  );

  /**
   * Monitor mixing rides this same relay socket, which has not been opened yet — so the
   * host is handed a stable sender that reads the real one out of a ref once it exists.
   * A second socket would have been simpler and would also have made the operator show up
   * twice in its own connected-clients breakdown.
   */
  const wsBroadcastRef = useRef<(action: string, data?: Record<string, unknown>, to?: string | string[]) => void>(() => {});
  const sendRelay = useCallback(
    (action: string, data?: Record<string, unknown>, to?: string | string[]) => wsBroadcastRef.current(action, data, to),
    [],
  );
  const { handleRelayMessage: handleAudioRelayMessage } = useAudioMixerHost({ send: sendRelay });

  // Operator WebSocket connection to the relay server
  const {
    broadcast: wsBroadcast,
    connected: wsOperatorConnected,
    connectedCount,
    peers: wsPeers,
    lastMidiSyncAt,
    lastPeersDisconnected,
  } = useWsOperator(
    wsUrl,
    wsAccount,
    handleMusicianSync,
    handleGetState,
    handleRemoteCommand,
    midiTrackingMaster === 'midi',
    handleAudioRelayMessage,
  );
  wsBroadcastRef.current = wsBroadcast;

  // Relay confirmed a disconnect-peers request — hand the count back to the Footer, which
  // is waiting on it to tell "cleared N clients" from "the relay never answered".
  useEffect(() => {
    if (!lastPeersDisconnected) return;
    window.dispatchEvent(new CustomEvent('presenter:ws-peers-disconnected', { detail: lastPeersDisconnected }));
  }, [lastPeersDisconnected]);

  // Footer asks the relay to drop every other client of this account (stale tablets,
  // reloaded pages, phones that went to sleep). Routed through a DOM event — the same
  // indirection `presenter:force-broadcast` uses — so the Footer doesn't own the socket.
  useEffect(() => {
    const handler = () => wsBroadcast('disconnect_peers');
    window.addEventListener('presenter:disconnect-ws-peers', handler);
    return () => window.removeEventListener('presenter:disconnect-ws-peers', handler);
  }, [wsBroadcast]);

  // Also listen for direct Electron IPC musician sync (bypasses WS relay, works offline / same machine)
  useEffect(() => {
    const cleanup = window.api?.onMusicianSyncFromIpc?.((raw) => {
      const msg = raw as { action?: string; data?: WsOperatorIncomingSync };
      if (msg?.action === 'musician_sync' && msg.data) {
        dispatch(setWsMidiSyncAt(Date.now()));
        handleMusicianSync(msg.data);
      }
    });
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
    // handleMusicianSync is stable (useCallback with [dispatch])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep Redux in sync with the WS peer count, connection state and last midi-sync timestamp.
  useEffect(() => {
    dispatch(setWsConnectedCount(Math.max(0, connectedCount)));
  }, [connectedCount, dispatch]);

  useEffect(() => {
    dispatch(setWsPeers(wsPeers));
  }, [wsPeers, dispatch]);

  useEffect(() => {
    dispatch(setWsOperatorConnected(wsOperatorConnected));
  }, [wsOperatorConnected, dispatch]);

  useEffect(() => {
    if (lastMidiSyncAt > 0) dispatch(setWsMidiSyncAt(lastMidiSyncAt));
  }, [lastMidiSyncAt, dispatch]);

  const { activeItemIndex, activeBlockIndex, activeLineIndex, isBlack, isTextHidden, videoVisible } = useGetPresentationSettings();
  const updateSetting = useUpdateSetting();

  // Fetch all styles for cascade resolution
  const { data: fetchedStyles } = useGetStylesQuery(undefined, { skip: offlineMode });
  const allStyles = offlineMode ? (cachedStyles as typeof fetchedStyles) : fetchedStyles;

  // Cache styles to localStorage whenever we get a fresh fetch
  useEffect(() => {
    if (!offlineMode && fetchedStyles && fetchedStyles.length > 0) {
      updateSetting('cachedStyles', fetchedStyles as unknown as object[]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedStyles, offlineMode]);

  // A signature of per-window styleIds — when a user assigns a preset to a
  // window we must re-broadcast even though the global state is unchanged.
  const windowStylesSig = useMemo(
    () =>
      (windowConfigs as Array<{ name?: string; styleId?: number }> | undefined)
        ?.map((c) => `${c.name ?? ''}:${c.styleId ?? ''}`)
        .join('|') ?? '',
    [windowConfigs],
  );

  // Get the active show item
  const activeItem = currentShow?.order?.[activeItemIndex];

  // Resolve the song's active order
  const currentSongNumber = activeItem?.type === 'song' ? activeItem.songNumber : undefined;
  const currentSong = currentSongNumber != null ? songs[currentSongNumber] : undefined;
  const orderName = useAppSelector((state) => (currentSongNumber != null ? selectCurrentSongOrder(state, currentSongNumber) : 'Default'));

  // Agenda for the mobile control page — one entry per show item, labels resolved
  // the same way the sidebar does. Sent inside musician_sync so the phone can render
  // an expandable agenda and jump to any item via `set_item`.
  const agenda = useMemo(
    () =>
      (currentShow?.order ?? []).map((item) => ({
        type: item.type,
        label:
          item.type === 'song'
            ? item.songNumber != null
              ? (songs[item.songNumber]?.title ?? `#${item.songNumber}`)
              : 'Song'
            : item.type === 'bible_verse'
              ? item.bibleRef || item.label || 'Bible'
              : item.label || item.mediaSubType || 'Media',
      })),
    [currentShow?.order, songs],
  );

  // Stable signature of the allowed remote-command list — changing a permission in
  // Settings must immediately rebroadcast the list (otherwise the phone only updates
  // on the next navigation, which reads as tiles briefly showing then disappearing).
  const remoteCommandsSig = useMemo(() => allowedRemoteCommands(remoteControlCommands).join(','), [remoteControlCommands]);

  // Keep the remote-command context current (declared above the WS hook, filled here)
  remoteCtxRef.current = {
    showItemCount: currentShow?.order?.length ?? 0,
    currentSong,
    orderName,
    resetBlackOnSwitch,
    allowed: remoteControlCommands,
    videoVisible,
    hideTransitionMode,
    hideTransitionDuration,
    videoFadeDuration,
  };

  // Use a ref to avoid sending duplicate content — compare key fields only
  const lastKeyRef = useRef('');
  // Throttle/coalesce broadcast scheduling — see broadcast effect below.
  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBroadcastAtRef = useRef(0);
  // Mirror the navigation indices so the deferred flush always sends the
  // newest values (otherwise a fast-repeating key would re-schedule the
  // timer with a stale closure). Updated synchronously below.
  const navStateRef = useRef({ activeItemIndex, activeBlockIndex, activeLineIndex, isBlack, isTextHidden, videoVisible });
  navStateRef.current = { activeItemIndex, activeBlockIndex, activeLineIndex, isBlack, isTextHidden, videoVisible };

  // ── Memoize expensive computations ──
  // These only recompute when content changes (song/show/styles), NOT on every index change.
  const { contentType, blocks, style, title, copyright, authors, licenseNumber, songLanguages } = useMemo(() => {
    let contentType: ContentType = 'empty';
    let blocks: PresentationBlock[] = [];
    let title: string | undefined;
    let copyright: string | undefined;
    let authors: string | undefined;
    let songLanguages: string[] | undefined;

    if (activeItem) {
      switch (activeItem.type) {
        case 'song': {
          contentType = 'song';
          if (currentSong) {
            title = currentSong.title;
            authors = currentSong.authors;
            copyright = currentSong.copyright;

            const songBlocks = currentSong.getBlocks(orderName);
            // The song's languages, in its own order — slot 1, slot 2, slot 3 for any style
            // that wants to describe them positionally. The anchor is resolved from the song's
            // own content rather than trusting the declared list alone, so a song whose list has
            // drifted from its lyrics still groups its translations correctly, and the resolved
            // anchor is put first so slot 1 always means what it says.
            const declared = currentSong.languages ?? [];
            const allLines = songBlocks.flatMap((b) => b.lines ?? []);
            const anchor = resolvePrimaryLanguage(allLines, declared[0]);
            // A song that has not recorded its languages yet still has them written into its
            // lyrics. Without this fallback every translation resolves to no slot at all, and a
            // style's per-language typography silently does nothing.
            songLanguages = declared.length
              ? anchor
                ? [anchor, ...declared.filter((code) => code.toUpperCase() !== anchor.toUpperCase())]
                : declared
              : inferSongLanguages(allLines);
            blocks = songBlocks
              .filter((b) => !b.copyright)
              .map((b) => ({
                name: b.name,
                lines: parseSongLines(b.lines || []),
              }));
          }
          break;
        }

        case 'bible_verse': {
          contentType = 'bible_verse';
          const verseText = activeItem.label || activeItem.bibleRef || '';
          blocks = [
            {
              name: activeItem.bibleRef || 'Bible Verse',
              lines: verseText.split('\n').map((text) => {
                const segments = activeItem.bibleFormattedSegments || [];
                const lineStart = verseText.indexOf(text);
                const lineEnd = lineStart + text.length;
                const isBold = segments.some((s) => s.bold && s.start <= lineEnd && s.end >= lineStart);
                return { text, bold: isBold };
              }),
            },
          ];
          break;
        }

        case 'media': {
          contentType = 'media';
          break;
        }
      }
    }

    // Resolve the three-level style cascade (Global → Show → Item)
    const styles = allStyles ?? [];
    const globalStyle = globalStyleId ? styles.find((s) => s.id === globalStyleId && s.enabled) : undefined;
    const showStyle = currentShow?.styleId ? styles.find((s) => s.id === currentShow.styleId && s.enabled) : undefined;
    const itemStyle = activeItem?.styleId ? styles.find((s) => s.id === activeItem.styleId && s.enabled) : undefined;
    const resolvedCascade = resolveStyleCascade(globalStyle, showStyle, itemStyle, undefined, styles);
    const rawStyle: ResolvedStyle = mergeStyles(DEFAULT_STYLE, resolvedCascade);

    // Resolve relative media paths so presentation windows can load them
    const style: ResolvedStyle = {
      ...rawStyle,
      backgroundImage: resolveMediaUrl(rawStyle.backgroundImage),
      backgroundVideo: resolveMediaUrl(rawStyle.backgroundVideo),
    };

    const licenseNumber = currentSong ? (currentSong.account ?? undefined) : undefined;
    return { contentType, blocks, style, title, copyright, authors, licenseNumber, songLanguages };
  }, [currentSong, activeItem, orderName, allStyles, globalStyleId, currentShow?.styleId]);

  // Keep frequently-changing object refs accessible inside the broadcast effect
  // WITHOUT making them part of its dependency array (would otherwise cause the
  // heavy effect — and IPC broadcast — to fire on every parent re-render).
  const broadcastRef = useRef({
    contentType,
    blocks,
    style,
    title,
    copyright,
    authors,
    licenseNumber,
    songLanguages,
    activeItem,
    currentShow,
    currentSongNumber,
    orderName,
    nextLinePreview,
    transitionMode,
    transitionDuration,
    agenda,
  });
  broadcastRef.current = {
    contentType,
    blocks,
    style,
    title,
    copyright,
    authors,
    licenseNumber,
    songLanguages,
    activeItem,
    currentShow,
    currentSongNumber,
    orderName,
    nextLinePreview,
    transitionMode,
    transitionDuration,
    agenda,
  };

  // A cheap content-identity hash (changes only when actual style values change).
  const styleHash = useMemo(() => {
    try {
      return JSON.stringify(style);
    } catch {
      return '';
    }
  }, [style]);

  useEffect(() => {
    const b = broadcastRef.current;
    if (!b.currentShow) return;

    // Throttled flush: when keys auto-repeat we get a Redux dispatch (and
    // thus this effect) per keypress. Previously we cancelled-and-rescheduled
    // a rAF on every keypress which meant the broadcast (and the
    // wsBroadcast → musician_sync) only fired once the user RELEASED the key.
    // Now we always send immediately if the throttle window has elapsed, and
    // otherwise schedule a single trailing flush — guaranteeing the latest
    // navigation state is delivered while still coalescing bursts.
    const MIN_INTERVAL_MS = 16; // ~60fps; identical broadcasts are deduped per-window

    const flush = () => {
      broadcastTimerRef.current = null;
      lastBroadcastAtRef.current = Date.now();

      // Read the LATEST navigation state from refs — not the closure values,
      // which may be stale by the time the trailing flush runs.
      const nav = navStateRef.current;
      const cb = broadcastRef.current;

      // Compute next-block preview lines — style.nextLinePreview overrides global setting
      const showNextLinePreview = cb.style.nextLinePreview !== undefined ? cb.style.nextLinePreview : cb.nextLinePreview;
      let nextBlockPreviewLines: PresentationLine[] | undefined;
      if (showNextLinePreview && cb.blocks.length > 0 && cb.contentType === 'song') {
        const nextBlockIndex = nav.activeBlockIndex + 1;
        if (nextBlockIndex < cb.blocks.length) {
          const nb = cb.blocks[nextBlockIndex];
          if (nb && nb.lines.length > 0) {
            // Send only the first semantic group: first primary line + any immediately
            // following translation lines (lines with a language tag).
            const primary = cb.songLanguages?.[0]?.toUpperCase();
            const isAnchor = (line: PresentationLine) => !line.language || (!!primary && line.language.toUpperCase() === primary);
            const group: PresentationLine[] = [];
            for (const line of nb.lines) {
              if (isAnchor(line) && group.length > 0) break; // stop at the second anchor line
              group.push(line);
            }
            nextBlockPreviewLines = group;
          }
        }
      }

      const content: PresentationContent = {
        contentType: cb.contentType,
        displayMode: 'normal',
        activeBlockIndex: nav.activeBlockIndex,
        activeLineIndex: nav.activeLineIndex,
        blocks: cb.blocks,
        songLanguages: cb.songLanguages,
        style: cb.style,
        isBlack: nav.isBlack,
        hideText: nav.isTextHidden,
        title: cb.title,
        songNumber: cb.currentSongNumber,
        copyright: cb.copyright,
        authors: cb.authors,
        showLicenseNumber: showLicenseNumber,
        license: cb.licenseNumber ? `${LL.AUTH.LICENSE()}: #${cb.licenseNumber}` : undefined,
        showCopyright:
          cb.contentType === 'song' && (!!cb.copyright || !!cb.authors || !!cb.title) && nav.activeBlockIndex >= cb.blocks.length,
        mediaSubType: cb.activeItem?.mediaSubType,
        mediaPath: resolveMediaUrl(cb.activeItem?.mediaPath),
        mediaColor: cb.activeItem?.mediaColor,
        mediaObjectFit: cb.activeItem?.mediaObjectFit,
        mediaObjectPosition: cb.activeItem?.mediaObjectPosition,
        mediaZoom: cb.activeItem?.mediaZoom,
        mediaBlur: cb.activeItem?.mediaBlur,
        mediaAutoplay: cb.activeItem?.mediaAutoplay,
        mediaLoop: cb.activeItem?.mediaLoop,
        bibleRef: cb.activeItem?.bibleRef,
        bibleTranslation: cb.activeItem?.bibleTranslation,
        nextBlockPreviewLines,
        transitionMode: cb.transitionMode,
        transitionDuration: cb.transitionDuration,
      };

      broadcastContent(content);

      // Broadcast musician_sync via WebSocket relay server
      // Include the current block's name and text lines so viewer clients
      // (viewer/index.php) can display the lyrics without an extra API call.
      const activeBlock = cb.blocks[nav.activeBlockIndex];

      // A display title for the ACTIVE item, always a string so the control page's
      // partial-state merge overwrites a previous song title when a media/bible item
      // becomes active (songTitle alone is undefined for non-songs and would persist).
      const itemTitle =
        cb.contentType === 'song'
          ? (cb.title ?? '')
          : cb.contentType === 'bible_verse'
            ? cb.activeItem?.bibleRef || cb.activeItem?.label || 'Bible'
            : cb.contentType === 'media'
              ? cb.activeItem?.label ||
                (cb.activeItem?.mediaSubType === 'color'
                  ? 'Color'
                  : cb.activeItem?.mediaSubType === 'video'
                    ? 'Video'
                    : cb.activeItem?.mediaSubType === 'image'
                      ? 'Image'
                      : 'Media')
              : '';

      // Passive instances stay quiet. Their state is not wrong for them — it is simply not
      // the show anyone is watching, and publishing it overwrites the relay's cached state
      // that every newly connecting client is handed.
      if (!isLiveOperator()) return;

      wsBroadcast('musician_sync', {
        // Who and which show — see `@/utils/syncProtocol`. Receivers use these to ignore a
        // peer that is not driving, and to tell a genuine index apart from one that means
        // a different item because the show was edited.
        senderRole: 'operator' as const,
        senderId: deviceId,
        showSig: showSigRef.current,
        activeItemIndex: nav.activeItemIndex,
        activeBlockIndex: nav.activeBlockIndex,
        activeLineIndex: nav.activeLineIndex,
        isBlack: nav.isBlack,
        isTextHidden: nav.isTextHidden,
        videoVisible: nav.videoVisible,
        songNumber: cb.currentSongNumber,
        songTitle: cb.title,
        showTitle: cb.currentShow?.title,
        orderName: cb.orderName,
        contentType: cb.contentType,
        blockName: activeBlock?.name,
        blockLines: activeBlock?.lines,
        // Extras for the mobile control page (/control):
        // - itemTitle: display title of the active item (song/media/bible)
        // - mediaSubType: so the phone can pick an icon for media items
        // - agenda: all show items (label+type) for the expandable agenda + set_item
        // - blockNames: current song's block names for the expandable order + set_block
        itemTitle,
        mediaSubType: cb.activeItem?.mediaSubType,
        agenda: cb.agenda,
        blockNames: cb.blocks.map((bl) => bl.name),
        // Which commands remote-control clients (/control) may trigger — they
        // hide/disable tiles for anything not listed here.
        remoteCommands: allowedRemoteCommands(remoteCtxRef.current.allowed),
      });
    };

    // Deduplicate scheduling using a lightweight key (includes styleHash so style
    // edits actually re-broadcast and apply immediately).
    const ai = b.activeItem;
    const contentKey = `${b.contentType}|${activeItemIndex}|${activeBlockIndex}|${activeLineIndex}|${isBlack}|${isTextHidden}|${videoVisible}|${b.blocks.length}|${b.nextLinePreview}|${ai?.mediaPath}|${ai?.mediaColor}|${ai?.mediaObjectFit}|${ai?.mediaObjectPosition}|${ai?.mediaZoom}|${ai?.mediaBlur}|${ai?.mediaAutoplay}|${ai?.mediaLoop}|${styleHash}|${windowStylesSig}|${remoteCommandsSig}|${b.agenda.map((a) => a.label).join('~')}`;
    if (contentKey === lastKeyRef.current) return;
    lastKeyRef.current = contentKey;

    const elapsed = Date.now() - lastBroadcastAtRef.current;
    if (elapsed >= MIN_INTERVAL_MS && broadcastTimerRef.current === null) {
      // Leading edge — fire immediately for snappy feedback.
      flush();
    } else if (broadcastTimerRef.current === null) {
      // Schedule a trailing flush; do NOT cancel an existing one (it will pick
      // up the latest state from refs when it fires).
      broadcastTimerRef.current = setTimeout(flush, Math.max(0, MIN_INTERVAL_MS - elapsed));
    }
  }, [
    activeItemIndex,
    activeBlockIndex,
    activeLineIndex,
    isBlack,
    isTextHidden,
    videoVisible,
    styleHash,
    // The following primitives change rarely but should still trigger a re-broadcast:
    contentType,
    blocks.length,
    nextLinePreview,
    windowStylesSig,
    // Media-item display props (zoom/blur/fit/position/autoplay/loop/path/color)
    // — the user can edit these on the active item and we need to re-broadcast.
    activeItem?.mediaPath,
    activeItem?.mediaColor,
    activeItem?.mediaObjectFit,
    activeItem?.mediaObjectPosition,
    activeItem?.mediaZoom,
    activeItem?.mediaBlur,
    activeItem?.mediaAutoplay,
    activeItem?.mediaLoop,
    forceBroadcastCount,
    // Remote-control permission changes must rebroadcast the allowed list immediately.
    remoteCommandsSig,
    // Agenda label/order changes (e.g. song titles loading in) rebroadcast the agenda.
    agenda,
    // Peer requested current state — force a re-broadcast even if nothing changed.
    wsBroadcast,
    // Whether this instance may publish at all, and the id it publishes under.
    isLiveOperator,
    deviceId,
  ]);

  // ── Register a per-window style resolver so windows with a configured
  //    preset (styleId) — and active items with per-window overrides — get
  //    their style merged on top of the cascade. ──
  const activeItemRef = useRef(activeItem);
  activeItemRef.current = activeItem;

  useEffect(() => {
    setWindowStyleResolver((_id, config: WindowConfig) => {
      if (!allStyles) return undefined;
      let merged: ResolvedStyle | undefined;
      const wname = config.name;

      // Helper: resolve a style id and merge it into `merged` (creating it if undefined).
      const applyStyleId = (sid: number | undefined | null) => {
        if (!sid) return;
        const s = allStyles.find((x) => x.id === sid);
        if (!s || !s.enabled) return;
        const resolved = resolveStyleData(s.data);
        merged = mergeStyles(merged ?? {}, {
          ...resolved,
          backgroundImage: resolveMediaUrl(resolved.backgroundImage),
          backgroundVideo: resolveMediaUrl(resolved.backgroundVideo),
        });
      };

      // Helper: if the given style has a per-window-name override matching `wname`,
      // resolve and merge that override style. This implements the "window override"
      // layer of the cascade for the General / Show / Item levels.
      const applyWindowOverride = (style: { windowOverrides?: { window_name: string; override_style_id: number }[] } | undefined) => {
        if (!style?.windowOverrides || !wname) return;
        const wo = style.windowOverrides.find((w) => w.window_name === wname);
        if (wo) applyStyleId(wo.override_style_id);
      };

      // Re-walk the General → Show → Item cascade, applying each level's per-window override.
      const item = activeItemRef.current;
      const globalStyleEntity = globalStyleId ? allStyles.find((x) => x.id === globalStyleId) : undefined;
      const showStyleEntity = currentShow?.styleId ? allStyles.find((x) => x.id === currentShow.styleId) : undefined;
      const itemStyleEntity = item?.styleId ? allStyles.find((x) => x.id === item.styleId) : undefined;
      applyWindowOverride(globalStyleEntity);
      applyWindowOverride(showStyleEntity);
      applyWindowOverride(itemStyleEntity);

      // Window-level preset (configured on the BrowserWindow itself)
      applyStyleId(config.styleId);

      // Per-item per-window override (highest priority)
      if (item?.itemStyleByWindow && wname && item.itemStyleByWindow[wname] != null) {
        applyStyleId(item.itemStyleByWindow[wname]);
      }
      return merged;
    });
    return () => setWindowStyleResolver(undefined);
  }, [allStyles, globalStyleId, currentShow?.styleId, windowStylesSig]);

  // ── Presentation window bounds change listener (Electron only) ──
  // Updates windowConfigs in Redux/localStorage when user moves/resizes a presentation window.
  const savedWindowConfigsRef = useRef(windowConfigs);
  savedWindowConfigsRef.current = windowConfigs;

  useEffect(() => {
    if (!window.api?.onPresentationWindowBoundsChanged) return;

    const cleanup = window.api.onPresentationWindowBoundsChanged(({ id, bounds }) => {
      // `id` is the runtime handle; the config is keyed by its own stable id.
      const configId = configIdForRuntimeId(savedWindowConfigsRef.current, id);
      if (!configId) return;
      dispatch(upsertWindowConfig({ id: configId, positionX: bounds.x, positionY: bounds.y, width: bounds.width, height: bounds.height }));
    });
    return cleanup || undefined;
  }, [dispatch]);
};
