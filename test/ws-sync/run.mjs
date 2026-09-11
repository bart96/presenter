/**
 * WebSocket sync integration test.
 *
 * Boots the real relay (ws-server/src/server.ts) and drives a full service's worth of
 * clients against it — an operator in MIDI-follow mode, musicians in each sync mode,
 * text viewers and a mobile remote — asserting what each one ends up displaying.
 *
 *   node test/ws-sync/run.mjs            # run everything
 *   node test/ws-sync/run.mjs --verbose  # also stream the relay's own log
 *   node test/ws-sync/run.mjs 3 7        # run only scenarios 3 and 7
 *
 * Scenarios share one relay and are isolated by account number, so a leaked client or a
 * stale cache in one cannot reach another. The TTL scenario gets its own relay because
 * the expiry window is process-wide configuration.
 *
 * See README.md in this directory for what the client models do and do not cover.
 */
import { startRelay, quiesce, waitFor, sleep, Reporter } from './harness.mjs';
import { OperatorClient, MusicianClient, ViewerClient, RemoteClient, makeShow, WS_CLOSE_OPERATOR_DISCONNECT } from './clients.mjs';

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const only = argv.filter((a) => /^\d+$/.test(a)).map(Number);

const report = new Reporter();

/** Frames a viewer painted since `mark` (see ViewerClient.renders). */
const since = (viewer, mark) => viewer.renders.slice(mark);

/** A frame is "blank" when the viewer is showing no lyrics and no song title. */
const isBlankFrame = (f) => f.lines.length === 0 && !f.song;

const describeFrame = (f) =>
  `{black:${f.black}, song:${JSON.stringify(f.song)}, block:${JSON.stringify(f.block)}, lines:${f.lines.length}}`;

// ── Scenarios ───────────────────────────────────────────────────────────────

const scenarios = [];
const scenario = (name, description, fn) => scenarios.push({ name, description, fn });

// 1 ─────────────────────────────────────────────────────────────────────────
scenario(
  'Fan-out from the operator',
  'One operator, two musicians, two viewers and a phone all land on the same position.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const midiMusician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    const followMusician = await new MusicianClient({ url, account, show, syncMode: 'operator', musicianName: 'Ben' }).connect();
    const viewerA = await new ViewerClient({ url, account, name: 'viewer-A' }).connect();
    const viewerB = await new ViewerClient({ url, account, name: 'viewer-B' }).connect();
    const remote = await new RemoteClient({ url, account }).connect();
    const clients = [operator, midiMusician, followMusician, viewerA, viewerB, remote];
    await quiesce(clients);

    report.note(
      `operator sees ${operator.peerCount} peers: ${operator.peers.map((p) => p.role + (p.mode ? `/${p.mode}` : '')).join(', ')}`,
    );

    report.equal('operator counts 5 peers', operator.peerCount, 5);
    report.check(
      'peer breakdown names both musicians with their sync modes',
      operator.peers.filter((p) => p.role === 'musician' && p.mode === 'midi' && p.name === 'Anna').length === 1 &&
        operator.peers.filter((p) => p.role === 'musician' && p.mode === 'operator' && p.name === 'Ben').length === 1,
      JSON.stringify(operator.peers),
    );
    report.check(
      'viewer and remote roles are reported',
      operator.peers.filter((p) => p.role === 'viewer').length === 2 && operator.peers.some((p) => p.role === 'remote'),
      JSON.stringify(operator.peers),
    );

    operator.setActiveBlockIndex(1); // Chorus of song 101
    await quiesce(clients);

    report.note(`viewer-A screen: ${describeFrame(viewerA.screen)}`);
    report.equal(
      'viewer-A shows the chorus',
      [viewerA.screen.song, viewerA.screen.block, viewerA.screen.lines],
      ['Großer Gott, wir loben Dich', 'Chorus', ['[101 chorus line 1]']],
    );
    report.equal('viewer-B shows the same', [viewerB.screen.song, viewerB.screen.block], [viewerA.screen.song, viewerA.screen.block]);
    report.equal(
      'remote tracks title and block index',
      [remote.sync.itemTitle, remote.sync.activeBlockIndex],
      ['Großer Gott, wir loben Dich', 1],
    );
    report.equal(
      'operator-mode musician mirrors item+block',
      [followMusician.operatorItemIndex, followMusician.operatorBlockIndex],
      [0, 1],
    );
    report.equal('MIDI musician mirrors the operator too', [midiMusician.operatorItemIndex, midiMusician.operatorBlockIndex], [0, 1]);

    await Promise.all(clients.map((c) => c.close()));
  },
);

