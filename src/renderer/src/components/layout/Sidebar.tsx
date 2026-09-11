import { forwardRef, useEffect, useImperativeHandle, useRef, useState, MouseEvent, ChangeEvent } from 'react';
import {
  Alert,
  Box,
  Chip,
  Divider,
  IconButton,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Skeleton,
  Snackbar,
  Stack,
  Typography,
  useTheme,
  MenuItem,
  Menu,
  Badge,
  Tooltip,
} from '@mui/material';
import {
  Search as SearchIcon,
  Add as AddIcon,
  ViewList as ViewListIcon,
  Delete as DeleteIcon,
  Settings as SettingsIcon,
  Edit as EditIcon,
  DriveFileRenameOutline as RenameIcon,
  MusicNote as MusicNoteIcon,
  Image as ImageIcon,
  MenuBook as MenuBookIcon,
  Save as SaveIcon,
  Palette as PaletteIcon,
  AccountCircle as AccountCircleIcon,
  Logout as LogoutIcon,
  RestartAlt as ResetIcon,
  PictureAsPdf as PdfIcon,
  AdminPanelSettings as AdminIcon,
  MoreVert as MoreVertIcon,
  ChevronRight as ChevronRightIcon,
  FolderOpen as FolderOpenIcon,
  Folder as FolderIcon,
  CreateNewFolder as NewGroupIcon,
  Circle as CircleIcon,
  FileUpload as FileUploadIcon,
  Sync as SyncIcon,
  Smartphone as SmartphoneIcon,
  QueueMusic as SetListIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useI18nContext } from '@/i18n/i18n-react';
import type { ISong } from '@/song';
import { Song } from '@/song';
import { CCLISong } from '@/song';
import { SngSong } from '@/song';
import { Settings } from '@/components/settings/Settings';
import { SongEditor } from '@/components/song/SongEditor';
import { QuickOrderDialog } from '@/components/song/QuickOrderDialog';
import { SongLibrary } from '@/components/song/SongLibrary';
import { Shows } from '@/components/show/Shows';
import { BibleVersePicker } from '@/components/search/BibleVersePicker';
import { MediaBrowser } from '@/components/media/MediaBrowser';
import { getShowItemIcon, getShowItemColor } from '@/utils/showItemIcons';
import { UnifiedSearch } from '@/components/search/UnifiedSearch';
import { useAppDispatch } from '@/store';
import {
  setCurrentShow,
  addShowItem,
  removeShowItem,
  setDirty,
  updateShowItem,
  setShowGroups,
  setOrderAndGroups,
  useGetShow,
} from '@/store/showSlice';
import { ShowGroupList, GroupNameDialog } from '@/components/show/ShowGroupList';
import {
  genGroupId,
  addGroup as addGroupUtil,
  updateGroup,
  toggleGroupCollapsed,
  reorderGroups as reorderGroupsUtil,
  deleteGroup as deleteGroupUtil,
  moveItemFlat,
  moveItemToGroup as moveItemToGroupUtil,
  groupDisplayName,
} from '@/utils/showGroups';
import {
  addSongToStore,
  updateSongInStore,
  setSongsOrder as setSongsOrderAction,
  addToSongsOrder,
  setSongOrders as setSongOrdersAction,
  setCurrentSongOrder as setCurrentSongOrderAction,
  useGetSongs,
} from '@/store/songsSlice';
import { setActiveItemIndex, setKeyboardDisabled, useGetPresentationSettings } from '@/store/presentationSlice';
import type { Show, ShowItem, MediaSubType } from '@/api/shows.api';
import type { SongListItem } from '@/api/songs.api';
import { useSaveShowMutation } from '@/api/shows.api';
import { useGetStylesQuery } from '@/api/styles.api';
import { useGetSessionQuery } from '@/api/session.api';
import { useLazyGetSongQuery, useCreateSongMutation, useUpdateSongMutation } from '@/api/songs.api';
import { useMetrics } from '@/hooks/useMetrics';
import { useCcliSongImport } from '@/hooks/useCcliSongImport';
import { useImportLanguage } from '@/hooks/useImportLanguage';
import { useSongUpdatePoller } from '@/hooks/useSongUpdatePoller';
import { useGetMusicianSettings } from '@/store/musicianSlice';
import { loadShowSongs } from '@/store/songsSlice';
import { StyleEditor, StyleGalleryThumb } from '@/components/style/StyleEditor';
import { WindowManager } from '@/components/layout/WindowManager';
import { SetListManager } from '@/components/setlist/SetListManager';
import { MUSICAL_KEYS, parseOrderKey } from '@/utils/orderKeyUtils';
import { useGetSettings } from '@/store/settingsSlice';
import { useGetWindows } from '@/store/windowSlice';
import { useLogout } from '@/hooks/useLogout';
import { LogoutResetDialog } from '@/components/layout/LogoutResetDialog';
import { DEFAULT_SONG_ITEM_COLOR, DEFAULT_MEDIA_ITEM_COLOR, DEFAULT_BIBLE_ITEM_COLOR } from '@/theme';

export interface SidebarHandle {
  openShowSwitcher: () => void;
  openSearch: () => void;
  openAddMenu: (anchor: HTMLElement) => void;
  openMediaBrowser: (subType?: 'image' | 'video') => void;
  openBiblePicker: () => void;
}

