import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Box, Stack, Typography, Button, CircularProgress, IconButton, Tooltip, Snackbar, Alert } from '@mui/material';
import {
  KeyboardArrowUp as PrevSongIcon,
  KeyboardArrowDown as NextSongIcon,
  KeyboardArrowLeft as PrevPageIcon,
  KeyboardArrowRight as NextPageIcon,
  SkipPrevious as PrevBlockIcon,
  SkipNext as NextBlockIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { useI18nContext } from '@/i18n/i18n-react';
import { useAppDispatch } from '@/store';
import { setCurrentShow, closeShowSelector, updateShowItem, setDirty, useGetShow } from '@/store/showSlice';
import { setSongsOrder, setSongOrders, setCurrentSongOrder, updateSongInStore, useGetSongs } from '@/store/songsSlice';
import { useGetMusicianSettings, useUpdateMusicianSetting } from '@/store/musicianSlice';
import { useGetSettings } from '@/store/settingsSlice';
import { Shows } from '@/components/show/Shows';
import { QrCodeShare } from '@/components/settings/QrCodeShare';
import { MusicianSidebar } from './MusicianSidebar';
import { MusicianToolbar, floatingBtnSx, type SyncMode } from './MusicianToolbar';
import { MusicianSettings } from './MusicianSettings';
import { PdfView } from './PdfView';
import { LyricsView } from './LyricsView';
import { usePdfViewer } from './usePdfViewer';
import { PdfUploadModal } from '@/components/pdf/PdfUploadModal';
import { PdfAreaMappingEditor } from '@/components/pdf/PdfAreaMappingEditor';
import { RemoteControlDialog } from '@/components/midi/RemoteControlDialog';
import { useMidi, type MidiAction } from '@/hooks/useMidi';
import { useKeyboardRemote } from '@/hooks/useKeyboardRemote';
import { useRemoteActionFilter } from '@/hooks/useRemoteActionFilter';
import { loadShowSongs } from '@/store/songsSlice';
import { parseOrderKey } from '@/utils/orderKeyUtils';
import { useBands } from '@/hooks/useBands';
import { Song } from '@/song';
import type { Show, ShowItem } from '@/api/shows.api';
import {
  useGetPresentationSettings,
  setActiveBlockIndex as setPresentationBlockIndex,
  setActiveItemAndBlock as setPresentationItemAndBlock,
} from '@/store/presentationSlice';
import { useShowUpdatePoller } from '@/hooks/useShowUpdatePoller';
import { formatRelativeTime } from '@/utils/relativeTime';
import { useWsSync } from '@/hooks/useWsSync';
import { useMixerBridge } from '@/hooks/useMixerBridge';
import { MixerLauncher } from '@/components/mixer/MixerLauncher';
import { resolveSyncIndex, showOrderSignature } from '@/utils/syncProtocol';
import { useMetrics } from '@/hooks/useMetrics';
import { useGetSessionQuery } from '@/api/session.api';
import { useUpdateSongMutation } from '@/api/songs.api';
import { useSaveShowMutation, useGetShowQuery } from '@/api/shows.api';
import { SongOrderEditor } from '@/components/song/SongOrderEditor';
import { useLazySearchChurchToolsSongsQuery } from '@/api/churchtools.api';
import { presenterApi } from '@/api/base.api';

/**
 * Top-level page component for the Musician View.
 *
 * Orchestrates the sidebar, toolbar, settings drawer, PDF/lyrics content area,
 * and the show selector dialog. Rendered as the sole child of the musician
 * entry-point (musician.tsx).
 */
/** How often auto-refresh re-validates PDFs and annotations (they have no revision feed). */
const AUTO_REFRESH_INTERVAL_MS = 60_000;
/**
 * How long our own navigation outranks anything arriving from the relay.
 *
 * The operator echoes our position back almost immediately, but it coalesces its
 * broadcasts, so a fast second press can be answered by the echo of the first. Without
 * this window, following peers in MIDI mode would make quick presses stutter backwards.
 */
const LOCAL_AUTHORITY_MS = 600;

/**
 * Identity of this page's outgoing sync broadcasts.
 *
 * The page sends and receives on ONE socket, and the relay never echoes a message back to
 * its sender, so this is a safety net rather than the main defence: it keeps a stray echo
 * (a second socket, a replayed cached state) from re-entering navigation as if it were the
 * operator talking.
 */
const WS_CLIENT_ID = `musician-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const MusicianPage = () => {
  const NAV_MARGIN = 36;

  const { palette } = useTheme();
  const { LL, locale } = useI18nContext();
  // The account's bands: their names feed the band picker, their members the name picker.
  const { bandNames, memberNames: bandMemberNames } = useBands();
  const {
    musicianName,
    musicianBand,
    musicianAnnotationLayer: annotationLayer,
    musicianTheme,
    musicianPageView: defaultPageView,
    musicianBlockIndicator: blockIndicator,
    musicianTextSize: textSize,
    musicianShowFooter: showFooter,
    musicianSyncMode: syncModeSetting,
    musicianSidebarOpen: persistedSidebarOpen,
    musicianLastItemIndex: persistedLastItemIndex,
    musicianAutoRefresh: autoRefresh,
    musicianRemoteDebounceMs: remoteDebounceMs,
    mixerCompact,
  } = useGetMusicianSettings();
  const { currentShow, isShowSelectorOpen } = useGetShow();
  const { songs } = useGetSongs();

  // Operator's live position — read-only, never mutated by the musician
  const { activeItemIndex: operatorItemIndex, activeBlockIndex: operatorActiveBlockIndex } = useGetPresentationSettings();

  const updateMusicianSetting = useUpdateMusicianSetting();

  const dispatch = useAppDispatch();
  const { trackEvent } = useMetrics();

  // ── Local UI state ───────────────────────────────────────────────
  const [activeItemIndex, setActiveItemIndex] = useState(persistedLastItemIndex);
  const [sidebarOpen, setSidebarOpen] = useState(persistedSidebarOpen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [pdfUploadOpen, setPdfUploadOpen] = useState(false);
  const [areaMappingOpen, setAreaMappingOpen] = useState(false);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [pdfOverrideFilename, setPdfOverrideFilename] = useState<string | null>(null);
  const [midiOpen, setMidiOpen] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>(syncModeSetting);
  const [orderEditorOpen, setOrderEditorOpen] = useState(false);
  const [orderEditorOrders, setOrderEditorOrders] = useState<Record<string, string[]>>({ Default: [] });
  const [orderEditorName, setOrderEditorName] = useState('Default');
  const [orderEditor, setOrderEditor] = useState<string[]>([]);
  const [orderEditorDirty, setOrderEditorDirty] = useState(false);
  const [orderEditorSaving, setOrderEditorSaving] = useState(false);

  // Fetch session to get the authenticated account number
  const { offlineMode, deviceId } = useGetSettings();
  const { data: sessionData } = useGetSessionQuery(undefined, { skip: offlineMode });
  const churchToolsEnabled = sessionData?.settings?.churchToolsEnabled ?? false;
  const [updateSongMutation] = useUpdateSongMutation();
  const [saveShowMutation] = useSaveShowMutation();

  // ChurchTools: resolve CT song ID from the active song's CCLI number
  const [ctSongId, setCtSongId] = useState<number | null>(null);
  const [ctSongName, setCtSongName] = useState<string>('');
  const [searchCtSongs] = useLazySearchChurchToolsSongsQuery();

  // Derive wsUrl from global session ws_hosts
  const wsUrl = useMemo(() => {
    const h = sessionData?.settings?.wsHost;
    if (h?.host && h?.port) {
      const path = h.path && h.path !== '/' ? h.path : '';
      return `${h.wss ? 'wss' : 'ws'}://${h.host}:${h.port}${path}`;
    }
    return '';
  }, [sessionData?.settings?.wsHost]);

  // The account number to use for WS authentication
  const wsAccount = useMemo(() => {
    const acc = sessionData?.account;
    return typeof acc === 'number' ? acc : null;
  }, [sessionData?.account]);
  const [showUpdateAvailable, setShowUpdateAvailable] = useState(false);
  /** Shown when a remote command (e.g. toggle black) could not be relayed to the operator. */
  const [remoteCommandFailed, setRemoteCommandFailed] = useState(false);
  const [operatorWsShowTitle, setOperatorWsShowTitle] = useState<string | undefined>(undefined);
  const [dismissedMismatchShowTitle, setDismissedMismatchShowTitle] = useState<string | null>(null);
  const initialLoadDone = useRef(false);
  /** Holds the latest annotation refetch function registered by PdfAnnotationToolbar */
  const annotationRefetchRef = useRef<(() => void) | null>(null);
  /**
   * The poller's reload, reachable from the WS callback without re-creating it. Declared
   * here because the callback below is defined before the poller hands us the function.
   */
  const reloadShowRef = useRef<(() => Promise<unknown>) | null>(null);

  // ── Show update polling ──────────────────────────────────────────────
  // In auto-refresh mode the poller applies foreign changes itself and never raises the banner.
  const {
    updateAvailable: showUpdateAvailable2,
    updatedAt: showUpdatedAt,
    reloadShow,
    dismiss: dismissShowUpdate,
  } = useShowUpdatePoller({ autoReload: autoRefresh });
  reloadShowRef.current = reloadShow;
  // Only fetch the operator's show (by title) when following it — not the whole show library.
  const { data: operatorShowData } = useGetShowQuery({ title: operatorWsShowTitle ?? '' }, { skip: !operatorWsShowTitle });
  // Keep the snackbar driven by the hook
  useEffect(() => {
    if (showUpdateAvailable2) setShowUpdateAvailable(true);
  }, [showUpdateAvailable2]);

  // ── WebSocket sync (browser + Electron) ─────────────────────────────
  // Active for 'operator' (follow operator item+block) and 'midi'
  // (MIDI input controls navigation, while WS keeps peers in sync).
  const handleSelectItemRef = useRef<((index: number) => void) | null>(null);
  // Holds the latest state received via WS so it can be re-applied after songs load.
  const pendingWsStateRef = useRef<{ activeItemIndex?: number; activeBlockIndex?: number } | null>(null);
  // Track operator's current song number from WS so we only apply block indicators when songs match.
  const [operatorWsSongNumber, setOperatorWsSongNumber] = useState<number | undefined>(undefined);
  // Ref to current musician's active item for use inside WS callback (avoids stale closure).
  const activeItemIndexRef = useRef(persistedLastItemIndex);
  const showItemsRef = useRef<ShowItem[]>([]);
  // Mirror of the operator position in Redux, so the WS callback can compare against the
  // current value and skip dispatching when nothing actually changed.
  const operatorItemIndexRef = useRef(0);
  const operatorBlockIndexRef = useRef(0);
  /** When we last navigated ourselves — see LOCAL_AUTHORITY_MS. */
  const lastLocalNavAtRef = useRef(0);
  /** Re-broadcasts our current position; assigned once `broadcastMidiSync` exists. */
  const answerGetStateRef = useRef<(() => void) | null>(null);
  /** Fingerprint of the show order we hold, so peers' indices can be validated. */
  const showSigRef = useRef<string | undefined>(undefined);
  /** Read inside the WS callback, which must not be re-created when these change. */
  const autoRefreshRef = useRef(false);
  const deviceIdRef = useRef('');
  /**
   * A peer is navigating a different version of the show, so its indices cannot be applied.
   * Raised instead of silently dropping the command — otherwise the footswitch just looks
   * broken. Cleared by reloading, or by the musician dismissing it.
   */
  const [syncMismatch, setSyncMismatch] = useState<{ songTitle?: string; at: number } | null>(null);
  /** Monitor mixer overlay. Its chunk is not downloaded until this first goes true. */
  const [mixerOpen, setMixerOpen] = useState(false);

  // Connected in every sync mode, including 'off': an independent musician follows nothing,
  // but the operator still needs to see them in the connected-clients breakdown (and be able
  // to clear them). Incoming state is dropped below instead of never arriving.
  const wsEnabled = !!wsUrl && wsAccount !== null;
  /**
   * The mixer shares this page's relay socket. It is wired through a ref because the hook
   * that handles its frames is created below, after the socket it sends on — and because
   * a second socket would make this musician appear twice in the operator's client list.
   */
  const mixerRelayHandlerRef = useRef<((msg: Record<string, unknown>) => void) | null>(null);

  const {
    status: wsStatus,
    broadcast: wsSend,
    reconnect: wsReconnect,
    relayClientId,
  } = useWsSync({
    url: wsUrl,
    account: wsAccount,
    enabled: wsEnabled,
    clientInfo: { role: 'musician', mode: syncMode, name: musicianName || undefined },
    requestState: syncMode !== 'off',
    onRelayMessage: useCallback((msg: Record<string, unknown>) => mixerRelayHandlerRef.current?.(msg), []),
    /**
     * A peer (typically an operator that just (re)started) is asking where the show is.
     * In MIDI mode this page is the navigation master, so it is the one that knows —
     * answering makes a restarting operator adopt our position instead of publishing its
     * own start-up position and dragging the band back to the first song.
     */
    onGetState: useCallback(() => {
      if (syncModeRef.current !== 'midi') return;
      answerGetStateRef.current?.();
    }, []),
    onStateUpdate: useCallback(
      (state) => {
        // Independent: this page navigates on its own, so nothing from the relay applies.
        if (syncMode === 'off') return;

        // Our own broadcast, bounced back by the relay — applying it would re-enter the
        // navigation path for a position we just set ourselves.
        if (state.clientId && state.clientId === WS_CLIENT_ID) return;
        if (state.senderRole === 'musician' && state.senderId && state.senderId === deviceIdRef.current) return;

        // The relay's cached-state replay (sent on every (re)connect). In MIDI mode WE are
        // the navigation master — adopting a stale cache (often the operator's last
        // broadcast, e.g. re-sent because black was toggled) would poison the pending
        // state and later snap this page (and with it the operator) back to an old item.
        // In operator mode it is the intended starting position, so it passes through.
        if (state.replay && syncMode === 'midi') return;

        // We just navigated here ourselves. The operator mirrors our position straight
        // back, but its broadcast is coalesced, so the echo of press N can arrive after
        // press N+1 and would pull us back a step. Our own recent input outranks an echo.
        if (syncMode === 'midi' && Date.now() - lastLocalNavAtRef.current < LOCAL_AUTHORITY_MS) return;

        // An index only means the same item to both sides while both hold the same show
        // order. Once the show is edited and one of us has not reloaded, applying it lands
        // on the wrong song — resolve by song number where possible, and otherwise say so
        // rather than jump (or, with auto-refresh on, just go and fetch the new version).
        const match = resolveSyncIndex({
          theirSig: state.showSig,
          ourSig: showSigRef.current,
          theirItemIndex: state.activeItemIndex,
          theirSongNumber: state.songNumber,
          ourItems: showItemsRef.current,
        });
        if (match.kind === 'stale') {
          if (autoRefreshRef.current) {
            void reloadShowRef.current?.();
          } else {
            setSyncMismatch({ songTitle: state.songTitle, at: Date.now() });
          }
          return;
        }
        const incomingItemIndex = match.kind === 'resolved' ? match.itemIndex : state.activeItemIndex;

        // Always persist the latest state so we can re-apply after songs load.
        pendingWsStateRef.current = {
          activeItemIndex: typeof incomingItemIndex === 'number' ? incomingItemIndex : undefined,
          activeBlockIndex: typeof state.activeBlockIndex === 'number' ? state.activeBlockIndex : undefined,
        };
        // Track which song the operator is currently on for song-matching guard.
        if (typeof state.songNumber === 'number') {
          setOperatorWsSongNumber(state.songNumber);
        }
        if (typeof state.showTitle === 'string') {
          setOperatorWsShowTitle(state.showTitle);
        }
        // The item we will be showing once this update settles — `handleSelectItem` only
        // takes effect on the next render, so the song check below must not read the
        // item we are leaving.
        let shownItemIndex = activeItemIndexRef.current;
        if (typeof incomingItemIndex === 'number') {
          // Follow the peer's item — in operator mode, and in MIDI mode too. MIDI mode
          // used to ignore this because it is the navigation master, but that also meant a
          // second device could never correct the first: fixing the position on a phone
          // moved the operator and left the footswitch tablet behind, still broadcasting
          // its old item on the next press. Our own input is protected by the authority
          // window above, so following a peer here is safe.
          //
          // Non-song items (media, bible) are NOT followed — the musician keeps
          // their current sheet while the operator shows announcement slides etc.
          // An index this show doesn't have is ignored rather than selected: it means
          // the operator is running a different show, and selecting it blanks the view.
          const targetItem = showItemsRef.current[incomingItemIndex];
          if (targetItem && targetItem.type === 'song') {
            handleSelectItemRef.current?.(incomingItemIndex);
            shownItemIndex = incomingItemIndex;
          }
        }

        // The operator's block index only means anything while they are on the same song
        // as us. Anything else — a media/bible item (no songNumber), or a different song
        // because show or order are out of sync — must leave our indicator alone.
        const shownItem = showItemsRef.current[shownItemIndex] as (ShowItem & { songNumber?: number }) | undefined;
        const matchesSong = typeof state.songNumber === 'number' && shownItem?.type === 'song' && state.songNumber === shownItem.songNumber;

        // Item and block are applied in ONE dispatch: setActiveItemIndex resets the block
        // index to 0, so dispatching them separately made every operator broadcast wipe our
        // block position whenever the song didn't match — the next "next block" then
        // restarted at 1 and re-broadcast it, ping-ponging the two sides.
        const nextItemIndex = typeof state.activeItemIndex === 'number' ? state.activeItemIndex : operatorItemIndexRef.current;
        const nextBlockIndex =
          matchesSong && typeof state.activeBlockIndex === 'number' ? state.activeBlockIndex : operatorBlockIndexRef.current;
        if (nextItemIndex !== operatorItemIndexRef.current || nextBlockIndex !== operatorBlockIndexRef.current) {
          dispatch(setPresentationItemAndBlock({ itemIndex: nextItemIndex, blockIndex: nextBlockIndex }));
        }
      },
      [dispatch, syncMode],
    ),
  });

  const handleRegisterRefetch = useCallback((fn: () => void) => {
    annotationRefetchRef.current = fn;
  }, []);

  // ── Manual + automatic refresh of server-side content ────────────────
  /** Reload the PDF list/resolution and the annotations of the visible sheet. */
  const refreshPdfsAndAnnotations = useCallback(() => {
    dispatch(presenterApi.util.invalidateTags(['Pdfs', 'PdfAnnotations']));
    annotationRefetchRef.current?.();
  }, [dispatch]);

  /** "Update show, songs, orders, PDFs" — re-reads everything from the server. */
  const handleRefreshContent = useCallback(async () => {
    refreshPdfsAndAnnotations();
    await reloadShow({ forceSongs: true });
  }, [refreshPdfsAndAnnotations, reloadShow]);

  // Auto mode: show/song changes are adopted by the pollers, but PDFs and annotations
  // have no revision feed — so re-validate them on a timer while auto-refresh is on.
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(refreshPdfsAndAnnotations, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [autoRefresh, refreshPdfsAndAnnotations]);

  const handleToggleAutoRefresh = useCallback(() => {
    const next = !autoRefresh;
    updateMusicianSetting('musicianAutoRefresh', next);
    // Turning it on should feel immediate rather than waiting for the first poll.
    if (next) void handleRefreshContent();
  }, [autoRefresh, updateMusicianSetting, handleRefreshContent]);

  // Persist sync mode changes
  const handleSetSyncMode = useCallback((mode: SyncMode) => {
    setSyncMode(mode);
    updateMusicianSetting('musicianSyncMode', mode);
  }, []);

  // ── Active item derivation ───────────────────────────────────────
  const showItems: ShowItem[] = currentShow?.order ?? [];
  /**
   * Monitor mixing. Asks the operator what is on offer as soon as the relay is up and
   * holds nothing else — the mixer's own state lives in the lazy chunk, so meters at
   * 10 Hz never re-render this page and the PDF behind it.
   */
  const {
    bridge: mixerBridge,
    announcement: mixerAnnouncement,
    available: mixerAvailable,
    handleRelayMessage: handleMixerRelayMessage,
  } = useMixerBridge({ send: wsSend, relayClientId, connected: wsStatus === 'connected' });
  mixerRelayHandlerRef.current = handleMixerRelayMessage;

  // Keep refs in sync for use inside WS callbacks (avoid stale closures)
  activeItemIndexRef.current = activeItemIndex;
  showItemsRef.current = showItems;
  showSigRef.current = showOrderSignature(currentShow);
  autoRefreshRef.current = autoRefresh;
  deviceIdRef.current = deviceId;
  const syncModeRef = useRef(syncMode);
  syncModeRef.current = syncMode;
  operatorItemIndexRef.current = operatorItemIndex;
  operatorBlockIndexRef.current = operatorActiveBlockIndex;

  // Clamp persisted item index to valid range when show items load
  useEffect(() => {
    if (showItems.length > 0 && activeItemIndex >= showItems.length) {
      const clamped = Math.max(0, showItems.length - 1);
      setActiveItemIndex(clamped);
      updateMusicianSetting('musicianLastItemIndex', clamped);
    }
  }, [showItems.length, activeItemIndex, dispatch]);

  const activeItem: ShowItem | undefined = showItems[activeItemIndex];
  const activeSongNumber = activeItem?.type === 'song' ? activeItem.songNumber : undefined;
  const activeSong = activeSongNumber != null ? songs[activeSongNumber] : undefined;

  const canGoPrev = activeItemIndex > 0;
  const canGoNext = showItems.length > 0 && activeItemIndex < showItems.length - 1;

  const parsedOrder = useMemo(() => parseOrderKey(activeItem?.order), [activeItem?.order]);
  const activeKey = activeItem?.key || parsedOrder.key;
  const activeSongOrder = parsedOrder.order || 'Default';

  // Compute lyrics blocks for the active song
  const lyricsBlocks = useMemo(() => {
    if (!activeSong) return [];
    try {
      return activeSong.getBlocks(activeSongOrder);
    } catch {
      return [];
    }
  }, [activeSong, activeSongOrder]);

  useEffect(() => {
    if (!activeSong) {
      setOrderEditorOpen(false);
      setOrderEditorOrders({ Default: [] });
      setOrderEditorName('Default');
      setOrderEditor([]);
      setOrderEditorDirty(false);
      return;
    }
    const sourceOrders =
      activeSong.order && Object.keys(activeSong.order).length > 0
        ? activeSong.order
        : {
            Default: activeSong.initialOrder ?? [],
          };
    const selectedOrderName = sourceOrders[activeSongOrder] ? activeSongOrder : (Object.keys(sourceOrders)[0] ?? 'Default');
    setOrderEditorOrders(sourceOrders);
    setOrderEditorName(selectedOrderName);
    setOrderEditor(sourceOrders[selectedOrderName] ?? []);
    setOrderEditorDirty(false);
  }, [activeSong, activeSongOrder]);

  // Names to offer in the settings picker: the people on the account's bands, plus the
  // order names already in use — which is what a "band" was before bands were configurable,
  // and is still where a library that predates them keeps its names.
  const musicianNames = useMemo(() => {
    const names = new Set<string>(bandMemberNames);
    for (const song of Object.values(songs)) {
      if (song.order) {
        for (const orderName of Object.keys(song.order)) {
          const parsed = parseOrderKey(orderName);
          if (parsed.order && parsed.order !== 'Default') {
            names.add(parsed.order);
          }
        }
      }
    }
    return Array.from(names).sort();
  }, [songs, bandMemberNames]);

  // Bands to pick from: the configured ones, plus every order name found in the library so
  // a song arranged for a band nobody has entered yet can still be followed.
  const availableBands = useMemo(() => {
    const bands = new Set<string>(['Default', ...bandNames]);
    for (const song of Object.values(songs)) {
      if (song.order) {
        for (const orderName of Object.keys(song.order)) {
          const parsed = parseOrderKey(orderName);
          if (parsed.order) bands.add(parsed.order);
        }
      }
    }
    return Array.from(bands).sort();
  }, [songs, bandNames]);

  // Unique block names for area mapping editor — use the ordered sequence (deduplicated)
  // so the dropdown reflects the current order, including custom-ordered blocks.
  const activeSongBlocks = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const block of lyricsBlocks) {
      if (!seen.has(block.name)) {
        seen.add(block.name);
        result.push(block.name);
      }
    }
    // Fallback: if no ordered blocks available, use all block keys
    if (result.length === 0 && activeSong) {
      return Object.keys(activeSong.blocks ?? {});
    }
    return result;
  }, [lyricsBlocks, activeSong]);

  // Lyrics per block name, so the area mapping editor can preview a block's text on hover
  // instead of the user having to look the song up elsewhere to tell verses apart.
  const activeSongBlockLines = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const block of lyricsBlocks) {
      if (!map[block.name]) map[block.name] = block.lines ?? [];
    }
    for (const [name, lines] of Object.entries(activeSong?.blocks ?? {})) {
      if (!map[name]) map[name] = lines;
    }
    return map;
  }, [lyricsBlocks, activeSong]);

  // ── PDF viewer hook ──────────────────────────────────────────────
  const pdfViewer = usePdfViewer({
    activeItem,
    musicianName,
    musicianBand,
    syncMode,
    operatorActiveBlockIndex,
    lyricsBlocks,
    defaultPageView,
    blockIndicator,
    pdfOverrideFilename,
  });

  // Active block area mapping for the visual indicator overlay in PdfView
  const activeBlockAreaMapping = useMemo(() => {
    if (!pdfViewer.areaMappings || operatorActiveBlockIndex == null || operatorActiveBlockIndex < 0) return undefined;
    const activeBlock = lyricsBlocks[operatorActiveBlockIndex];
    if (!activeBlock) return undefined;
    return pdfViewer.areaMappings.find((m) => m.blockName === activeBlock.name && m.region);
  }, [pdfViewer.areaMappings, operatorActiveBlockIndex, lyricsBlocks]);

  // Next block area mapping for the grey hint overlay.
  // If the immediately next block has the same name as the current one, show nothing.
  const nextBlockAreaMapping = useMemo(() => {
    if (!pdfViewer.areaMappings || operatorActiveBlockIndex == null) return undefined;
    const activeBlock = lyricsBlocks[operatorActiveBlockIndex];
    const nextBlock = lyricsBlocks[operatorActiveBlockIndex + 1];
    if (!nextBlock || nextBlock.name === activeBlock?.name) return undefined;
    return pdfViewer.areaMappings.find((m) => m.blockName === nextBlock.name && m.region);
  }, [pdfViewer.areaMappings, operatorActiveBlockIndex, lyricsBlocks]);

  const hasPdfs = pdfViewer.totalPdfCount > 0;
  const isSongItem = activeItem?.type === 'song';

  // PDF page navigation
  const canGoPrevPage = hasPdfs && pdfViewer.currentPage > 1;
  const canGoNextPage = hasPdfs && pdfViewer.currentPage < pdfViewer.numPages;

  // ── Show loading ─────────────────────────────────────────────────
  useEffect(() => {
    if (!initialLoadDone.current && currentShow && !isShowSelectorOpen) {
      initialLoadDone.current = true;
      void dispatch(loadShowSongs(currentShow));
    }
  }, [currentShow, isShowSelectorOpen, dispatch]);

  // Re-apply pending WS state once songs have loaded.
  // This handles the case where get_state response arrives before songs are ready.
  const songsLoadedRef = useRef(false);
  const songCount = Object.keys(songs).length;
  useEffect(() => {
    if (songCount === 0) {
      songsLoadedRef.current = false;
      return;
    }
    if (songsLoadedRef.current) return; // already applied
    songsLoadedRef.current = true;
    const pending = pendingWsStateRef.current;
    if (!pending) return;
    // Applied in MIDI mode too, matching `onStateUpdate`. This is the case where a peer's
    // state arrived before the songs were ready, so the handler could not place it; the
    // state itself was already validated there (a stale show version never reaches this
    // ref, and neither does the relay's replay cache in MIDI mode).
    if (typeof pending.activeItemIndex === 'number' && syncModeRef.current !== 'off') {
      // Only follow to song items — see the WS onStateUpdate handler.
      const targetItem = showItemsRef.current[pending.activeItemIndex];
      if (targetItem && targetItem.type === 'song') {
        handleSelectItemRef.current?.(pending.activeItemIndex);
      }
    }
    // One dispatch — setActiveItemIndex would zero the block index we are restoring.
    dispatch(
      setPresentationItemAndBlock({
        itemIndex: pending.activeItemIndex ?? operatorItemIndexRef.current,
        blockIndex: pending.activeBlockIndex ?? operatorBlockIndexRef.current,
      }),
    );
  }, [songCount, dispatch]);

  const handleShowSelected = useCallback(
    async (show: Show | null, isNew: boolean) => {
      if (!show) return;
      dispatch(setCurrentShow(show));
      setActiveItemIndex(0);
      updateMusicianSetting('musicianLastItemIndex', 0);
      dispatch(closeShowSelector());
      if (!isNew) {
        await dispatch(loadShowSongs(show));
      } else {
        dispatch(setSongsOrder([]));
        dispatch(setSongOrders({}));
      }
    },
    [dispatch, updateMusicianSetting],
  );

  const handleSelectItem = useCallback(
    (index: number) => {
      pdfViewer.saveScrollPosition();
      setAnnotateMode(false);
      setPdfOverrideFilename(null);
      setActiveItemIndex(index);
      updateMusicianSetting('musicianLastItemIndex', index);
    },
    [pdfViewer, updateMusicianSetting],
  );
  // Keep ref in sync so useWsSync onStateUpdate can call it without re-registering the hook
  handleSelectItemRef.current = handleSelectItem;

  // Refs updated each render so callbacks always see the latest values without re-registering
  const wsSendRef = useRef(wsSend);
  wsSendRef.current = wsSend;
  const lyricsBlocksRef = useRef(lyricsBlocks);
  lyricsBlocksRef.current = lyricsBlocks;
  const activeSongNumberRef = useRef(activeSongNumber);
  activeSongNumberRef.current = activeSongNumber;

  /** Broadcast musician sync via both WS relay (for browser peers) and IPC (for Electron operator window). */
  const broadcastMidiSync = useCallback((data: Record<string, unknown>, opts?: { local?: boolean }) => {
    // Navigating here ourselves is what earns the authority window. Merely ANSWERING a
    // peer's `get_state` must not open it: we would then ignore that peer's reply to our
    // own answer, and a MIDI musician would stop mirroring the operator entirely.
    if (opts?.local !== false) lastLocalNavAtRef.current = Date.now();
    // clientId lets our own receive socket recognise and drop the relay's echo.
    // senderRole/senderId/showSig let the operator tell a musician driving the show apart
    // from a passive app instance, and tell whether our index means what it says — see
    // `@/utils/syncProtocol`.
    const tagged = {
      ...data,
      clientId: WS_CLIENT_ID,
      senderRole: 'musician' as const,
      senderId: deviceIdRef.current,
      showSig: showSigRef.current,
    };
    wsSendRef.current('musician_sync', tagged);
    // Also send directly to operator via Electron IPC when running in the desktop app
    window.api?.musicianSyncToOperator?.({ action: 'musician_sync', data: tagged });
  }, []);

  // Answering a peer's `get_state` — declared here because the WS callback above needs it
  // before `broadcastMidiSync` is defined.
  answerGetStateRef.current = () => {
    broadcastMidiSync(
      {
        activeItemIndex: activeItemIndexRef.current,
        activeBlockIndex: operatorBlockIndexRef.current,
        activeLineIndex: 0,
        songNumber: activeSongNumberRef.current,
      },
      { local: false },
    );
  };

  /** User-initiated navigation (sidebar click, prev/next buttons) — disables sync first unless in midi mode */
  const handleUserSelectItem = useCallback(
    (index: number) => {
      if (syncMode === 'midi') {
        handleSelectItem(index);
        // Selecting an item always restarts at its first block.
        dispatch(setPresentationItemAndBlock({ itemIndex: index, blockIndex: 0 }));
        const newItem = showItemsRef.current[index] as (ShowItem & { songNumber?: number }) | undefined;
        broadcastMidiSync({
          activeItemIndex: index,
          activeBlockIndex: 0,
          activeLineIndex: 0,
          songNumber: newItem?.type === 'song' ? newItem.songNumber : undefined,
        });
      } else {
        if (syncMode !== 'off') {
          setSyncMode('off');
          updateMusicianSetting('musicianSyncMode', 'off');
        }
        handleSelectItem(index);
      }
    },
    [syncMode, updateMusicianSetting, handleSelectItem, dispatch, broadcastMidiSync],
  );

  /** Manual navigation (prev/next buttons) — disables sync first unless in midi mode */
  const handleManualNav = useCallback(
    (index: number) => {
      if (syncMode === 'midi') {
        handleSelectItem(index);
        // Selecting an item always restarts at its first block.
        dispatch(setPresentationItemAndBlock({ itemIndex: index, blockIndex: 0 }));
        const newItem = showItemsRef.current[index] as (ShowItem & { songNumber?: number }) | undefined;
        broadcastMidiSync({
          activeItemIndex: index,
          activeBlockIndex: 0,
          activeLineIndex: 0,
          songNumber: newItem?.type === 'song' ? newItem.songNumber : undefined,
        });
      } else {
        if (syncMode !== 'off') {
          setSyncMode('off');
          updateMusicianSetting('musicianSyncMode', 'off');
        }
        handleSelectItem(index);
      }
    },
    [syncMode, updateMusicianSetting, handleSelectItem, dispatch, broadcastMidiSync],
  );

  /** Handle MIDI actions for navigation */
  const handleMidiAction = useCallback(
    (action: MidiAction) => {
      switch (action) {
        case 'next_song': {
          const idx = activeItemIndexRef.current;
          if (idx < showItemsRef.current.length - 1) handleManualNav(idx + 1);
          break;
        }
        case 'prev_song': {
          const idx = activeItemIndexRef.current;
          if (idx > 0) handleManualNav(idx - 1);
          break;
        }
        // Both block actions clamp the CURRENT index into our own order before stepping.
        // The Redux value can come from the operator, whose order may be shorter or longer
        // than ours; stepping from an out-of-range value would jump or run past the end.
        case 'next_block': {
          if (syncMode !== 'midi') break;
          const blockCount = lyricsBlocksRef.current.length;
          if (blockCount === 0) break;
          const next = Math.min(Math.max(operatorActiveBlockIndex, -1), blockCount - 1) + 1;
          if (next >= blockCount || next === operatorActiveBlockIndex) break;
          dispatch(setPresentationBlockIndex(next));
          broadcastMidiSync({
            activeItemIndex: activeItemIndexRef.current,
            activeBlockIndex: next,
            activeLineIndex: 0,
            songNumber: activeSongNumberRef.current,
          });
          break;
        }
        case 'prev_block': {
          if (syncMode !== 'midi') break;
          const blockCount = lyricsBlocksRef.current.length;
          if (blockCount === 0) break;
          const prev = Math.min(operatorActiveBlockIndex, blockCount) - 1;
          if (prev < 0 || prev === operatorActiveBlockIndex) break;
          dispatch(setPresentationBlockIndex(prev));
          broadcastMidiSync({
            activeItemIndex: activeItemIndexRef.current,
            activeBlockIndex: prev,
            activeLineIndex: 0,
            songNumber: activeSongNumberRef.current,
          });
          break;
        }
        case 'next_page':
          if (pdfViewer.currentPage < pdfViewer.numPages) pdfViewer.setCurrentPage(pdfViewer.currentPage + 1);
          break;
        case 'prev_page':
          if (pdfViewer.currentPage > 1) pdfViewer.setCurrentPage(pdfViewer.currentPage - 1);
          break;
        // Black is an output state the musician view has no copy of, so it is relayed to
        // the operator as the same `remote_command` the mobile control page sends — the
        // operator's per-command permissions therefore apply to it too. Sent over the sync
        // socket we already hold, so it works in Operator sync as well as MIDI sync.
        case 'toggle_black':
          // The musician view shows no black state, so a silently dropped press would be
          // invisible — warn only when it could not be delivered.
          if (!wsSendRef.current('remote_command', { command: 'toggle_black' })) {
            setRemoteCommandFailed(true);
          }
          break;
      }
    },
    [handleManualNav, pdfViewer, syncMode, operatorActiveBlockIndex, dispatch, broadcastMidiSync],
  );

  /**
   * Called when the user taps a mapped-block rectangle in the PDF view (MIDI sync mode only).
   * Navigates to the first occurrence of the block name in the current song order.
   * If the block is not in the order it is silently ignored.
   */
  const handleMappingBlockClick = useCallback(
    (blockName: string) => {
      if (syncMode !== 'midi') return;
      const idx = lyricsBlocksRef.current.findIndex((b) => b.name === blockName);
      if (idx < 0) return; // block not in current order — no navigation
      dispatch(setPresentationBlockIndex(idx));
      broadcastMidiSync({
        activeItemIndex: activeItemIndexRef.current,
        activeBlockIndex: idx,
        activeLineIndex: 0,
        songNumber: activeSongNumberRef.current,
      });
    },
    [syncMode, dispatch, broadcastMidiSync],
  );

  const handleOrderTagSelect = useCallback(
    (_name: string, orderIndex: number) => {
      if (syncMode !== 'midi') return;
      if (orderIndex < 0 || orderIndex >= orderEditor.length) return;
      dispatch(setPresentationBlockIndex(orderIndex));
      broadcastMidiSync({
        activeItemIndex: activeItemIndexRef.current,
        activeBlockIndex: orderIndex,
        activeLineIndex: 0,
        songNumber: activeSongNumberRef.current,
      });
    },
    [syncMode, orderEditor.length, dispatch, broadcastMidiSync],
  );

  const handleSaveOrderEditor = useCallback(async () => {
    if (!activeSong || activeSongNumber == null || !currentShow) return;
    const trimmedName = orderEditorName.trim();
    if (!trimmedName || orderEditor.length === 0) return;

    const nextOrders = { ...orderEditorOrders, [trimmedName]: orderEditor };
    const updatedSong = new Song({
      ...activeSong,
      order: nextOrders,
      initialOrder: activeSong.initialOrder,
    });

    try {
      setOrderEditorSaving(true);
      await updateSongMutation({
        songNumber: updatedSong.songNumber,
        title: updatedSong.title,
        authors: updatedSong.authors,
        copyright: updatedSong.copyright,
        initialOrder: updatedSong.initialOrder || [],
        order: updatedSong.order,
        blocks: updatedSong.blocks,
      }).unwrap();

      dispatch(updateSongInStore(updatedSong));
      trackEvent('song_updated', 'song', String(updatedSong.songNumber), { via: 'order' });
      dispatch(setCurrentSongOrder({ songNumber: updatedSong.songNumber, orderName: trimmedName }));
      dispatch(updateShowItem({ index: activeItemIndex, item: { order: trimmedName } }));

      const nextShowOrder = showItems.map((showItem, idx) => (idx === activeItemIndex ? { ...showItem, order: trimmedName } : showItem));
      // Omit eventId so the backend preserves the existing ChurchTools event link.
      await saveShowMutation({
        title: currentShow.title,
        order: nextShowOrder,
        groups: currentShow.groups,
        styleId: currentShow.styleId ?? null,
      }).unwrap();
      dispatch(setDirty(false));
      setOrderEditorDirty(false);
    } finally {
      setOrderEditorSaving(false);
    }
  }, [
    activeSong,
    activeSongNumber,
    currentShow,
    orderEditorName,
    orderEditor,
    orderEditorOrders,
    updateSongMutation,
    dispatch,
    activeItemIndex,
    showItems,
    saveShowMutation,
  ]);

  /**
   * Hardware-remote entry point (MIDI + keyboard/footswitch). Same actions as the
   * on-screen buttons, but filtered so a bouncing footswitch can't double-trigger.
   * The on-screen buttons keep calling handleMidiAction directly — a deliberate
   * double tap there should not be swallowed.
   */
  const acceptRemoteAction = useRemoteActionFilter(remoteDebounceMs);
  const handleRemoteAction = useCallback(
    (action: MidiAction) => {
      if (!acceptRemoteAction(action)) return;
      handleMidiAction(action);
    },
    [acceptRemoteAction, handleMidiAction],
  );

  // Always-on MIDI — MIDI is a local hardware input and should work regardless of
  // the network sync mode. The RemoteControlDialog has its own separate useMidi instance.
  useMidi({ onAction: handleRemoteAction, enabled: true });

  // Always-on keyboard remote — window-level listener, so the page owns the SINGLE
  // instance and shares it with the RemoteControlDialog (a second one would double-fire).
  const keyboardRemote = useKeyboardRemote({ onAction: handleRemoteAction, enabled: true });

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      updateMusicianSetting('musicianSidebarOpen', next);
      return next;
    });
  }, [updateMusicianSetting]);

  // Reset annotate mode when the active item changes
  useEffect(() => {
    setAnnotateMode(false);
    setPdfOverrideFilename(null);
    // Reset CT context when song changes
    setCtSongId(null);
    setCtSongName('');
  }, [activeItemIndex]);

  // ── Sync: follow operator item selection ─────────────────────────
  useEffect(() => {
    if (syncMode === 'operator' && operatorItemIndex !== activeItemIndex) {
      // Non-song items are not followed — the musician keeps their current sheet
      // while the operator shows announcement slides / media items. An index this show
      // doesn't have is ignored too: it means the operator is on a different show, and
      // selecting it would leave the view on a non-existent item until a reload.
      const targetItem = showItems[operatorItemIndex];
      if (!targetItem || targetItem.type !== 'song') return;
      handleSelectItem(operatorItemIndex);
    }
  }, [syncMode, operatorItemIndex]); // intentionally exclude handleSelectItem / activeItemIndex to avoid loops

  // isSynced: block indicators visible only when sync is on, blockIndicator is enabled,
  // and the block position we are showing actually belongs to the song on screen.
  const operatorSongMatchesMusician = useMemo(() => {
    if (syncMode === 'midi') {
      // In MIDI mode the musician drives navigation, so the block index in Redux IS their
      // own position for the item they are on — there is no operator to match against.
      // (Item switches reset it to 0 in the same dispatch, and the WS handler only adopts
      // a foreign block index when the song matches, so it can't belong to another song.)
      //
      // This used to compare operatorItemIndex with activeItemIndex. Those are only kept
      // in step by navigating or by an incoming WS message: after a reload the musician's
      // item is restored from localStorage while the Redux presentation index starts at 0,
      // so on any item but the first the indicators stayed hidden until the user toggled
      // to Operator sync (whose follow effect aligns the two) and back.
      return true;
    }
    // WS modes: compare song numbers received via WS
    if (operatorWsSongNumber == null) return true; // no info yet, assume match
    return operatorWsSongNumber === activeSongNumber;
  }, [syncMode, operatorWsSongNumber, activeSongNumber]);

  const isSynced = (syncMode === 'operator' || syncMode === 'midi') && blockIndicator && operatorSongMatchesMusician;

  const showMismatchDetected =
    !!operatorWsShowTitle &&
    !!currentShow?.title &&
    operatorWsShowTitle !== currentShow.title &&
    dismissedMismatchShowTitle !== operatorWsShowTitle;

  const applyOperatorShow = useCallback(async () => {
    if (!operatorWsShowTitle) return;
    const operatorShow = operatorShowData?.shows?.[0];
    if (!operatorShow || operatorShow.title !== operatorWsShowTitle) return;
    dispatch(setCurrentShow(operatorShow));
    await dispatch(loadShowSongs(operatorShow));
    setActiveItemIndex(0);
    updateMusicianSetting('musicianLastItemIndex', 0);
    setDismissedMismatchShowTitle(null);
  }, [operatorWsShowTitle, operatorShowData?.shows, dispatch, updateMusicianSetting]);

  // ── Render ───────────────────────────────────────────────────────
  return (
    <>
      {/* Show selector dialog */}
      <Shows
        open={isShowSelectorOpen}
        onShowSelected={handleShowSelected}
        allowClose={!!currentShow}
        onClose={() => dispatch(closeShowSelector())}
        currentShowTitle={currentShow?.title}
      />
      {/* QR sharing dialog */}
      <QrCodeShare open={qrOpen} onClose={() => setQrOpen(false)} />
      {/* Show update notification */}
      <Snackbar open={showUpdateAvailable} anchorOrigin={{ vertical: 'top', horizontal: 'center' }} sx={{ top: { xs: 8, sm: 16 } }}>
        <Alert
          severity="info"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={async () => {
                setShowUpdateAvailable(false);
                await reloadShow();
              }}
            >
              {LL.SHOWS.UPDATE_AVAILABLE_ACTION()}
            </Button>
          }
          onClose={() => {
            setShowUpdateAvailable(false);
            dismissShowUpdate();
          }}
        >
          {LL.SHOWS.UPDATE_AVAILABLE()}
          {showUpdatedAt ? ` · ${LL.SHOWS.UPDATE_AVAILABLE_AT({ time: formatRelativeTime(showUpdatedAt, locale) })}` : ''}
        </Alert>
      </Snackbar>{' '}
      <Snackbar open={showMismatchDetected} anchorOrigin={{ vertical: 'top', horizontal: 'center' }} sx={{ top: { xs: 72, sm: 80 } }}>
        <Alert
          severity="warning"
          action={
            <Stack direction="row" spacing={1}>
              <Button color="inherit" size="small" onClick={() => setDismissedMismatchShowTitle(operatorWsShowTitle ?? null)}>
                {LL.CONNECTIVITY.SNACK_DISMISS()}
              </Button>
              <Button color="inherit" size="small" onClick={() => void applyOperatorShow()}>
                {LL.MUSICIAN.SELECT_SHOW()}
              </Button>
            </Stack>
          }
          onClose={() => setDismissedMismatchShowTitle(operatorWsShowTitle ?? null)}
        >
          {LL.MUSICIAN.SHOW_MISMATCH_WARNING({ operatorShow: operatorWsShowTitle ?? '', currentShow: currentShow?.title ?? '' })}
        </Alert>
      </Snackbar>
      {/* A peer is navigating a different version of the show, so its indices were refused.
          Silently dropping them would leave the footswitch looking broken instead of
          out of date. (With auto-refresh on we reload instead and never get here.) */}
      <Snackbar open={!!syncMismatch} anchorOrigin={{ vertical: 'top', horizontal: 'center' }} sx={{ top: { xs: 72, sm: 80 } }}>
        <Alert
          severity="warning"
          action={
            <Stack direction="row" spacing={1}>
              <Button color="inherit" size="small" onClick={() => setSyncMismatch(null)}>
                {LL.CONNECTIVITY.SNACK_DISMISS()}
              </Button>
              <Button
                color="inherit"
                size="small"
                onClick={() => {
                  setSyncMismatch(null);
                  void handleRefreshContent();
                }}
              >
                {LL.REMOTE.SYNC_RELOAD()}
              </Button>
            </Stack>
          }
          onClose={() => setSyncMismatch(null)}
        >
          {LL.REMOTE.SYNC_STALE_MUSICIAN()}
        </Alert>
      </Snackbar>
      {/* Operator cleared the connected clients — we deliberately do not auto-reconnect,
          so the musician decides when to come back. */}
      <Snackbar open={wsStatus === 'dropped_by_operator'} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
        <Alert
          severity="info"
          action={
            <Button color="inherit" size="small" onClick={wsReconnect}>
              {LL.CONNECTIVITY.RECONNECT()}
            </Button>
          }
        >
          {LL.CONNECTIVITY.DROPPED_BY_OPERATOR()}
        </Alert>
      </Snackbar>
      <Snackbar
        open={remoteCommandFailed}
        autoHideDuration={4000}
        onClose={() => setRemoteCommandFailed(false)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert severity="warning" onClose={() => setRemoteCommandFailed(false)}>
          {LL.REMOTE.COMMAND_NOT_SENT()}
        </Alert>
      </Snackbar>
      {/* PDF Upload dialog — always available for song items */}
      {activeSongNumber != null && (
        <PdfUploadModal
          songNumber={activeSongNumber}
          open={pdfUploadOpen}
          onClose={() => setPdfUploadOpen(false)}
          musicianNames={musicianNames}
          selectedPdf={pdfOverrideFilename || pdfViewer.resolvedFilename}
          onSelectPdf={(f) => setPdfOverrideFilename(f)}
          onOpenAreaMapping={() => {
            trackEvent('musician_mapping_used', undefined, undefined, { type: 'area' });
            trackEvent('modal_opened', undefined, undefined, { modal: 'area_mapping' });
            setAreaMappingOpen(true);
          }}
          ctSongName={ctSongName}
        />
      )}
      {/* PDF Area Mapping editor */}
      {pdfViewer.pdfUrl && (
        <PdfAreaMappingEditor
          open={areaMappingOpen}
          onClose={() => setAreaMappingOpen(false)}
          pdfUrl={pdfViewer.pdfUrl}
          blockNames={activeSongBlocks}
          blockLines={activeSongBlockLines}
          initialMappings={pdfViewer.areaMappings}
          onSave={pdfViewer.handleSaveAreaMappings}
        />
      )}
      {/* Remote control (MIDI + keyboard) mapping dialog */}
      <RemoteControlDialog open={midiOpen} onClose={() => setMidiOpen(false)} onAction={handleRemoteAction} keyboard={keyboardRemote} />
      {/* Settings drawer */}
      <MusicianSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        musicianName={musicianName}
        musicianBand={musicianBand}
        annotationLayer={annotationLayer}
        musicianTheme={musicianTheme}
        defaultPageView={defaultPageView}
        blockIndicator={blockIndicator}
        textSize={textSize}
        showFooter={showFooter}
        mixerCompact={mixerCompact}
        mixerAvailable={mixerAvailable}
        musicianNames={musicianNames}
        availableBands={availableBands}
        setQrOpen={(open) => {
          if (open) trackEvent('modal_opened', undefined, undefined, { modal: 'qr_share' });
          setQrOpen(open);
        }}
        setPdfUploadOpen={setPdfUploadOpen}
        onOpenMidiSettings={() => {
          trackEvent('modal_opened', undefined, undefined, { modal: 'midi_learn' });
          setMidiOpen(true);
        }}
      />
      {/* Main layout */}
      <Stack direction="row" sx={{ height: '100dvh', overflow: 'hidden', position: 'relative' }}>
        {/* Sidebar */}
        <MusicianSidebar
          open={sidebarOpen}
          activeItemIndex={activeItemIndex}
          operatorActiveIndex={operatorItemIndex}
          onSelectItem={handleUserSelectItem}
          onOpenPdfModal={() => {
            trackEvent('modal_opened', undefined, undefined, { modal: 'pdf_manage' });
            // When CT is enabled, resolve the CT song ID from the active song title
            if (churchToolsEnabled && activeSong && !ctSongId) {
              void searchCtSongs({ q: activeSong.title, limit: 1 }).then((res) => {
                const first = res.data?.songs?.[0];
                if (first) {
                  setCtSongId(first.id);
                  setCtSongName(first.name);
                }
              });
            }
            setPdfUploadOpen(true);
          }}
          onClose={handleToggleSidebar}
          onActiveIndexChange={(index) => {
            // Passive follow after a group/drag reorder — the same item just sits elsewhere
            // in the order now, so don't touch sync mode the way a user selection would.
            setActiveItemIndex(index);
            updateMusicianSetting('musicianLastItemIndex', index);
          }}
        />

        {/* Content area */}
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
            // Push content above mobile system navigation bars (Android gesture bar,
            // iOS home indicator) without affecting desktop where safe-area-inset-bottom is 0.
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          {/* Floating toolbar */}
          <MusicianToolbar
            sidebarOpen={sidebarOpen}
            onToggleSidebar={handleToggleSidebar}
            syncMode={syncMode}
            onSetSyncMode={handleSetSyncMode}
            wsStatus={wsStatus}
            onOpenSettings={() => {
              trackEvent('modal_opened', undefined, undefined, { modal: 'musician_settings' });
              setSettingsOpen(true);
            }}
            onOpenPdfModal={() => {
              trackEvent('modal_opened', undefined, undefined, { modal: 'pdf_manage' });
              if (churchToolsEnabled && activeSong && !ctSongId) {
                void searchCtSongs({ q: activeSong.title, limit: 1 }).then((res) => {
                  const first = res.data?.songs?.[0];
                  if (first) {
                    setCtSongId(first.id);
                    setCtSongName(first.name);
                  }
                });
              }
              setPdfUploadOpen(true);
            }}
            isSongItem={isSongItem}
            activeSongNumber={activeSongNumber}
            pageView={pdfViewer.pageView}
            onSetPageView={pdfViewer.handleSetPageView}
            zoomLevel={pdfViewer.zoomLevel}
            onZoomIn={pdfViewer.handleZoomIn}
            onZoomOut={pdfViewer.handleZoomOut}
            onZoomReset={pdfViewer.handleZoomReset}
            onZoomFitWidth={pdfViewer.handleZoomFitWidth}
            annotateMode={annotateMode}
            onToggleAnnotate={() => setAnnotateMode((a) => !a)}
            hasPdfs={hasPdfs}
            onRefetchAnnotations={() => annotationRefetchRef.current?.()}
            onRefreshContent={() => void handleRefreshContent()}
            autoRefresh={autoRefresh}
            onToggleAutoRefresh={handleToggleAutoRefresh}
            orderEditorOpen={orderEditorOpen}
            onToggleOrderEditor={() => setOrderEditorOpen((prev) => !prev)}
            mixerAvailable={mixerAvailable}
            mixerOpen={mixerOpen}
            onToggleMixer={() => {
              setMixerOpen((open) => {
                if (!open) trackEvent('modal_opened', undefined, undefined, { modal: 'monitor_mixer' });
                return !open;
              });
            }}
          />

          <MixerLauncher open={mixerOpen} bridge={mixerBridge} announcement={mixerAnnouncement} onClose={() => setMixerOpen(false)} />

          {/* Main content */}
          {!currentShow ? (
            <Stack
              sx={{
                alignItems: 'center',
                justifyContent: 'center',
                flex: 1,
                p: 4,
              }}
            >
              <Typography
                variant="h6"
                sx={{
                  color: 'text.secondary',
                  mb: 2,
                }}
              >
                {LL.MUSICIAN.NO_SHOW()}
              </Typography>
              <Button variant="contained" onClick={() => dispatch(closeShowSelector())}>
                {LL.MUSICIAN.SELECT_SHOW()}
              </Button>
            </Stack>
          ) : !activeItem ? (
            <Stack
              sx={{
                alignItems: 'center',
                justifyContent: 'center',
                flex: 1,
                p: 4,
              }}
            >
              <CircularProgress />
            </Stack>
          ) : isSongItem && hasPdfs ? (
            /* PDF view for songs with PDFs */
            <PdfView
              pdfUrl={pdfViewer.pdfUrl}
              pdfContainerRef={pdfViewer.pdfContainerRef}
              currentPage={pdfViewer.currentPage}
              numPages={pdfViewer.numPages}
              zoomLevel={pdfViewer.zoomLevel}
              pageView={pdfViewer.pageView}
              pageBaseWidth={pdfViewer.pageBaseWidth}
              annotateMode={annotateMode}
              onDocumentLoadSuccess={pdfViewer.onDocumentLoadSuccess}
              onDocumentLoadError={() => pdfViewer.setPdfLoadError(true)}
              musicianName={musicianName}
              annotationLayer={annotationLayer}
              activeSongNumber={activeSongNumber}
              activeSongName={activeSong?.title}
              showFooter={showFooter}
              resolvedFilename={pdfViewer.resolvedFilename}
              stableResolvedFilename={pdfViewer.stableResolvedFilename}
              availableFilenames={pdfViewer.availableFilenames}
              onSelectPdf={(f) => setPdfOverrideFilename(f)}
              onOpenPdfModal={() => setPdfUploadOpen(true)}
              onZoomIn={pdfViewer.handleZoomIn}
              onZoomOut={pdfViewer.handleZoomOut}
              onZoomReset={pdfViewer.handleZoomReset}
              onZoomFitWidth={pdfViewer.handleZoomFitWidth}
              onZoomSync={pdfViewer.setZoomLevel}
              onRegisterRefetch={handleRegisterRefetch}
              activeBlockAreaMapping={activeBlockAreaMapping}
              nextBlockAreaMapping={nextBlockAreaMapping}
              allBlockAreaMappings={pdfViewer.areaMappings}
              isSynced={isSynced}
              activeBlockIndex={operatorActiveBlockIndex}
              orderedBlockNames={lyricsBlocks.map((block) => block.name)}
              onMappingClick={syncMode === 'midi' && !annotateMode ? handleMappingBlockClick : undefined}
            />
          ) : isSongItem && activeSong ? (
            /* Lyrics fallback for songs without PDFs */
            <LyricsView
              activeSongNumber={activeSongNumber}
              activeKey={activeKey}
              lyricsBlocks={lyricsBlocks}
              isSynced={isSynced}
              operatorActiveBlockIndex={operatorActiveBlockIndex}
              pageView={pdfViewer.pageView}
              textSize={textSize}
              showFooter={showFooter}
              activeSong={activeSong}
              setPdfUploadOpen={setPdfUploadOpen}
            />
          ) : (
            /* Non-song items — placeholder */
            <Stack
              sx={{
                alignItems: 'center',
                justifyContent: 'center',
                flex: 1,
                p: 4,
                opacity: 0.5,
              }}
            >
              <Typography
                variant="body1"
                sx={{
                  color: 'text.secondary',
                }}
              >
                {activeItem.label || activeItem.bibleRef || 'Media'}
              </Typography>
            </Stack>
          )}

          {orderEditorOpen && isSongItem && activeSong && (
            <Box
              sx={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: `calc(${showFooter ? 64 : 16}px + env(safe-area-inset-bottom, 0px))`,
                zIndex: 12,
                // Narrow screens wrap the order into a single column, which makes this
                // overlay tall — keep it clear of the side margins and the nav buttons.
                px: { xs: 1, sm: `${NAV_MARGIN}px` },
                display: 'flex',
                justifyContent: 'center',
                // The wrapper spans the full width; only the editor itself may take clicks,
                // so the empty areas beside it never block the floating toolbar/nav buttons.
                pointerEvents: 'none',
              }}
            >
              <Stack sx={{ width: 'min(1100px, 100%)', pointerEvents: 'auto' }}>
                <SongOrderEditor
                  orders={orderEditorOrders}
                  currentOrder={orderEditorName}
                  order={orderEditor}
                  availableBlocks={Object.keys(activeSong.blocks ?? {})}
                  selectedBlockName={lyricsBlocks[operatorActiveBlockIndex]?.name}
                  onSelectBlock={handleOrderTagSelect}
                  showOrderControls={false}
                  centerChips
                  activeChipColor="secondary"
                  selectedOrderIndex={operatorActiveBlockIndex}
                  inactiveChipSx={{
                    bgcolor: 'grey.900',
                    color: '#fff',
                    '& .MuiChip-deleteIcon': { color: 'rgba(255,255,255,0.75)' },
                    '&:hover': { bgcolor: 'grey.800' },
                  }}
                  onChange={({ orders: nextOrders, currentOrder: nextCurrentOrder, order: nextOrder }) => {
                    setOrderEditorOrders(nextOrders);
                    setOrderEditorName(nextCurrentOrder);
                    setOrderEditor(nextOrder);
                    setOrderEditorDirty(true);
                  }}
                />
                <Stack direction="row" sx={{ justifyContent: 'center', gap: 1, mt: { xs: 0.5, sm: 1 } }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => {
                      const sourceOrders =
                        activeSong.order && Object.keys(activeSong.order).length > 0
                          ? activeSong.order
                          : {
                              Default: activeSong.initialOrder ?? [],
                            };
                      const selectedOrderName = sourceOrders[activeSongOrder]
                        ? activeSongOrder
                        : (Object.keys(sourceOrders)[0] ?? 'Default');
                      setOrderEditorOrders(sourceOrders);
                      setOrderEditorName(selectedOrderName);
                      setOrderEditor(sourceOrders[selectedOrderName] ?? []);
                      setOrderEditorDirty(false);
                    }}
                    disabled={orderEditorSaving || !orderEditorDirty}
                  >
                    {LL.COMMON.CANCEL()}
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    onClick={() => void handleSaveOrderEditor()}
                    disabled={orderEditorSaving || !orderEditorDirty}
                  >
                    {LL.COMMON.SAVE()}
                  </Button>
                </Stack>
              </Stack>
            </Box>
          )}

          {/* Floating navigation buttons — bottom corners.
               Hidden when annotateMode is active so they don't intercept drawing events. */}
          {/* Left group: prev page + prev song [+ prev block in midi mode] */}
          <Stack
            direction="row"
            spacing={0.75}
            sx={{
              position: 'absolute',
              left: NAV_MARGIN,
              bottom: `calc(${NAV_MARGIN}px + env(safe-area-inset-bottom, 0px))`,
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            <Tooltip title={LL.MUSICIAN.PREV_PAGE()} placement="top">
              <IconButton
                onClick={() => canGoPrevPage && pdfViewer.setCurrentPage(pdfViewer.currentPage - 1)}
                size="small"
                sx={{
                  ...floatingBtnSx(palette),
                  opacity: canGoPrevPage ? 1 : 0.15,
                  pointerEvents: canGoPrevPage ? 'auto' : 'none',
                }}
              >
                <PrevPageIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={LL.MUSICIAN.PREV_SONG()} placement="top">
              <IconButton
                onClick={() => canGoPrev && handleManualNav(activeItemIndex - 1)}
                size="small"
                sx={{
                  ...floatingBtnSx(palette),
                  opacity: canGoPrev ? 1 : 0.15,
                  pointerEvents: canGoPrev ? 'auto' : 'none',
                }}
              >
                <PrevSongIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            {syncMode === 'midi' && (
              <Tooltip title={LL.MUSICIAN.PREV_BLOCK()} placement="top">
                <IconButton
                  onClick={() => handleMidiAction('prev_block')}
                  size="small"
                  sx={{
                    ...floatingBtnSx(palette),
                    opacity: operatorActiveBlockIndex > 0 ? 1 : 0.15,
                    pointerEvents: operatorActiveBlockIndex > 0 ? 'auto' : 'none',
                  }}
                >
                  <PrevBlockIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Stack>

          {/* Right group: [next block in midi mode +] next song + next page */}
          <Stack
            direction="row"
            spacing={0.75}
            sx={{
              position: 'absolute',
              right: NAV_MARGIN,
              bottom: NAV_MARGIN,
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            {syncMode === 'midi' && (
              <Tooltip title={LL.MUSICIAN.NEXT_BLOCK()} placement="top">
                <IconButton
                  onClick={() => handleMidiAction('next_block')}
                  size="small"
                  sx={{
                    ...floatingBtnSx(palette),
                    opacity: operatorActiveBlockIndex < lyricsBlocks.length - 1 ? 1 : 0.15,
                    pointerEvents: operatorActiveBlockIndex < lyricsBlocks.length - 1 ? 'auto' : 'none',
                  }}
                >
                  <NextBlockIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title={LL.MUSICIAN.NEXT_SONG()} placement="top">
              <IconButton
                onClick={() => canGoNext && handleManualNav(activeItemIndex + 1)}
                size="small"
                sx={{
                  ...floatingBtnSx(palette),
                  opacity: canGoNext ? 1 : 0.15,
                  pointerEvents: canGoNext ? 'auto' : 'none',
                }}
              >
                <NextSongIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={LL.MUSICIAN.NEXT_PAGE()} placement="top">
              <IconButton
                onClick={() => canGoNextPage && pdfViewer.setCurrentPage(pdfViewer.currentPage + 1)}
                size="small"
                sx={{
                  ...floatingBtnSx(palette),
                  opacity: canGoNextPage ? 1 : 0.15,
                  pointerEvents: canGoNextPage ? 'auto' : 'none',
                }}
              >
                <NextPageIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>
      </Stack>
    </>
  );
};