// 2 ─────────────────────────────────────────────────────────────────────────
scenario(
  'Musician takes over via MIDI',
  'A MIDI musician drives navigation; the following operator adopts it and everyone else follows.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const midiMusician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    const viewer = await new ViewerClient({ url, account }).connect();
    const remote = await new RemoteClient({ url, account }).connect();
    const clients = [operator, midiMusician, viewer, remote];
    await quiesce(clients);

    midiMusician.midiNextBlock(); // → block 1
    await quiesce(clients);
    midiMusician.midiNextBlock(); // → block 2
    await quiesce(clients);

    report.note(`operator now at item ${operator.state.activeItemIndex} block ${operator.state.activeBlockIndex}`);
    report.equal('operator followed the musician to block 2', operator.state.activeBlockIndex, 2);
    report.equal('viewer shows Verse 2', [viewer.screen.block, viewer.screen.lines], ['Verse 2', ['[101 v2 line 1]']]);
    report.equal('remote block index agrees', remote.sync.activeBlockIndex, 2);

    midiMusician.midiNextItem(); // → media item (index 1)
    await quiesce(clients);
    report.equal('operator followed to the media item', operator.state.activeItemIndex, 1);
    report.equal('viewer clears the lyrics for a media item', [viewer.screen.song, viewer.screen.lines.length], ['', 0]);
    report.equal('remote shows the media item title', remote.sync.itemTitle, 'Ankündigungen');

    midiMusician.midiNextItem(); // → song 202
    await quiesce(clients);
    report.equal('operator followed to song 202', operator.state.activeItemIndex, 2);
    report.equal('viewer shows song 202 verse 1', [viewer.screen.song, viewer.screen.block], ['Der Herr ist mein Hirte', 'Verse 1']);

    await Promise.all(clients.map((c) => c.close()));
  },
);

// 3 ─────────────────────────────────────────────────────────────────────────
scenario(
  'Black holds while a MIDI musician navigates',
  'The reported failure: fading to black, then a musician stepping a block, must not blank the viewers.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const midiMusician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    const viewer = await new ViewerClient({ url, account }).connect();
    const remote = await new RemoteClient({ url, account }).connect();
    const clients = [operator, midiMusician, viewer, remote];
    await quiesce(clients);

    operator.setActiveBlockIndex(1);
    await quiesce(clients);
    operator.toggleBlack();
    await quiesce(clients);

    report.equal('viewer is black with the chorus behind it', [viewer.screen.black, viewer.screen.block], [true, 'Chorus']);

    const mark = viewer.renders.length;
    midiMusician.midiNextBlock(); // musician moves while output is black
    await quiesce(clients);

    const frames = since(viewer, mark);
    report.note(`viewer painted ${frames.length} frame(s): ${frames.map(describeFrame).join(' → ')}`);

    const unblacked = frames.filter((f) => !f.black);
    report.check(
      'no frame drops the black overlay',
      unblacked.length === 0,
      `${unblacked.length} frame(s) rendered with black off: ${unblacked.map(describeFrame).join(', ')}`,
    );
    const blanked = frames.filter(isBlankFrame);
    report.check(
      'no frame blanks song and lyrics',
      blanked.length === 0,
      `${blanked.length} blank frame(s): ${blanked.map(describeFrame).join(', ')}`,
    );
    report.equal('viewer settles on black + Verse 2', [viewer.screen.black, viewer.screen.block], [true, 'Verse 2']);
    report.equal('remote keeps the black state', remote.sync.isBlack, true);

    await Promise.all(clients.map((c) => c.close()));
  },
);