const Sidebar = forwardRef<SidebarHandle>((_, ref) => {
  const { palette } = useTheme();
  const navigate = useNavigate();

  const { songClick } = useGetSettings();
  const { currentShow, isDirty } = useGetShow();

  const dispatch = useAppDispatch();

  // Redux state
  const { activeItemIndex } = useGetPresentationSettings();
  const { songs } = useGetSongs();

  const { LL } = useI18nContext();
  const { trackEvent } = useMetrics();

  const [openSettings, _setOpenSettings] = useState(false);
  const [openSongEditor, _setOpenSongEditor] = useState(false);
  const [openShowSwitcher, _setOpenShowSwitcher] = useState(false);
  const [openSongSearch, setOpenSongSearch] = useState(false);
  const [openSongLibrary, _setOpenSongLibrary] = useState(false);
  const [openBiblePicker, _setOpenBiblePicker] = useState(false);
  const [openMediaBrowser, _setOpenMediaBrowser] = useState(false);
  const [mediaBrowserPickType, setMediaBrowserPickType] = useState<'image' | 'video' | 'any'>('any');
  const [songToEdit, _setSongToEdit] = useState<ISong>();
  const [styleEditorOpen, setStyleEditorOpen] = useState(false);
  /** When set, the StyleEditor opens directly in edit view for this style (direct edit from item menus). */
  const [styleEditorEditId, setStyleEditorEditId] = useState<number | undefined>(undefined);
  const [windowManagerOpen, setWindowManagerOpen] = useState(false);
  const [setListsOpen, setSetListsOpen] = useState(false);
  /** Error message shown when a song file import fails. */
  const [importErrorMsg, setImportErrorMsg] = useState<string | null>(null);
  /** Result notification for the ChurchTools event-agenda sync on save. */
  const [syncMsg, setSyncMsg] = useState<{ severity: 'success' | 'warning'; text: string } | null>(null);
  const [accountMenuAnchor, setAccountMenuAnchor] = useState<null | HTMLElement>(null);

  const { data: session } = useGetSessionQuery();
  // The account name is what the user picks on the login page, so it is the more
  // recognisable label here; the mail address is only a fallback for accounts without one.
  const accountLabel = session?.name || session?.mail || '';
  const bibleEnabled = session?.settings?.bibleEnabled ?? false;
  const churchToolsEnabled = session?.settings?.churchToolsEnabled ?? false;
  // Detect songs that were changed on the server since they were cached locally.
  // While following remote commands nobody is at this screen to confirm, so adopt them directly.
  const { midiTrackingMaster } = useGetMusicianSettings();
  const { updatedSongNumbers, reloadSong } = useSongUpdatePoller({ autoReload: midiTrackingMaster === 'midi' });
  const [fetchSong] = useLazyGetSongQuery();

  // Add menu
  const [addMenuAnchor, setAddMenuAnchor] = useState<null | HTMLElement>(null);
  const addMenuOpen = Boolean(addMenuAnchor);
  // "Add group" dialog (opened from the add menu)
  const [addGroupDialogOpen, setAddGroupDialogOpen] = useState(false);

  useImperativeHandle(ref, () => ({
    openShowSwitcher: () => setOpenShowSwitcher(true),
    openSearch: () => setOpenSongSearch(true),
    openAddMenu: (anchor: HTMLElement) => setAddMenuAnchor(anchor),
    openMediaBrowser: (subType?: 'image' | 'video') => {
      setMediaBrowserPickType(subType ?? 'any');
      setOpenMediaBrowser(true);
    },
    openBiblePicker: () => setOpenBiblePicker(true),
  }));

  const [saveShowMutation] = useSaveShowMutation();
  const [createSongMutation] = useCreateSongMutation();
  const [updateSongMutation] = useUpdateSongMutation();
  const { resolveImportLanguage, importLanguageDialog } = useImportLanguage();
  const importCcliSong = useCcliSongImport(resolveImportLanguage);
  // True while a CCLI SongSelect import is resolving — drives a placeholder row in the list.
  const [isImportingCcli, setIsImportingCcli] = useState(false);
  const { data: availableStyles = [] } = useGetStylesQuery();

  /**
   * Import a CCLI SongSelect suggestion into the local library and add it to the show.
   * The CCLI number is used as the song number; if a song with that CCLI number already
   * exists locally it is added directly without re-importing. Author/copyright come from
   * the search result; lyrics (when available) are resolved via the CCLI detail endpoint.
   */
  const handleChurchToolsSongSelected = async (
    ccliNumber: number,
    name: string,
    meta?: { author?: string | null; copyright?: string | null },
  ) => {
    setOpenSongSearch(false);
    setIsImportingCcli(true);
    try {
      const res = await importCcliSong(ccliNumber, name, meta);
      if (!res.ok) {
        setImportErrorMsg(
          `${name}: ${res.isDuplicate ? LL.SONGS.IMPORT_ERROR_DUPLICATE() : LL.SONGS.IMPORT_ERROR()}${res.serverMessage && !res.isDuplicate ? ` (${res.serverMessage})` : ''}`,
        );
      }
    } finally {
      setIsImportingCcli(false);
    }
  };

  // Item context menu state
  const [itemMenuAnchor, setItemMenuAnchor] = useState<null | HTMLElement>(null);
  const [itemMenuIndex, setItemMenuIndex] = useState<number>(-1);
  const [keySubmenuAnchor, setKeySubmenuAnchor] = useState<null | HTMLElement>(null);
  // "Rename" dialog for media items (index captured before the menu closes)
  const [renameIndex, setRenameIndex] = useState<number>(-1);
  const [orderSubmenuAnchor, setOrderSubmenuAnchor] = useState<null | HTMLElement>(null);
  // Direct item style submenu (sets item.styleId — applies to all windows)
  const [itemStyleAnchor, setItemStyleAnchor] = useState<null | HTMLElement>(null);
  // Item-style nested submenus: window list -> style list (per chosen window)
  const [itemStyleWinAnchor, setItemStyleWinAnchor] = useState<null | HTMLElement>(null);
  const [itemStyleStyleAnchor, setItemStyleStyleAnchor] = useState<null | HTMLElement>(null);
  const [itemStyleWindowName, setItemStyleWindowName] = useState<string>('');
  // "Move to group" submenu (from the item context menu).
  const [groupSubmenuAnchor, setGroupSubmenuAnchor] = useState<null | HTMLElement>(null);
  const [quickOrderDialogOpen, setQuickOrderDialogOpen] = useState(false);
  const [quickOrderContext, setQuickOrderContext] = useState<{ itemIndex: number; songNumber: number; orderName: string } | null>(null);

  // Window names available for per-item style overrides (from the footer's saved configs)
  const { windowConfigs: savedWindowConfigs } = useGetWindows();

  const windowNames = (savedWindowConfigs || []).map((c) => (c?.name || '').trim()).filter((n) => n.length > 0);

  const logout = useLogout();
  const [logoutResetOpen, setLogoutResetOpen] = useState(false);

  const handleLogout = () => {
    setAccountMenuAnchor(null);
    logout();
  };

  const handleSaveShow = async () => {
    if (!currentShow) return;
    try {
      // Don't send eventId here — this isn't where the event link is chosen, so omitting it
      // lets the backend preserve the existing link (only the event picker dialogs change it).
      // The save endpoint reconciles the linked event's agenda itself (every save → in sync).
      const result = await saveShowMutation({
        title: currentShow.title,
        order: currentShow.order,
        groups: currentShow.groups,
        styleId: currentShow.styleId ?? null,
      }).unwrap();
      dispatch(setDirty(false));
      trackEvent('show_saved', 'show', currentShow.title);

      const eventSync = result.eventSync;
      if (eventSync) {
        setSyncMsg(
          eventSync.ok
            ? { severity: 'success', text: LL.SHOWS.EVENT_SYNCED() }
            : { severity: 'warning', text: LL.SHOWS.EVENT_SYNC_FAILED() },
        );
      }
    } catch (error) {
      console.error('Failed to save show:', error);
    }
  };

  // Disable keyboard navigation when dialogs are open
  useEffect(() => {
    dispatch(setKeyboardDisabled(openSongSearch || openBiblePicker || openMediaBrowser));
  }, [openSongSearch, openBiblePicker, openMediaBrowser, dispatch]);

  const setOpenSettings = (open: boolean) => {
    _setOpenSettings(open);
    dispatch(setKeyboardDisabled(open));
  };

  const setOpenSongEditor = (open: boolean) => {
    _setOpenSongEditor(open);
    dispatch(setKeyboardDisabled(open));
  };

  const setOpenShowSwitcher = (open: boolean) => {
    _setOpenShowSwitcher(open);
    dispatch(setKeyboardDisabled(open));
  };

  const setOpenSongLibrary = (open: boolean) => {
    _setOpenSongLibrary(open);
    dispatch(setKeyboardDisabled(open));
  };

  const setOpenBiblePicker = (open: boolean) => {
    _setOpenBiblePicker(open);
    dispatch(setKeyboardDisabled(open));
  };

  const setOpenMediaBrowser = (open: boolean) => {
    _setOpenMediaBrowser(open);
    dispatch(setKeyboardDisabled(open));
  };

  const setSongToEdit = (song: ISong) => {
    _setSongToEdit(song);
    setOpenSongEditor(true);
  };

  const handleSongSelected = async (song: SongListItem) => {
    try {
      const result = await fetchSong({ songNumber: song.songNumber });
      const fullSong = result.data;

      if (fullSong) {
        const songToAdd = new Song({
          songNumber: fullSong.songNumber,
          title: fullSong.title,
          authors: fullSong.authors,
          copyright: fullSong.copyright,
          initialOrder: fullSong.initialOrder,
          order: fullSong.order,
          blocks: fullSong.blocks,
          background: fullSong.background,
          css: fullSong.css,
        });

        dispatch(addSongToStore(songToAdd));
        dispatch(addToSongsOrder(songToAdd.songNumber));
        dispatch(
          addShowItem({
            type: 'song',
            songNumber: songToAdd.songNumber,
            order: 'Default',
          }),
        );

        trackEvent('song_selected', 'song', String(songToAdd.songNumber), { title: songToAdd.title });
        setOpenSongSearch(false);
      }
    } catch (error) {
      console.error('Failed to fetch song:', error);
    }
  };

  const handleBibleVerseAdd = (bibleRef: string, bibleTranslation: string, label: string) => {
    dispatch(
      addShowItem({
        type: 'bible_verse',
        bibleRef,
        bibleTranslation,
        label,
      }),
    );
    trackEvent('bible_verse_added', 'bible', bibleRef);
  };

  const handleMediaAdd = (mediaSubType: MediaSubType, mediaPath?: string, mediaColor?: string, label?: string) => {
    dispatch(
      addShowItem({
        type: 'media',
        mediaSubType,
        mediaColor,
        mediaPath,
        // A name given on add wins; otherwise the path/color doubles as the label.
        label: label || (mediaSubType === 'color' ? mediaColor : mediaPath),
      }),
    );
    trackEvent('media_added', 'media', mediaPath || mediaColor);
  };

  const handleShowSwitch = async (show: Show | null, isNew: boolean, override?: boolean) => {
    if (show) {
      if (isNew || override) {
        try {
          const orderToSave: ShowItem[] = override ? (currentShow?.order ?? []) : [];

          await saveShowMutation({
            title: show.title,
            order: orderToSave,
            groups: override ? currentShow?.groups : show.groups,
            styleId: override ? (currentShow?.styleId ?? null) : (show.styleId ?? null),
            eventId: (override ? currentShow?.eventId : show.eventId) ?? null,
            eventName: (override ? currentShow?.eventName : show.eventName) ?? null,
            // Sent on creation so a show made with bands keeps them; the later auto-saves
            // omit the field entirely, which is what preserves them.
            bandIds: (override ? currentShow?.bandIds : show.bandIds) ?? [],
          }).unwrap();
        } catch (error) {
          console.error('Failed to create new show:', error);
          return;
        }
      }

      dispatch(setCurrentShow(show));
      dispatch(setActiveItemIndex(0));

      if (!isNew && !override) {
        await dispatch(loadShowSongs(show));
      } else if (!override) {
        dispatch(setSongsOrderAction([]));
        dispatch(setSongOrdersAction({}));
      }
    }
  };

  /** Returns true for files this sidebar can import (CCLI .txt or SongBeamer .sng). */
  const isSupportedSongFile = (file: File): boolean =>
    (file.type === 'text/plain' && file.name.endsWith('.txt')) || file.name.endsWith('.sng');

  /** Parse a supported song file into an ISong. */
  const parseSongFile = (file: File, content: string): ISong =>
    file.name.endsWith('.sng') ? SngSong(content) : CCLISong(file.name, content);

  /** Read and import a single supported song file into the store. */
  const importSongFile = (file: File) => {
    // SongBeamer files are often saved in Windows-1252 (CP1252) rather than UTF-8.
    // Strategy: read as UTF-8 first; if the result contains the Unicode replacement
    // character (U+FFFD) indicating a mis-decode, re-read with windows-1252.
    const doImport = async (content: string) => {
      const parsed = parseSongFile(file, content);

      // Imported files do not say what language they are in, so it is read off the lyrics and
      // written onto every line. Only an ambiguous result interrupts with a dialog.
      const resolved = await resolveImportLanguage(parsed.blocks, parsed.title);
      if (!resolved) return;
      parsed.blocks = resolved.blocks;
      parsed.languages = resolved.languages;

      try {
        // Always upload to the backend so it assigns the canonical song number.
        // Omit songNumber entirely — the backend defaults to 0 and auto-generates one.
        const result = await createSongMutation({
          title: parsed.title,
          authors: parsed.authors,
          copyright: parsed.copyright,
          initialOrder: parsed.initialOrder ?? [],
          order: parsed.order,
          blocks: parsed.blocks,
          languages: parsed.languages,
        }).unwrap();

        const savedSong = new Song({ ...parsed, songNumber: result.songNumber });
        dispatch(addSongToStore(savedSong));
        dispatch(addToSongsOrder(savedSong.songNumber));
        dispatch(addShowItem({ type: 'song', songNumber: savedSong.songNumber, order: 'Default' }));
        trackEvent('song_imported', 'song', String(result.songNumber), {
          source: file.name.endsWith('.sng') ? 'sng' : 'ccli_txt',
        });
      } catch (err) {
        console.error('Failed to upload imported song:', err);
        const serverMessage =
          err != null && typeof err === 'object' && 'data' in err
            ? String((err as { data?: { message?: string } }).data?.message ?? '')
            : '';
        // Detect duplicate CCLI number error from the server
        const isDuplicate = serverMessage.toLowerCase().includes('already exists');
        setImportErrorMsg(
          `${file.name}: ${isDuplicate ? LL.SONGS.IMPORT_ERROR_DUPLICATE() : LL.SONGS.IMPORT_ERROR()}${serverMessage && !isDuplicate ? ` (${serverMessage})` : ''}`,
        );
      }
    };

    const reader = new FileReader();
    reader.onload = (ev) => {
      const utf8Result = ev.target?.result?.toString() ?? '';
      if (utf8Result.includes('\uFFFD') && file.name.endsWith('.sng')) {
        // Re-read with Windows-1252 encoding fallback
        const fallbackReader = new FileReader();
        fallbackReader.onload = (ev2) => void doImport(ev2.target?.result?.toString() ?? '');
        fallbackReader.readAsText(file, 'windows-1252');
      } else {
        void doImport(utf8Result);
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  // Accept any file drag — .sng files may report an empty or non-text MIME type
  // depending on OS, so we must not filter on `item.type` here.
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.items && [...e.dataTransfer.items].some((item) => item.kind === 'file')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.files) {
      const files = [...e.dataTransfer.files].filter(isSupportedSongFile);
      if (files.length > 0) {
        e.preventDefault();
        files.forEach(importSongFile);
      }
    }
  };

  // Show items from the current show
  const showItems = currentShow?.order ?? [];

  // Ref for the hidden file-input used by the drop-zone click handler
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    [...(e.target.files ?? [])].filter(isSupportedSongFile).forEach(importSongFile);
    // Reset so the same file can be re-selected
    e.target.value = '';
  };

  // Get display info for a show item
  const getItemLabel = (item: ShowItem, index: number): string => {
    switch (item.type) {
      case 'song': {
        const song = item.songNumber != null ? songs[item.songNumber] : undefined;
        return song?.title ?? `Song #${item.songNumber ?? index}`;
      }
      case 'bible_verse':
        return item.bibleRef || item.label || LL.BIBLE.VERSE();
      case 'media':
        if (item.mediaSubType === 'color') return item.label || item.mediaColor || LL.MEDIA.COLOR();
        return item.label || item.mediaPath || LL.MEDIA.IMAGE();
      default:
        return `Item ${index + 1}`;
    }
  };

  // ── Item group handlers ──
  const groups = currentShow?.groups ?? [];

  // Drag & drop: move an item within/across groups, keeping the presented item stable.
  const handleMoveItem = (from: number, to: number, targetGroupId: string) => {
    const res = moveItemFlat(showItems, from, to, targetGroupId, activeItemIndex);
    if (res) {
      dispatch(setOrderAndGroups({ order: res.order, groups }));
      dispatch(setActiveItemIndex(res.activeIndex));
    }
  };

  // Drag & drop: move a whole group block to another group's position.
  const handleReorderGroup = (sourceId: string, targetId: string) => {
    const res = reorderGroupsUtil(showItems, groups, sourceId, targetId, activeItemIndex);
    if (res) {
      dispatch(setOrderAndGroups({ order: res.order, groups: res.groups }));
      dispatch(setActiveItemIndex(res.activeIndex));
    }
  };

  const handleToggleGroupCollapse = (id: string) => dispatch(setShowGroups(toggleGroupCollapsed(groups, id)));
  const handleAddGroup = (name: string) => dispatch(setShowGroups(addGroupUtil(groups, { id: genGroupId(), name, collapsed: false })));
  const handleRenameGroup = (id: string, name: string) => dispatch(setShowGroups(updateGroup(groups, id, { name })));
  const handleRecolorGroup = (id: string, color: string | undefined) => dispatch(setShowGroups(updateGroup(groups, id, { color })));

  const handleDeleteGroup = (id: string) => {
    const res = deleteGroupUtil(showItems, groups, id, activeItemIndex);
    if (res) {
      dispatch(setOrderAndGroups({ order: res.order, groups: res.groups }));
      dispatch(setActiveItemIndex(res.activeIndex));
    }
  };

  const handleMoveItemToGroup = (itemIndex: number, groupId: string) => {
    const res = moveItemToGroupUtil(showItems, groups, itemIndex, groupId, activeItemIndex);
    if (res) {
      dispatch(setOrderAndGroups({ order: res.order, groups }));
      dispatch(setActiveItemIndex(res.activeIndex));
    }
  };

  // One item row in the sidebar. `i` is the item's index into the flat order.
  const renderItemRow = (item: ShowItem, i: number) => {
    const ItemIcon = getShowItemIcon(item.type, item.mediaSubType);
    const itemColor = getShowItemColor(item.type);
    const label = getItemLabel(item, i);

    const isSong = item.type === 'song';
    const itemParsed = parseOrderKey(item.order);
    const itemKey = item.key || itemParsed.key;
    const itemOrder = itemParsed.order;

    return (
      <ListItem
        key={i}
        disablePadding
        onClick={() => {
          if (songClick === 'click') dispatch(setActiveItemIndex(i));
        }}
        onDoubleClick={() => {
          if (songClick === 'double-click') dispatch(setActiveItemIndex(i));
        }}
        sx={{
          ...(i === activeItemIndex ? { background: palette.primary.main } : {}),
          '&.dragging': { background: palette.primary.dark },
        }}
      >
        {/* Icon and trailing chips live inside the button so hover/ripple cover the
            whole row, and so a long label ellipsises instead of running under them. */}
        <ListItemButton sx={{ pl: 1, pr: 0.5, minWidth: 0 }}>
          <ListItemIcon sx={{ minWidth: 32 }}>
            <ItemIcon fontSize="small" sx={{ color: i === activeItemIndex ? '#fff' : itemColor }} />
          </ListItemIcon>
          <ListItemText
            title={label}
            primary={label}
            slotProps={{ primary: { noWrap: true, sx: { color: i === activeItemIndex ? '#fff' : undefined } } }}
            sx={{ my: 0, minWidth: 0 }}
          />
          <Stack
            direction="row"
            sx={{
              gap: 0.5,
              ml: 0.5,
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            {/* Read-only chips */}
            {isSong && itemOrder && itemOrder !== 'Default' && (
              <Chip
                label={itemOrder}
                size="small"
                variant="outlined"
                sx={{
                  fontSize: '0.65rem',
                  height: 20,
                  maxWidth: 80,
                  color: i === activeItemIndex ? '#fff' : undefined,
                  borderColor: i === activeItemIndex ? 'rgba(255,255,255,0.5)' : undefined,
                }}
              />
            )}
            {isSong && itemKey && (
              <Chip
                label={itemKey}
                size="small"
                sx={{
                  fontSize: '0.65rem',
                  height: 20,
                  backgroundColor: i === activeItemIndex ? 'rgba(255,255,255,0.3)' : 'primary.main',
                  color: '#fff',
                }}
              />
            )}
            {/* Server-side song update available */}
            {isSong && item.songNumber != null && updatedSongNumbers[item.songNumber] && (
              <Tooltip title={LL.SHOW_ITEMS.SONG_UPDATED()}>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    void reloadSong(item.songNumber!);
                  }}
                  sx={{ p: 0.25 }}
                >
                  <SyncIcon fontSize="small" color="warning" />
                </IconButton>
              </Tooltip>
            )}
            {/* Style badge */}
            {item.styleId && (
              <Tooltip title={availableStyles.find((s) => s.id === item.styleId)?.name || LL.STYLE.STYLE()}>
                <PaletteIcon fontSize="small" sx={{ color: i === activeItemIndex ? '#fff' : 'text.secondary', opacity: 0.7 }} />
              </Tooltip>
            )}
            {/* Per-window style badge */}
            {item.itemStyleByWindow && Object.values(item.itemStyleByWindow).some((v) => v != null) && (
              <Tooltip title={LL.FOOTER.ITEM_STYLE()}>
                <PaletteIcon
                  fontSize="small"
                  sx={{ color: i === activeItemIndex ? 'rgba(255,255,255,0.8)' : 'text.secondary', opacity: 0.8 }}
                />
              </Tooltip>
            )}
            {/* Context menu button */}
            <IconButton size="small" onClick={(e) => handleItemMenuOpen(e, i)} sx={{ p: 0.25 }}>
              <MoreVertIcon fontSize="small" sx={{ color: i === activeItemIndex ? '#fff' : undefined }} />
            </IconButton>
          </Stack>
        </ListItemButton>
      </ListItem>
    );
  };

  // ── Item context menu handlers ──
  const handleItemMenuOpen = (event: MouseEvent<HTMLElement>, index: number) => {
    event.stopPropagation();
    setItemMenuAnchor(event.currentTarget);
    setItemMenuIndex(index);
  };

  const handleItemMenuClose = () => {
    setItemMenuAnchor(null);
    setItemMenuIndex(-1);
    setKeySubmenuAnchor(null);
    setOrderSubmenuAnchor(null);
    setItemStyleAnchor(null);
    setItemStyleWinAnchor(null);
    setItemStyleStyleAnchor(null);
    setItemStyleWindowName('');
    setGroupSubmenuAnchor(null);
  };

  /** Assign a style directly to the item (all windows) and persist the show. */
  const handleItemSetStyle = async (styleId: number | undefined) => {
    if (itemMenuIndex >= 0) {
      dispatch(updateShowItem({ index: itemMenuIndex, item: { styleId } }));
      const nextShowOrder = showItems.map((showItem, idx) => (idx === itemMenuIndex ? { ...showItem, styleId } : showItem));
      await saveCurrentShow(nextShowOrder);
    }
    handleItemMenuClose();
  };

  /** Open the StyleEditor directly in edit view for the given style (from item style submenus). */
  const handleEditStyleDirect = (styleId: number) => {
    handleItemMenuClose();
    setStyleEditorEditId(styleId);
    setStyleEditorOpen(true);
  };

  const handleItemSetStyleForWindow = (styleId: number | null) => {
    if (itemMenuIndex >= 0 && itemStyleWindowName) {
      const item = showItems[itemMenuIndex];
      const next: Record<string, number | null> = { ...(item.itemStyleByWindow || {}) };
      next[itemStyleWindowName] = styleId;
      dispatch(updateShowItem({ index: itemMenuIndex, item: { itemStyleByWindow: next } }));
    }
    handleItemMenuClose();
  };

  const handleItemRemove = () => {
    if (itemMenuIndex >= 0) {
      dispatch(removeShowItem(itemMenuIndex));
      if (activeItemIndex > 0 && itemMenuIndex <= activeItemIndex) {
        dispatch(setActiveItemIndex(activeItemIndex - 1));
      }
    }
    handleItemMenuClose();
  };

  /** Give a media item a short display name (empty resets it to the path/URL). */
  const handleItemRename = (name: string) => {
    if (renameIndex < 0) return;
    const item = showItems[renameIndex];
    const fallback = item?.mediaSubType === 'color' ? item.mediaColor : item?.mediaPath;
    dispatch(updateShowItem({ index: renameIndex, item: { label: name || fallback } }));
    setRenameIndex(-1);
  };

  const handleItemSetKey = (key: string | undefined) => {
    if (itemMenuIndex >= 0) {
      dispatch(updateShowItem({ index: itemMenuIndex, item: { key } }));
    }
    setKeySubmenuAnchor(null);
    handleItemMenuClose();
  };

  const saveCurrentShow = async (orderOverride?: ShowItem[]) => {
    if (!currentShow) return;
    try {
      // Omit eventId so the backend preserves the existing ChurchTools event link
      // (this auto-save fires on reorder/key changes, not when choosing an event).
      await saveShowMutation({
        title: currentShow.title,
        order: orderOverride ?? currentShow.order,
        groups: currentShow.groups,
        styleId: currentShow.styleId ?? null,
      }).unwrap();
      dispatch(setDirty(false));
    } catch (error) {
      console.error('Failed to save show:', error);
    }
  };

  const handleItemSetOrder = async (order: string) => {
    if (itemMenuIndex >= 0) {
      const item = showItems[itemMenuIndex];
      if (item.songNumber != null) {
        dispatch(setCurrentSongOrderAction({ songNumber: item.songNumber, orderName: order }));
      }
      dispatch(updateShowItem({ index: itemMenuIndex, item: { order } }));
      const nextShowOrder = showItems.map((showItem, idx) => (idx === itemMenuIndex ? { ...showItem, order } : showItem));
      await saveCurrentShow(nextShowOrder);
    }
    setOrderSubmenuAnchor(null);
    handleItemMenuClose();
  };

  const handleQuickOrderSave = async (orderName: string, nextOrders: Record<string, string[]>) => {
    if (!quickOrderContext) return;
    const sourceSong = songs[quickOrderContext.songNumber];
    if (!sourceSong) return;

    const updatedSong = new Song({
      ...sourceSong,
      order: nextOrders,
      initialOrder: sourceSong.initialOrder,
    });

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
    dispatch(setCurrentSongOrderAction({ songNumber: updatedSong.songNumber, orderName }));
    dispatch(updateShowItem({ index: quickOrderContext.itemIndex, item: { order: orderName } }));
    const nextShowOrder = showItems.map((showItem, idx) =>
      idx === quickOrderContext.itemIndex ? { ...showItem, order: orderName } : showItem,
    );
    await saveCurrentShow(nextShowOrder);
    setQuickOrderDialogOpen(false);
    setQuickOrderContext(null);
  };

  const handleItemEdit = () => {
    const item = itemMenuIndex >= 0 ? showItems[itemMenuIndex] : undefined;
    if (item?.type === 'song' && item.songNumber != null) {
      const song = songs[item.songNumber];
      if (song) setSongToEdit(song);
    }
    handleItemMenuClose();
  };

  // Get context menu item data
  const menuItem = itemMenuIndex >= 0 ? showItems[itemMenuIndex] : undefined;
  const menuItemSong = menuItem?.type === 'song' && menuItem.songNumber != null ? songs[menuItem.songNumber] : undefined;
  const menuItemOrders = menuItemSong?.order ? Object.keys(menuItemSong.order) : [];
  const renameItem = renameIndex >= 0 ? showItems[renameIndex] : undefined;
  const renameFallback = (renameItem?.mediaSubType === 'color' ? renameItem.mediaColor : renameItem?.mediaPath) ?? '';

  return (
    <Stack
      onDragOver={onDragOver}
      onDrop={onDrop}
      sx={{
        // 400px is the desktop column, where the sidebar sits beside the control pane and
        // must not shrink. Below `sm` it is its own full-screen tab, and holding 400 there
        // pushed the toolbar off a 375px screen — the settings gear ended up half visible.
        // The breakpoint matches useIsMobile(), which is what swaps the two layouts.
        width: { xs: '100%', sm: 400 },
        minWidth: { xs: 0, sm: 400 },
        background: palette.background.default,
      }}
    >
      {/* Import error notification */}
      <Snackbar
        open={importErrorMsg !== null}
        autoHideDuration={8000}
        onClose={() => setImportErrorMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" onClose={() => setImportErrorMsg(null)} sx={{ width: '100%' }}>
          {importErrorMsg}
        </Alert>
      </Snackbar>
      {/* ChurchTools event sync notification */}
      <Snackbar
        open={syncMsg !== null}
        autoHideDuration={6000}
        onClose={() => setSyncMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={syncMsg?.severity ?? 'success'} onClose={() => setSyncMsg(null)} sx={{ width: '100%' }}>
          {syncMsg?.text}
        </Alert>
      </Snackbar>
      <Settings open={openSettings} setOpen={setOpenSettings} />
      <SongEditor
        open={openSongEditor}
        setOpen={setOpenSongEditor}
        song={songToEdit}
        onSongCreated={(createdSong) => {
          dispatch(addToSongsOrder(createdSong.songNumber));
          if (currentShow) {
            dispatch(addShowItem({ type: 'song', songNumber: createdSong.songNumber, order: 'Default' }));
          }
        }}
      />
      <SongLibrary
        open={openSongLibrary}
        onClose={() => setOpenSongLibrary(false)}
        onSongSelected={(song) => {
          handleSongSelected(song);
          setOpenSongLibrary(false);
        }}
      />
      <Shows
        open={openShowSwitcher}
        onShowSelected={handleShowSwitch}
        onClose={() => setOpenShowSwitcher(false)}
        allowClose={true}
        currentShowTitle={currentShow?.title}
      />
      <BibleVersePicker open={openBiblePicker} onClose={() => setOpenBiblePicker(false)} onAdd={handleBibleVerseAdd} />
      <MediaBrowser
        open={openMediaBrowser}
        onClose={() => setOpenMediaBrowser(false)}
        onAdd={handleMediaAdd}
        pickType={mediaBrowserPickType}
      />
      <StyleEditor
        open={styleEditorOpen}
        onClose={() => {
          setStyleEditorOpen(false);
          setStyleEditorEditId(undefined);
        }}
        editStyleId={styleEditorEditId}
      />
      <WindowManager open={windowManagerOpen} onClose={() => setWindowManagerOpen(false)} />
      <SetListManager open={setListsOpen} onClose={() => setSetListsOpen(false)} />
      <Stack
        direction="row"
        sx={{
          p: openSongSearch ? 0 : 1,
          alignItems: 'center',
          background: palette.background.paper,
          minHeight: '56px',
          flexWrap: 'wrap',
        }}
      >
        {openSongSearch ? (
          <Box sx={{ width: '100%', p: 0.5 }}>
            <UnifiedSearch
              open={openSongSearch}
              onClose={() => {
                setOpenSongSearch(false);
              }}
              onSelectSong={(songNumber) => handleSongSelected({ songNumber, title: '' })}
              onSelectMedia={(path) => handleMediaAdd('image', path)}
              onSelectStyle={() => {
                setStyleEditorOpen(true);
              }}
              onSelectBible={(ref) => {
                handleBibleVerseAdd(ref, '', ref);
              }}
              onOpenSongLibrary={() => {
                setOpenSongSearch(false);
                setOpenSongLibrary(true);
              }}
              onOpenMediaBrowser={() => {
                setOpenSongSearch(false);
                setMediaBrowserPickType('any');
                setOpenMediaBrowser(true);
              }}
              churchToolsEnabled={churchToolsEnabled}
              onSelectChurchToolsSong={(id, name, meta) => void handleChurchToolsSongSelected(id, name, meta)}
            />
          </Box>
        ) : (
          <>
            <Tooltip title={LL.SONGS.SEARCH()}>
              <IconButton size="small" onClick={() => setOpenSongSearch(true)}>
                <SearchIcon />
              </IconButton>
            </Tooltip>

            {/* Add Item Menu */}
            <Tooltip title={LL.SHOW_ITEMS.ADD()}>
              <IconButton size="small" onClick={(e) => setAddMenuAnchor(e.currentTarget)}>
                <AddIcon />
              </IconButton>
            </Tooltip>
            <Menu anchorEl={addMenuAnchor} open={addMenuOpen} onClose={() => setAddMenuAnchor(null)}>
              <MenuItem
                onClick={() => {
                  setAddMenuAnchor(null);
                  setSongToEdit(new Song());
                }}
              >
                <ListItemIcon>
                  <MusicNoteIcon fontSize="small" sx={{ color: DEFAULT_SONG_ITEM_COLOR }} />
                </ListItemIcon>
                <ListItemText>{LL.SONGS.ADD()}</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setAddMenuAnchor(null);
                  setOpenMediaBrowser(true);
                }}
              >
                <ListItemIcon>
                  <ImageIcon fontSize="small" sx={{ color: DEFAULT_MEDIA_ITEM_COLOR }} />
                </ListItemIcon>
                <ListItemText>{LL.SHOW_ITEMS.ADD_MEDIA()}</ListItemText>
              </MenuItem>
              {bibleEnabled && (
                <MenuItem
                  onClick={() => {
                    setAddMenuAnchor(null);
                    setOpenBiblePicker(true);
                  }}
                >
                  <ListItemIcon>
                    <MenuBookIcon fontSize="small" sx={{ color: DEFAULT_BIBLE_ITEM_COLOR }} />
                  </ListItemIcon>
                  <ListItemText>{LL.SHOW_ITEMS.ADD_BIBLE_VERSE()}</ListItemText>
                </MenuItem>
              )}
              <Divider />
              <MenuItem
                disabled={!currentShow}
                onClick={() => {
                  setAddMenuAnchor(null);
                  setAddGroupDialogOpen(true);
                }}
              >
                <ListItemIcon>
                  <NewGroupIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{LL.SHOW_GROUPS.ADD()}</ListItemText>
              </MenuItem>
            </Menu>
            <GroupNameDialog
              open={addGroupDialogOpen}
              title={LL.SHOW_GROUPS.ADD()}
              onClose={() => setAddGroupDialogOpen(false)}
              onSubmit={handleAddGroup}
            />

            {isDirty && (
              <Tooltip title={LL.SHOWS.SAVE()}>
                <IconButton size="small" onClick={handleSaveShow} color="warning">
                  <Badge variant="dot" color="warning">
                    <SaveIcon />
                  </Badge>
                </IconButton>
              </Tooltip>
            )}

            <Tooltip title={LL.SHOWS.TITLE()}>
              <IconButton size="small" onClick={() => setOpenShowSwitcher(true)}>
                <ViewListIcon />
              </IconButton>
            </Tooltip>

            <Box
              sx={{
                flexGrow: 1,
              }}
            />

            {/* Mobile control page */}
            <Tooltip title={LL.REMOTE.OPEN_CONTROL()}>
              <IconButton size="small" onClick={() => window.open('/control', '_blank')}>
                <SmartphoneIcon />
              </IconButton>
            </Tooltip>

            {/* Set Lists */}
            <Tooltip title={LL.SET_LISTS.TITLE()}>
              <IconButton size="small" onClick={() => setSetListsOpen(true)}>
                <SetListIcon />
              </IconButton>
            </Tooltip>

            {/* Musician View */}
            <Tooltip title={LL.MUSICIAN.OPEN()}>
              <IconButton size="small" onClick={() => window.open('/notes', '_blank')}>
                <PdfIcon />
              </IconButton>
            </Tooltip>

            {/* Account Menu */}
            <Tooltip title={LL.HEADER.ACCOUNT_MENU()}>
              <IconButton size="small" onClick={(e) => setAccountMenuAnchor(e.currentTarget)}>
                <AccountCircleIcon />
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={accountMenuAnchor}
              open={Boolean(accountMenuAnchor)}
              onClose={() => setAccountMenuAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            >
              {accountLabel && (
                <MenuItem disabled>
                  <ListItemText>
                    <Typography
                      variant="body2"
                      sx={{
                        color: 'text.secondary',
                      }}
                    >
                      {LL.AUTH.LOGGED_IN_AS()}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{
                        fontWeight: 600,
                      }}
                    >
                      {accountLabel}
                    </Typography>
                    {session?.name && session.mail && (
                      <Typography
                        variant="caption"
                        sx={{
                          color: 'text.secondary',
                          display: 'block',
                        }}
                      >
                        {session.mail}
                      </Typography>
                    )}
                  </ListItemText>
                </MenuItem>
              )}
              {accountLabel && <Divider />}
              {session?.authType === 'oidc_admin' && (
                <MenuItem
                  onClick={() => {
                    setAccountMenuAnchor(null);
                    navigate('/admin');
                  }}
                >
                  <ListItemIcon>
                    <AdminIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>Admin</ListItemText>
                </MenuItem>
              )}
              {session?.authType === 'oidc_admin' && <Divider />}
              <MenuItem onClick={handleLogout}>
                <ListItemIcon>
                  <LogoutIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{LL.AUTH.LOGOUT()}</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setAccountMenuAnchor(null);
                  setLogoutResetOpen(true);
                }}
              >
                <ListItemIcon>
                  <ResetIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{LL.AUTH.LOGOUT_RESET.MENU()}</ListItemText>
              </MenuItem>
            </Menu>
            <LogoutResetDialog open={logoutResetOpen} onClose={() => setLogoutResetOpen(false)} />

            {/* Settings */}
            <Tooltip title={LL.SETTINGS.SETTINGS()}>
              <IconButton size="small" onClick={() => setOpenSettings(true)}>
                <SettingsIcon />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>
      {/* ── Item context menu ── */}
      <Menu
        anchorEl={itemMenuAnchor}
        open={Boolean(itemMenuAnchor)}
        onClose={handleItemMenuClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {/* Edit (songs only) */}
        {menuItem?.type === 'song' && menuItemSong && (
          <MenuItem onClick={handleItemEdit}>
            <ListItemIcon>
              <EditIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{LL.MUSICIAN.ITEM_EDIT()}</ListItemText>
          </MenuItem>
        )}
        {/* Key submenu */}
        {menuItem?.type === 'song' && (
          <MenuItem onClick={(e) => setKeySubmenuAnchor(e.currentTarget)}>
            <ListItemIcon>
              <MusicNoteIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{LL.MUSICIAN.ITEM_SELECT_KEY()}</ListItemText>
            <ChevronRightIcon fontSize="small" sx={{ ml: 1 }} />
          </MenuItem>
        )}
        {/* Order submenu */}
        {menuItem?.type === 'song' && menuItemOrders.length > 1 && (
          <MenuItem onClick={(e) => setOrderSubmenuAnchor(e.currentTarget)}>
            <ListItemIcon>
              <FolderOpenIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{LL.MUSICIAN.ITEM_SELECT_ORDER()}</ListItemText>
            <ChevronRightIcon fontSize="small" sx={{ ml: 1 }} />
          </MenuItem>
        )}
        {/* Rename (media only — songs/verses take their label from the source) */}
        {menuItem?.type === 'media' && (
          <MenuItem
            onClick={() => {
              setRenameIndex(itemMenuIndex);
              handleItemMenuClose();
            }}
          >
            <ListItemIcon>
              <RenameIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{LL.SHOW_ITEMS.RENAME()}</ListItemText>
          </MenuItem>
        )}
        {/* Direct item style submenu (applies to all windows) */}
        {availableStyles.length > 0 && (
          <MenuItem onClick={(e) => setItemStyleAnchor(e.currentTarget)}>
            <ListItemIcon>
              <PaletteIcon fontSize="small" sx={{ color: menuItem?.styleId ? 'primary.main' : undefined }} />
            </ListItemIcon>
            <ListItemText>{LL.STYLE.STYLE()}</ListItemText>
            <ChevronRightIcon fontSize="small" sx={{ ml: 1 }} />
          </MenuItem>
        )}
        {/* Item style submenu (window list) */}
        {windowNames.length > 0 && availableStyles.length > 0 && (
          <MenuItem onClick={(e) => setItemStyleWinAnchor(e.currentTarget)}>
            <ListItemIcon>
              <PaletteIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{LL.FOOTER.ITEM_STYLE()}</ListItemText>
            <ChevronRightIcon fontSize="small" sx={{ ml: 1 }} />
          </MenuItem>
        )}
        {/* Move to group submenu (only when there's more than one group) */}
        {groups.length > 1 && (
          <MenuItem onClick={(e) => setGroupSubmenuAnchor(e.currentTarget)}>
            <ListItemIcon>
              <FolderIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{LL.SHOW_GROUPS.MOVE_ITEM_TO()}</ListItemText>
            <ChevronRightIcon fontSize="small" sx={{ ml: 1 }} />
          </MenuItem>
        )}
        <Divider />
        {/* Delete */}
        <MenuItem onClick={handleItemRemove}>
          <ListItemIcon>
            <DeleteIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText sx={{ color: 'error.main' }}>{LL.MUSICIAN.ITEM_DELETE()}</ListItemText>
        </MenuItem>
      </Menu>
      {/* Rename dialog for media items */}
      <GroupNameDialog
        open={renameIndex >= 0}
        title={LL.SHOW_ITEMS.RENAME()}
        fieldLabel={LL.MEDIA.NAME_OPTIONAL()}
        // Pre-fill only a real name — an auto-label (the path/URL itself) starts empty.
        initialName={renameItem && renameItem.label !== renameFallback ? (renameItem.label ?? '') : ''}
        placeholder={renameFallback}
        helperText={LL.SHOW_ITEMS.NAME_HINT()}
        onClose={() => setRenameIndex(-1)}
        onSubmit={handleItemRename}
      />
      {/* Move-to-group submenu */}
      <Menu anchorEl={groupSubmenuAnchor} open={!!groupSubmenuAnchor} onClose={() => setGroupSubmenuAnchor(null)}>
        {groups
          .filter((g) => g.id !== (itemMenuIndex >= 0 ? showItems[itemMenuIndex]?.groupId : undefined))
          .map((g) => (
            <MenuItem
              key={g.id}
              onClick={() => {
                if (itemMenuIndex >= 0) handleMoveItemToGroup(itemMenuIndex, g.id);
                handleItemMenuClose();
              }}
            >
              <ListItemIcon>
                <CircleIcon fontSize="small" sx={{ color: g.color || 'text.disabled' }} />
              </ListItemIcon>
              <ListItemText>{groupDisplayName(g, LL.SHOW_GROUPS.DEFAULT())}</ListItemText>
            </MenuItem>
          ))}
      </Menu>
      {/* Direct item style submenu — visual previews for one-click assignment */}
      <Menu
        anchorEl={itemStyleAnchor}
        open={Boolean(itemStyleAnchor)}
        onClose={() => setItemStyleAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: { sx: { maxHeight: '60vh', overflowY: 'auto' } },
        }}
      >
        <MenuItem onClick={() => void handleItemSetStyle(undefined)} selected={!menuItem?.styleId} sx={{ gap: 1 }}>
          <Box sx={{ width: 56, flexShrink: 0 }} />
          <Typography variant="body2">
            <em>{LL.STYLE.NONE()}</em>
          </Typography>
        </MenuItem>
        {availableStyles
          .filter((s) => s.enabled)
          .map((s) => (
            <MenuItem key={s.id} onClick={() => void handleItemSetStyle(s.id)} selected={s.id === menuItem?.styleId} sx={{ gap: 1 }}>
              <Box sx={{ width: 56, flexShrink: 0, borderRadius: 0.5, overflow: 'hidden', border: '1px solid', borderColor: 'divider' }}>
                <StyleGalleryThumb style={s} />
              </Box>
              <Typography variant="body2" noWrap sx={{ maxWidth: 180, flexGrow: 1 }}>
                {s.name}
              </Typography>
              <Tooltip title={LL.STYLE.EDIT_STYLE()}>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditStyleDirect(s.id);
                  }}
                >
                  <EditIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </MenuItem>
          ))}
      </Menu>
      {/* Key submenu */}
      <Menu
        anchorEl={keySubmenuAnchor}
        open={Boolean(keySubmenuAnchor)}
        onClose={() => setKeySubmenuAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: { sx: { maxHeight: '60vh', overflowY: 'auto' } },
        }}
      >
        <MenuItem onClick={() => handleItemSetKey(undefined)} sx={{ fontSize: '0.85rem' }}>
          <em>None</em>
        </MenuItem>
        {MUSICAL_KEYS.map((k) => (
          <MenuItem key={k} onClick={() => handleItemSetKey(k)} selected={menuItem?.key === k} sx={{ fontSize: '0.85rem' }}>
            {k}
          </MenuItem>
        ))}
      </Menu>
      {/* Order submenu */}
      <Menu
        anchorEl={orderSubmenuAnchor}
        open={Boolean(orderSubmenuAnchor)}
        onClose={() => setOrderSubmenuAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: { sx: { maxHeight: '60vh', overflowY: 'auto', touchAction: 'pan-y' } },
        }}
      >
        {menuItemOrders.map((order) => (
          <MenuItem
            key={order}
            onClick={() => void handleItemSetOrder(order)}
            selected={parseOrderKey(menuItem?.order).order === order}
            sx={{ fontSize: '0.85rem' }}
          >
            {order}
          </MenuItem>
        ))}
      </Menu>
      {quickOrderContext && songs[quickOrderContext.songNumber] && (
        <QuickOrderDialog
          open={quickOrderDialogOpen}
          onClose={() => {
            setQuickOrderDialogOpen(false);
            setQuickOrderContext(null);
          }}
          song={songs[quickOrderContext.songNumber]}
          initialOrderName={quickOrderContext.orderName}
          onSave={handleQuickOrderSave}
        />
      )}
      {/* Item-style: window list submenu */}
      <Menu
        anchorEl={itemStyleWinAnchor}
        open={Boolean(itemStyleWinAnchor)}
        onClose={() => setItemStyleWinAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        {windowNames.map((wname) => (
          <MenuItem
            key={wname}
            onClick={(e) => {
              setItemStyleWindowName(wname);
              setItemStyleStyleAnchor(e.currentTarget);
            }}
            sx={{ fontSize: '0.85rem' }}
          >
            <ListItemText>{wname}</ListItemText>
            <ChevronRightIcon fontSize="small" sx={{ ml: 1 }} />
          </MenuItem>
        ))}
      </Menu>
      {/* Item-style: style list submenu (for the chosen window) */}
      <Menu
        anchorEl={itemStyleStyleAnchor}
        open={Boolean(itemStyleStyleAnchor)}
        onClose={() => setItemStyleStyleAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        <MenuItem
          onClick={() => handleItemSetStyleForWindow(null)}
          selected={!menuItem?.itemStyleByWindow?.[itemStyleWindowName]}
          sx={{ fontSize: '0.85rem' }}
        >
          <em>{LL.STYLE.NONE()}</em>
        </MenuItem>
        {availableStyles
          .filter((s) => s.enabled)
          .map((s) => (
            <MenuItem
              key={s.id}
              onClick={() => handleItemSetStyleForWindow(s.id)}
              selected={s.id === menuItem?.itemStyleByWindow?.[itemStyleWindowName]}
              sx={{ fontSize: '0.85rem', gap: 1 }}
            >
              <Box sx={{ width: 56, flexShrink: 0, borderRadius: 0.5, overflow: 'hidden', border: '1px solid', borderColor: 'divider' }}>
                <StyleGalleryThumb style={s} />
              </Box>
              <Typography variant="body2" noWrap sx={{ maxWidth: 180, flexGrow: 1 }}>
                {s.name}
              </Typography>
              <Tooltip title={LL.STYLE.EDIT_STYLE()}>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditStyleDirect(s.id);
                  }}
                >
                  <EditIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </MenuItem>
          ))}
      </Menu>
      {showItems.length === 0 ? (
        <Box sx={{ overflow: 'auto', flexGrow: 1 }}>
          {
            <Stack
              spacing={1.5}
              sx={{
                alignItems: 'center',
                justifyContent: 'center',
                flexGrow: 1,
                p: 3,
                textAlign: 'center',
              }}
            >
              <FileUploadIcon sx={{ fontSize: 40, color: 'text.disabled' }} />
              <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                {LL.SHOW_ITEMS.EMPTY_HINT_TITLE()}
              </Typography>

              {/* Interactive hint line */}
              <Typography variant="body2" color="text.disabled" component="div" sx={{ lineHeight: 2 }}>
                {/* "Load a show" */}
                <Box
                  component="span"
                  onClick={() => setOpenShowSwitcher(true)}
                  sx={{ color: 'primary.main', cursor: 'pointer', textDecoration: 'underline', '&:hover': { opacity: 0.8 } }}
                >
                  {LL.SHOW_ITEMS.EMPTY_HINT_LOAD_SHOW()}
                </Box>
                {', '}
                {/* "search for songs" */}
                <Box
                  component="span"
                  onClick={() => setOpenSongSearch(true)}
                  sx={{ color: 'primary.main', cursor: 'pointer', textDecoration: 'underline', '&:hover': { opacity: 0.8 } }}
                >
                  {LL.SHOW_ITEMS.EMPTY_HINT_SEARCH()}
                </Box>
                {', '}
                {LL.SHOW_ITEMS.EMPTY_HINT_OR()} {/* "add items" with the + icon */}
                <Box
                  component="span"
                  onClick={(e: MouseEvent<HTMLSpanElement>) => setAddMenuAnchor(e.currentTarget)}
                  sx={{
                    color: 'primary.main',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    '&:hover': { opacity: 0.8 },
                    whiteSpace: 'nowrap',
                  }}
                >
                  <AddIcon sx={{ fontSize: 14, verticalAlign: 'middle', mb: '2px' }} /> {LL.SHOW_ITEMS.EMPTY_HINT_ADD()}
                </Box>{' '}
                {LL.SHOW_ITEMS.EMPTY_HINT_CCLI()}
              </Typography>

              <Box
                component="label"
                sx={{
                  mt: 1,
                  border: '2px dashed',
                  borderColor: 'divider',
                  borderRadius: 2,
                  px: 3,
                  py: 1.5,
                  cursor: 'pointer',
                  display: 'block',
                  '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
                }}
                onClick={() => fileInputRef.current?.click()}
              >
                <Typography variant="caption" color="text.disabled">
                  {LL.SHOW_ITEMS.EMPTY_HINT_DROP()}
                </Typography>
                <input ref={fileInputRef} type="file" accept=".txt,.sng" multiple hidden onChange={handleFileInputChange} />
              </Box>
            </Stack>
          }
        </Box>
      ) : (
        <Box sx={{ overflow: 'auto', flexGrow: 1 }}>
          <ShowGroupList
            order={showItems}
            groups={groups}
            renderItem={renderItemRow}
            onMoveItem={handleMoveItem}
            onToggleCollapse={handleToggleGroupCollapse}
            editable
            onRenameGroup={handleRenameGroup}
            onRecolorGroup={handleRecolorGroup}
            onReorderGroup={handleReorderGroup}
            onDeleteGroup={handleDeleteGroup}
            onAddGroup={handleAddGroup}
            footer={
              isImportingCcli ? (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 3, py: 1 }}>
                  <Skeleton variant="circular" width={20} height={20} />
                  <Skeleton variant="text" sx={{ flex: 1, fontSize: '1rem' }} />
                </Stack>
              ) : undefined
            }
          />
        </Box>
      )}
      {importLanguageDialog}
    </Stack>
  );
});

Sidebar.displayName = 'Sidebar';

export default Sidebar;