// 4 ─────────────────────────────────────────────────────────────────────────
scenario(
  'Musician re-selects the block already showing',
  'The operator has nothing to change, so it sends no repair broadcast — whatever the musician did to the viewers sticks.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const midiMusician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    const viewer = await new ViewerClient({ url, account }).connect();
    const clients = [operator, midiMusician, viewer];
    await quiesce(clients);

    operator.setActiveBlockIndex(1);
    await quiesce(clients);
    operator.toggleBlack();
    await quiesce(clients);

    const broadcastsBefore = operator.broadcasts.length;
    const mark = viewer.renders.length;
    midiMusician.tapBlock(1); // tap the block that is already active
    await quiesce(clients);

    report.note(`operator re-broadcast ${operator.broadcasts.length - broadcastsBefore} time(s) after the tap`);
    report.note(`viewer screen: ${describeFrame(viewer.screen)}`);

    const frames = since(viewer, mark);
    report.check(
      'no frame drops the black overlay',
      frames.every((f) => f.black),
      frames.map(describeFrame).join(', '),
    );
    report.equal(
      'viewer still shows the chorus',
      [viewer.screen.song, viewer.screen.block, viewer.screen.lines],
      ['Großer Gott, wir loben Dich', 'Chorus', ['[101 chorus line 1]']],
    );
    report.equal('viewer is still black', viewer.screen.black, true);

    await Promise.all(clients.map((c) => c.close()));
  },
);

// 5 ─────────────────────────────────────────────────────────────────────────
scenario(
  'Viewer joining after a musician broadcast',
  'The relay replays whatever it cached last. A late viewer must still see the song, not an empty screen.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'off' }).connect();
    const midiMusician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    const clients = [operator, midiMusician];
    await quiesce(clients);

    operator.setActiveBlockIndex(1);
    await quiesce(clients);
    midiMusician.midiNextBlock(); // last thing on the wire is the musician's partial payload
    await quiesce(clients);

    const lateViewer = await new ViewerClient({ url, account, name: 'late-viewer' }).connect();
    await quiesce([...clients, lateViewer]);

    // This one asserts against the relay's own output rather than the viewer port, so it
    // stands on its own if the viewer's guard is ever changed or removed.
    const replays = lateViewer.received.filter((m) => m.action === 'musician_sync' && m.replay);
    report.note(`the relay replayed ${replays.length} message(s) to the late viewer`);
    report.check(
      'every replayed message is a full presentation state',
      replays.length > 0 && replays.every((m) => typeof m.data?.contentType === 'string' && !!m.data?.blockLines),
      `replayed: ${JSON.stringify(replays.map((m) => Object.keys(m.data ?? {})))}`,
    );

    report.note(`late viewer screen: ${describeFrame(lateViewer.screen)}`);
    report.check('the late viewer sees a song title', !!lateViewer.screen.song, `screen was ${describeFrame(lateViewer.screen)}`);
    report.check('the late viewer sees lyrics', lateViewer.screen.lines.length > 0, `screen was ${describeFrame(lateViewer.screen)}`);
    report.equal(
      'and sees what the operator is actually presenting',
      [lateViewer.screen.block, lateViewer.screen.lines],
      ['Chorus', ['[101 chorus line 1]']],
    );

    await Promise.all([...clients, lateViewer].map((c) => c.close()));
  },
);

// 6 ─────────────────────────────────────────────────────────────────────────
scenario(
  'Musician fades to black over MIDI',
  'toggle_black travels as a remote_command; the operator owns the state and tells everyone.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const midiMusician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    const viewerA = await new ViewerClient({ url, account, name: 'viewer-A' }).connect();
    const viewerB = await new ViewerClient({ url, account, name: 'viewer-B' }).connect();
    const remote = await new RemoteClient({ url, account }).connect();
    const clients = [operator, midiMusician, viewerA, viewerB, remote];
    await quiesce(clients);

    operator.setActiveBlockIndex(1);
    await quiesce(clients);

    midiMusician.midiToggleBlack();
    await quiesce(clients);
    report.equal('operator went black', operator.state.isBlack, true);
    report.check(
      'both viewers are black',
      viewerA.screen.black && viewerB.screen.black,
      `A=${viewerA.screen.black} B=${viewerB.screen.black}`,
    );
    report.equal('the phone shows black too', remote.sync.isBlack, true);
    report.equal('the block behind black is unchanged', [operator.state.activeBlockIndex, viewerA.screen.block], [1, 'Chorus']);

    midiMusician.midiToggleBlack();
    await quiesce(clients);
    report.equal('a second press comes back from black', [operator.state.isBlack, viewerA.screen.black], [false, false]);
    report.equal('and lands on the same block it left', [operator.state.activeBlockIndex, viewerA.screen.block], [1, 'Chorus']);
    report.check(
      'the musician did not lose its own position',
      midiMusician.operatorBlockIndex === 1,
      `musician mirror = ${midiMusician.operatorBlockIndex}`,
    );

    await Promise.all(clients.map((c) => c.close()));
  },
);

// 7 ─────────────────────────────────────────────────────────────────────────
scenario(
  'Musician navigates while the operator is NOT following',
  'With MIDI-follow off nothing repairs the viewers, so a musician broadcast must be harmless on its own.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'off' }).connect();
    const midiMusician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    const viewer = await new ViewerClient({ url, account }).connect();
    const clients = [operator, midiMusician, viewer];
    await quiesce(clients);

    operator.setActiveBlockIndex(2);
    await quiesce(clients);
    report.equal('viewer starts on Verse 2', viewer.screen.block, 'Verse 2');

    midiMusician.midiNextBlock();
    await quiesce(clients);

    report.note(`viewer screen after the musician moved: ${describeFrame(viewer.screen)}`);
    report.equal('operator ignored the musician', operator.state.activeBlockIndex, 2);
    report.equal(
      'viewer still shows what the operator is presenting',
      [viewer.screen.song, viewer.screen.block, viewer.screen.lines],
      ['Großer Gott, wir loben Dich', 'Verse 2', ['[101 v2 line 1]']],
    );

    await Promise.all(clients.map((c) => c.close()));
  },
);

// 8 ─────────────────────────────────────────────────────────────────────────
scenario(
  'Mobile remote drives the show',
  'Commands from the phone are applied by the operator and confirmed by the sync everyone receives.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const followMusician = await new MusicianClient({ url, account, show, syncMode: 'operator', musicianName: 'Ben' }).connect();
    const viewer = await new ViewerClient({ url, account }).connect();
    const remote = await new RemoteClient({ url, account }).connect();
    const clients = [operator, followMusician, viewer, remote];
    await quiesce(clients);

    remote.sendCommand('next_block');
    await quiesce(clients);
    report.equal('next_block advanced the operator', operator.state.activeBlockIndex, 1);
    report.equal('viewer followed', viewer.screen.block, 'Chorus');

    remote.pickItem(2);
    await quiesce(clients);
    report.equal('set_item jumped to song 202', operator.state.activeItemIndex, 2);
    report.equal('the following musician came along', followMusician.localItemIndex, 2);

    remote.pickBlock(2);
    await quiesce(clients);
    report.equal('set_block landed on Verse 2 of song 202', [operator.state.activeBlockIndex, viewer.screen.block], [2, 'Verse 2']);

    remote.sendCommand('toggle_black');
    await quiesce(clients);
    report.equal('toggle_black from the phone blacked the viewer', viewer.screen.black, true);
    report.equal('and left the block alone', viewer.screen.block, 'Verse 2');

    await Promise.all(clients.map((c) => c.close()));
  },
);

// 9 ─────────────────────────────────────────────────────────────────────────
scenario('Denied remote commands', 'A command the operator has switched off must change nothing anywhere.', async ({ url, account }) => {
  const show = makeShow();
  const operator = await new OperatorClient({
    url,
    account,
    show,
    midiTrackingMaster: 'midi',
    remoteControlCommands: { toggle_black: false, next_item: false, prev_item: false },
  }).connect();
  const viewer = await new ViewerClient({ url, account }).connect();
  const remote = await new RemoteClient({ url, account }).connect();
  const clients = [operator, viewer, remote];
  await quiesce(clients);

  report.check(
    'the phone was told which commands are allowed',
    Array.isArray(remote.sync.remoteCommands) && !remote.sync.remoteCommands.includes('toggle_black'),
    JSON.stringify(remote.sync.remoteCommands),
  );

  remote.sendCommand('toggle_black');
  await quiesce(clients);
  report.equal('a denied toggle_black is ignored', [operator.state.isBlack, viewer.screen.black], [false, false]);

  remote.pickItem(2);
  await quiesce(clients);
  report.equal('set_item is denied when item navigation is off', operator.state.activeItemIndex, 0);

  remote.sendCommand('next_block');
  await quiesce(clients);
  report.equal('an allowed command still works', operator.state.activeBlockIndex, 1);

  await Promise.all(clients.map((c) => c.close()));
});

// 10 ────────────────────────────────────────────────────────────────────────
scenario(
  'Sync mode change and echo suppression',
  'Switching a musician to MIDI updates the operator breakdown; a musician never acts on its own echo.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const musician = await new MusicianClient({ url, account, show, syncMode: 'operator', musicianName: 'Ben' }).connect();
    const clients = [operator, musician];
    await quiesce(clients);

    report.check(
      'operator sees Ben following the operator',
      operator.peers.some((p) => p.role === 'musician' && p.mode === 'operator'),
      JSON.stringify(operator.peers),
    );

    musician.setSyncMode('midi');
    await waitFor(() => operator.peers.some((p) => p.role === 'musician' && p.mode === 'midi'), { label: 'peer mode update' });
    report.check(
      'the breakdown switched to MIDI without a reconnect',
      operator.peers.some((p) => p.role === 'musician' && p.mode === 'midi'),
      JSON.stringify(operator.peers),
    );
    report.equal('the socket was not dropped', musician.closeCode, null);

    const mirrorBefore = { item: musician.operatorItemIndex, block: musician.operatorBlockIndex };
    musician.midiNextBlock();
    await quiesce(clients);
    const ownEchoes = musician.received.filter((m) => m.action === 'musician_sync' && m.data?.clientId === musician.clientId);
    report.check(
      'the relay does echo the musician back to itself only via other sockets',
      ownEchoes.length === 0,
      `${ownEchoes.length} self-echo(es) received`,
    );
    report.equal('the musician holds the block it chose', musician.operatorBlockIndex, mirrorBefore.block + 1);
    report.equal('the operator followed it', operator.state.activeBlockIndex, mirrorBefore.block + 1);

    await Promise.all(clients.map((c) => c.close()));
  },
);

// 11 ────────────────────────────────────────────────────────────────────────
scenario(
  'Operator clears the connected clients',
  'disconnect_peers closes everyone else with 4010 and leaves the operator connected.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const musician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    const viewer = await new ViewerClient({ url, account }).connect();
    const remote = await new RemoteClient({ url, account }).connect();
    const clients = [operator, musician, viewer, remote];
    await quiesce(clients);

    operator.disconnectPeers();
    await waitFor(() => musician.closeCode !== null && viewer.closeCode !== null && remote.closeCode !== null, { label: 'peers to close' });
    await quiesce(clients);

    report.equal('musician closed with the operator-disconnect code', musician.closeCode, WS_CLOSE_OPERATOR_DISCONNECT);
    report.equal('viewer closed with the same code', viewer.closeCode, WS_CLOSE_OPERATOR_DISCONNECT);
    report.equal('remote closed with the same code', remote.closeCode, WS_CLOSE_OPERATOR_DISCONNECT);
    report.equal('the operator stayed connected', operator.closeCode, null);
    report.check(
      'the relay confirmed how many it closed',
      operator.received.some((m) => m.type === 'peers_disconnected' && m.count === 3),
      JSON.stringify(operator.received.filter((m) => m.type === 'peers_disconnected')),
    );
    report.equal('the operator is now alone', operator.peerCount, 0);

    await operator.close();
  },
);

// 12 ────────────────────────────────────────────────────────────────────────
scenario(
  'Reconnecting operator asks the MIDI master instead of publishing its own position',
  'The relay replays a cached selection on auth, and a restarted operator starts at item 0 — either would drag the band backwards.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const musician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    await quiesce([operator, musician]);

    musician.midiNextBlock();
    musician.midiNextBlock();
    await quiesce([operator, musician]);
    report.equal('operator followed to block 2', operator.state.activeBlockIndex, 2);

    await operator.close();
    const operator2 = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi', name: 'operator-2' }).connect();
    await quiesce([operator2, musician]);

    const replayed = operator2.received.filter((m) => m.action === 'musician_sync' && m.replay);
    report.note(`the relay replayed ${replayed.length} cached selection(s) to the reconnecting operator`);

    // The replay is still ignored outright — every position this operator adopted came from
    // the musician answering its `get_state`, never from the relay's cache.
    report.check(
      'the fresh operator ignored the replay',
      operator2.followed.every((f) => f.from === musician.clientId),
      `adopted from: ${JSON.stringify(operator2.followed.map((f) => f.from))}`,
    );

    // It asks the MIDI master where the show is instead of publishing its own start-up
    // position. Before, it announced block 0 and the musician mirrored that — the band's
    // pointer was dragged back and the next step continued from there. Now the master wins.
    report.equal('it adopted the MIDI master position', operator2.state.activeBlockIndex, 2);
    report.equal('the musician kept its own position', musician.operatorBlockIndex, 2);

    musician.midiNextBlock();
    await quiesce([operator2, musician]);
    report.equal('and follows live musician syncs again', operator2.state.activeBlockIndex, 3);
    report.equal('musician and operator agree', musician.operatorBlockIndex, operator2.state.activeBlockIndex);

    await Promise.all([operator2, musician].map((c) => c.close()));
  },
);

// 13 ────────────────────────────────────────────────────────────────────────
scenario(
  'Late joiner asks for the current state',
  'get_state must make the operator re-send even though nothing changed.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const viewer = await new ViewerClient({ url, account }).connect();
    await quiesce([operator, viewer]);

    operator.setActiveBlockIndex(2);
    await quiesce([operator, viewer]);
    const broadcastsBefore = operator.broadcasts.length;

    const latePhone = await new RemoteClient({ url, account, name: 'late-remote' }).connect();
    await quiesce([operator, viewer, latePhone]);

    report.check(
      'the operator re-broadcast on request',
      operator.broadcasts.length > broadcastsBefore,
      `broadcasts ${broadcastsBefore} → ${operator.broadcasts.length}`,
    );
    report.equal(
      'the phone has the live position',
      [latePhone.sync.activeBlockIndex, latePhone.sync.itemTitle],
      [2, 'Großer Gott, wir loben Dich'],
    );
    report.equal('the viewer was not disturbed', viewer.screen.block, 'Verse 2');

    const lateMusician = await new MusicianClient({ url, account, show, syncMode: 'operator', musicianName: 'Chris' }).connect();
    await quiesce([operator, viewer, latePhone, lateMusician]);
    report.equal(
      'a late operator-mode musician lands on the current position',
      [lateMusician.operatorItemIndex, lateMusician.operatorBlockIndex],
      [0, 2],
    );

    await Promise.all([operator, viewer, latePhone, lateMusician].map((c) => c.close()));
  },
);

// 14 ────────────────────────────────────────────────────────────────────────
scenario(
  'Selection expiry',
  'After SYNC_TTL_SECONDS with no updates the relay drops its cache and viewers say nothing is being presented.',
  async ({ ttlUrl, account }) => {
    const url = ttlUrl;
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const viewer = await new ViewerClient({ url, account }).connect();
    await quiesce([operator, viewer]);

    operator.setActiveBlockIndex(1);
    await quiesce([operator, viewer]);
    report.equal('viewer has content before expiry', viewer.screen.block, 'Chorus');
    report.equal('the relay told the viewer its TTL', viewer.syncTtlSeconds, 1);

    await waitFor(() => viewer.screen.noText, { timeout: 6000, label: 'sync_expired' });
    report.check(
      'viewer cleared to "nothing is being presented"',
      viewer.screen.noText && viewer.screen.lines.length === 0,
      describeFrame(viewer.screen),
    );
    report.equal('and dropped the black overlay with it', viewer.screen.black, false);

    const afterExpiry = await new ViewerClient({ url, account, name: 'viewer-after-expiry' }).connect();
    await quiesce([operator, viewer, afterExpiry]);
    report.equal('a viewer connecting after expiry gets no stale replay', afterExpiry.renders.length, 0);

    await Promise.all([operator, viewer, afterExpiry].map((c) => c.close()));
  },
);

// 15 ────────────────────────────────────────────────────────────────────────
scenario(
  'A passive second operator cannot drag the show back',
  'Reproduces the 30.08. service: background app instances answered on the show\u2019s behalf and the projection snapped to their item.',
  async ({ url, account }) => {
    const show = makeShow();
    const live = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi', name: 'operator-live' }).connect();
    // A second copy of the app, left open on another device. It never opened a presentation
    // window, so `isLiveOperator()` is false — and it is stuck on the show's first item.
    const ghost = await new OperatorClient({
      url,
      account,
      show,
      midiTrackingMaster: 'operator',
      isLive: false,
      name: 'operator-ghost',
    }).connect();
    const musician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    await quiesce([live, ghost, musician]);

    musician.midiNextItem();
    musician.midiNextItem();
    await quiesce([live, ghost, musician]);
    report.equal('the live operator followed the musician to item 2', live.state.activeItemIndex, 2);

    // The footswitch pause. In the log this is where both background instances published
    // item 0 and the live operator followed them.
    const ghostBroadcastsBefore = ghost.broadcasts.length;
    musician.midiToggleBlack();
    await quiesce([live, ghost, musician]);

    report.equal('the passive operator published nothing', ghost.broadcasts.length, ghostBroadcastsBefore);
    report.equal('the passive operator did not act on the command', ghost.state.isBlack, false);
    report.equal('the live operator went black', live.state.isBlack, true);
    report.equal('and stayed on item 2', live.state.activeItemIndex, 2);
    report.equal('the musician stayed on item 2', musician.localItemIndex, 2);

    // A musician (re)connecting is the other trigger: every operator used to answer.
    const latecomer = await new MusicianClient({ url, account, show, syncMode: 'operator', musicianName: 'Ben' }).connect();
    await quiesce([live, ghost, musician, latecomer]);
    report.equal('a late joiner lands on the live position, not the passive one', latecomer.localItemIndex, 2);
    report.equal('the live operator is still on item 2', live.state.activeItemIndex, 2);

    await Promise.all([live, ghost, musician, latecomer].map((c) => c.close()));
  },
);

// 16 ────────────────────────────────────────────────────────────────────────
scenario(
  'An edited show does not silently shift everyone by one',
  'Indices only mean the same item while both sides hold the same order; the song number rescues the ones that can be rescued.',
  async ({ url, account }) => {
    const show = makeShow();
    // The operator inserts an item at the top mid-service — every index below shifts.
    const editedShow = {
      ...show,
      order: [{ type: 'media', mediaSubType: 'image', label: 'Begrüßung' }, ...show.order],
    };

    const operator = await new OperatorClient({ url, account, show: editedShow, midiTrackingMaster: 'midi' }).connect();
    // This device never reloaded, so it is still holding the pre-edit order.
    const musician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    await quiesce([operator, musician]);

    // Song 202 is item 2 for the musician and item 3 for the operator.
    musician.midiNextItem();
    musician.midiNextItem();
    await quiesce([operator, musician]);

    report.equal('the musician is on song 202', musician.activeSongNumber, 202);
    report.equal(
      'the operator landed on song 202 too, at ITS index',
      operator.activeItem?.songNumber,
      202,
      `operator item index ${operator.state.activeItemIndex}`,
    );
    report.equal('which is one further down its order', operator.state.activeItemIndex, 3);

    // Now a position that cannot be rescued: a media item, which carries no song number.
    const rejectedBefore = operator.rejectedStale.length;
    musician.broadcastMidiSync({ activeItemIndex: 1, activeBlockIndex: 0, activeLineIndex: 0, songNumber: undefined });
    await quiesce([operator, musician]);

    report.check(
      'an unplaceable index is refused, not applied',
      operator.rejectedStale.length > rejectedBefore,
      `rejected ${rejectedBefore} → ${operator.rejectedStale.length}`,
    );
    report.equal('so the projection did not jump', operator.activeItem?.songNumber, 202);

    await Promise.all([operator, musician].map((c) => c.close()));
  },
);

// 17 ────────────────────────────────────────────────────────────────────────
scenario(
  'A second device can correct the one holding the footswitch',
  'MIDI mode used to ignore every incoming index, so fixing the position on a phone left the tablet behind.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const clock = { t: 100_000 };
    const now = () => clock.t;
    const tablet = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna', now }).connect();
    const phone = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Ben', now }).connect();
    await quiesce([operator, tablet, phone]);

    // The tablet (footswitch) is on the wrong song.
    tablet.midiNextItem();
    await quiesce([operator, tablet, phone]);
    report.equal('the tablet moved to item 1', tablet.localItemIndex, 1);

    // Past the authority window, so the correction below is not mistaken for an echo.
    clock.t += 5_000;

    // Anna fixes it from the phone.
    phone.midiNextItem();
    phone.midiNextItem();
    await quiesce([operator, tablet, phone]);

    report.equal('the phone is on item 2', phone.localItemIndex, 2);
    report.equal('the tablet followed the correction', tablet.localItemIndex, 2);
    report.equal('and so did the operator', operator.state.activeItemIndex, 2);

    // The next footswitch press therefore continues from the corrected position.
    clock.t += 5_000;
    tablet.midiNextBlock();
    await quiesce([operator, tablet, phone]);
    report.equal('the footswitch steps on from there', operator.state.activeItemIndex, 2);

    await Promise.all([operator, tablet, phone].map((c) => c.close()));
  },
);

// 18 ────────────────────────────────────────────────────────────────────────
scenario(
  'Our own echo never pulls a fast footswitch backwards',
  'The operator mirrors our position back; the echo of press N must not undo press N+1.',
  async ({ url, account }) => {
    const show = makeShow();
    const operator = await new OperatorClient({ url, account, show, midiTrackingMaster: 'midi' }).connect();
    const musician = await new MusicianClient({ url, account, show, syncMode: 'midi', musicianName: 'Anna' }).connect();
    await quiesce([operator, musician]);

    musician.midiNextBlock();
    musician.midiNextBlock();
    musician.midiNextBlock();
    await quiesce([operator, musician]);

    report.equal('the musician is on block 3', musician.operatorBlockIndex, 3);
    report.equal('and the operator agrees', operator.state.activeBlockIndex, 3);

    await Promise.all([operator, musician].map((c) => c.close()));
  },
);

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\x1b[1mPresenter — WebSocket sync integration test\x1b[0m');
  const relay = await startRelay({ ttlSeconds: 3600, verbose: VERBOSE });
  console.log(`  relay on ${relay.url} (SYNC_TTL_SECONDS=3600)`);
  const ttlRelay = await startRelay({ ttlSeconds: 1, verbose: VERBOSE });
  console.log(`  relay on ${ttlRelay.url} (SYNC_TTL_SECONDS=1, expiry scenario)`);

  try {
    for (let i = 0; i < scenarios.length; i++) {
      const s = scenarios[i];
      const number = i + 1;
      if (only.length && !only.includes(number)) continue;
      report.beginScenario(`${number}. ${s.name}`, s.description);
      try {
        await s.fn({ url: relay.url, ttlUrl: ttlRelay.url, account: 1000 + number });
      } catch (err) {
        report.scenarioError(err);
      }
      await sleep(50);
    }
  } finally {
    await relay.stop();
    await ttlRelay.stop();
  }

  const failed = report.summary();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
