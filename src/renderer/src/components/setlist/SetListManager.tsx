/**
 * Set List manager — a reusable planning layer on top of the song library.
 *
 * A Set List holds one Set List Entry per song; each entry carries one or more Tag Assignments
 * that provide tag-specific playback metadata (key + existing block-order name). An entry with
 * several tags therefore shows up in several accordion sections, and adding it to the agenda
 * from different sections produces different agenda payloads.
 *
 * The last opened list and the per-list accordion state live in the shared settings object so
 * they ride the existing settings export/import.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  Popover,
  Slider,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  Add as AddIcon,
  DeleteOutlined as DeleteIcon,
  Edit as EditIcon,
  ExpandMore as ExpandMoreIcon,
  FilterAlt as FilterIcon,
  LibraryAdd as ImportIcon,
  History as UsageIcon,
  QueueMusic as SetListIcon,
  Search as SearchIcon,
  ContentCopy as CopyIcon,
  AssignmentTurnedIn as CopiedIcon,
  ChevronLeft as MoveLeftIcon,
  ChevronRight as MoveRightIcon,
  LocalOffer as TagIcon,
  Star as FavoriteIcon,
  StarBorder as NotFavoriteIcon,
  Undo as UndoIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useAppDispatch } from '@/store';
import { addShowItem, removeShowItem, useGetShow } from '@/store/showSlice';
import { useGetShowsQuery } from '@/api/shows.api';
import { addSongToStore, addToSongsOrder, useGetSongs } from '@/store/songsSlice';
import { useGetSettings, useUpdateSetting } from '@/store/settingsSlice';
import { useSearchSongsQuery, useLazyGetSongQuery, type SongListItem } from '@/api/songs.api';
import {
  useAddSetListEntryMutation,
  useCreateSetListMutation,
  useDeleteSetListEntryMutation,
  useDeleteSetListEntryTagMutation,
  useDeleteSetListMutation,
  useGetSetListsQuery,
  useReorderSetListsMutation,
  useUpdateSetListMutation,
  useSetSetListEntryTagsMutation,
  type SetList,
  type SetListEntry,
  type SetListTagAssignment,
} from '@/api/setLists.api';
import { Song } from '@/song';
import { useMetrics } from '@/hooks/useMetrics';
import { useIsMobile } from '@/hooks/useIsMobile';
import { RowActionMenu } from '@/components/common/RowActionMenu';
import { BandChips, BandPicker } from '@/components/common/BandPicker';
import { useBands } from '@/hooks/useBands';
import { copyTextToClipboard } from '@/utils/clipboard';
import { SetListTagEditor } from './SetListTagEditor';

/** Section key for entries that have no Tag Assignments at all. */
const UNTAGGED = '__untagged__';

/** Library results are one line each here, so more of them fit than the server default. */
const ADD_MODE_RESULT_LIMIT = 15;

/**
 * Upper bound of the usage slider. The full window is fetched once and sliced client-side,
 * so dragging the slider never refetches.
 */
const MAX_USAGE_SHOWS = 20;

/**
 * The shared song label used by both the set list rows and the Add results.
 *
 * The title never yields space — `flexShrink: 0` squeezes the authors to nothing first, and the
 * `maxWidth` only bites when the title alone is wider than the row, where it ellipsizes rather
 * than hard-clipping. Callers put anything that must survive (chips, buttons) outside this box.
 *
 * `stacked` (phones) drops the authors onto a second line instead: a narrow row shrinks them to
 * nothing anyway, so they may as well be readable.
 */
const SongLine = ({
  title,
  songNumber,
  authors,
  stacked = false,
}: {
  title: string;
  songNumber: number;
  authors?: string;
  stacked?: boolean;
}) => (
  <Stack
    direction={stacked ? 'column' : 'row'}
    spacing={stacked ? 0 : 0.75}
    sx={{
      alignItems: stacked ? 'flex-start' : 'center',
      minWidth: 0,
      flex: '1 1 auto',
      overflow: 'hidden',
      width: stacked ? '100%' : undefined,
    }}
  >
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0, maxWidth: '100%', flexShrink: stacked ? 1 : 0 }}>
      <Typography variant="body2" noWrap sx={{ fontWeight: 500, minWidth: 0 }}>
        {title}
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
        #{songNumber}
      </Typography>
    </Stack>
    {authors && (
      <Typography
        variant="caption"
        noWrap
        sx={{ color: 'text.secondary', flex: stacked ? '0 0 auto' : '1 1 auto', minWidth: 0, maxWidth: '100%' }}
      >
        {authors}
      </Typography>
    )}
  </Stack>
);

/** One line of the clipboard export: "Title - Authors (#123)", or "Title (#123)" with no authors. */
const formatExportLine = (title: string, authors: string | null | undefined, songNumber: number): string => {
  const trimmedAuthors = authors?.trim();
  return trimmedAuthors ? `${title} - ${trimmedAuthors} (#${songNumber})` : `${title} (#${songNumber})`;
};

type SearchMode = 'filter' | 'import';

/** One rendered row: an entry seen through one specific tag (or through no tag at all). */
type TaggedOccurrence = {
  entry: SetListEntry;
  assignment: SetListTagAssignment | null;
};

interface SetListManagerProps {
  open: boolean;
  onClose: () => void;
}

export const SetListManager = ({ open, onClose }: SetListManagerProps) => {
  const { LL } = useI18nContext();
  const dispatch = useAppDispatch();
  const { trackEvent } = useMetrics();
  const isMobile = useIsMobile();

  const { currentShow } = useGetShow();
  const { songs } = useGetSongs();
  const { setLists: setListSettings } = useGetSettings();
  const updateSetting = useUpdateSetting();
  const { bandNames } = useBands();

  const { data: setLists, isLoading, isError } = useGetSetListsQuery(undefined, { skip: !open });
  const [createSetList] = useCreateSetListMutation();
  const [updateSetList] = useUpdateSetListMutation();
  const [deleteSetList] = useDeleteSetListMutation();
  const [reorderSetLists] = useReorderSetListsMutation();
  const [addEntry] = useAddSetListEntryMutation();
  const [setEntryTags] = useSetSetListEntryTagsMutation();
  const [deleteEntry] = useDeleteSetListEntryMutation();
  const [deleteEntryTag] = useDeleteSetListEntryTagMutation();
  const [fetchSong] = useLazyGetSongQuery();

  const [activeId, setActiveId] = useState<number | null>(setListSettings.lastOpenedSetListId);
  const [mode, setMode] = useState<SearchMode>('filter');
  const [search, setSearch] = useState('');
  const [nameDialog, setNameDialog] = useState<{ mode: 'create' | 'rename'; value: string; bandIds: number[] } | null>(null);
  const [deleteListConfirm, setDeleteListConfirm] = useState(false);
  const [tagEditorEntry, setTagEditorEntry] = useState<SetListEntry | null>(null);
  /** Anchor + context for the remove-song / remove-tag choice popover. */
  const [removeCtx, setRemoveCtx] = useState<{ anchor: HTMLElement; entry: SetListEntry; tagName: string | null } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** Transient tick on the copy button so the user gets feedback without a snackbar. */
  const [copied, setCopied] = useState(false);
  /** Anchor of the usage-window popover (the history icon next to the search field). */
  const [usageAnchor, setUsageAnchor] = useState<HTMLElement | null>(null);
  /**
   * Payload of the most recent add-to-agenda click, kept so a mis-click can be undone.
   * Only the latest addition is undoable; cleared once undone or when the dialog closes.
   */
  const [lastAdded, setLastAdded] = useState<{ songNumber: number; order: string; key?: string } | null>(null);

  const lists: SetList[] = useMemo(() => setLists ?? [], [setLists]);

  // ── Song usage across recent shows ────────────────────────────────────────
  // The slider narrows a client-side window over the shows the backend already returns
  // newest-save-first (`date` is bumped to CURRENT_TIMESTAMP on every save).
  const [usageShowCount, setUsageShowCount] = useState(setListSettings.usageShowCount ?? 8);
  const { data: recentShowsData } = useGetShowsQuery({ limit: MAX_USAGE_SHOWS, page: 0 }, { skip: !open });

  const recentShows = useMemo(() => (recentShowsData?.shows ?? []).slice(0, usageShowCount), [recentShowsData, usageShowCount]);

  /** songNumber → number of recent shows it appears in (a show counts once, however often the song repeats in it). */
  const usageCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const show of recentShows) {
      const numbers = new Set<number>();
      for (const item of show.order) {
        if (item.type === 'song' && item.songNumber != null) numbers.add(item.songNumber);
      }
      for (const n of numbers) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return counts;
  }, [recentShows]);

  // Restore the persisted selection; fall back to the first list when it is gone (or never set).
  useEffect(() => {
    if (!open || lists.length === 0) return;
    const stillExists = activeId != null && lists.some((l) => l.id === activeId);
    if (!stillExists) setActiveId(lists[0].id);
  }, [open, lists, activeId]);

  // An undo target from a previous opening of the dialog would be confusing — drop it.
  useEffect(() => {
    if (!open) setLastAdded(null);
  }, [open]);

  // Persist the selection so the manager reopens where the user left off.
  useEffect(() => {
    if (activeId == null || activeId === setListSettings.lastOpenedSetListId) return;
    updateSetting('setLists', { ...setListSettings, lastOpenedSetListId: activeId });
  }, [activeId, setListSettings, updateSetting]);

  const activeList = useMemo(() => lists.find((l) => l.id === activeId) ?? null, [lists, activeId]);
  /** Position of the active list in the tab strip — drives the move-left/right buttons. */
  const activeIndex = useMemo(() => lists.findIndex((l) => l.id === activeId), [lists, activeId]);

  // ── Agenda cross-reference ────────────────────────────────────────────────
  // Highlight entries already planned in the current show. A song may appear more than once;
  // a Set holds the distinct numbers so the lookup stays deterministic either way.
  const songNumbersInShow = useMemo(() => {
    const set = new Set<number>();
    for (const item of currentShow?.order ?? []) {
      if (item.type === 'song' && item.songNumber != null) set.add(item.songNumber);
    }
    return set;
  }, [currentShow?.order]);

  // ── Personal favorites ────────────────────────────────────────────────────
  // Device-local and per set list: a musician stars what they want to practise or suggest.
  // It never reaches the server, so it cannot change what the operator sees.
  const favorites = useMemo(
    () => new Set(activeId != null ? (setListSettings.favoritesBySetListId[String(activeId)] ?? []) : []),
    [activeId, setListSettings.favoritesBySetListId],
  );
  const favoritesOnly = setListSettings.favoritesOnly;

  const toggleFavorite = (songNumber: number) => {
    if (activeId == null) return;
    const next = new Set(favorites);
    if (next.has(songNumber)) next.delete(songNumber);
    else next.add(songNumber);
    updateSetting('setLists', {
      ...setListSettings,
      favoritesBySetListId: { ...setListSettings.favoritesBySetListId, [String(activeId)]: Array.from(next) },
    });
  };

  const setFavoritesOnly = (only: boolean) => updateSetting('setLists', { ...setListSettings, favoritesOnly: only });

  // ── Suggestion pools (autocomplete consistency) ───────────────────────────
  // The account's bands come first: a tag is most often the band that plays the song, and
  // offering the configured names keeps them spelled the same way across every list.
  const knownTags = useMemo(() => {
    const names = new Set<string>(bandNames);
    for (const entry of activeList?.entries ?? []) {
      for (const tag of entry.tags) names.add(tag.tagName);
    }
    return Array.from(names).sort();
  }, [activeList, bandNames]);

  const knownKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of activeList?.entries ?? []) {
      for (const tag of entry.tags) if (tag.customKey) keys.add(tag.customKey);
    }
    return Array.from(keys).sort();
  }, [activeList]);

  const entryTitle = useCallback(
    (entry: SetListEntry) => entry.songTitle || songs[entry.songNumber]?.title || `#${entry.songNumber}`,
    [songs],
  );

  /** Authors from the set list payload, falling back to a locally cached song. */
  const entryAuthors = useCallback((entry: SetListEntry) => (entry.songAuthors ?? songs[entry.songNumber]?.authors ?? '').trim(), [songs]);

  // ── Tag sections ──────────────────────────────────────────────────────────
  // In filter mode the query narrows the entries already in this set list. An entry with
  // several assignments intentionally appears once per matching tag section.
  const sections = useMemo(() => {
    const query = mode === 'filter' ? search.trim().toLowerCase() : '';
    const bySection = new Map<string, TaggedOccurrence[]>();

    for (const entry of activeList?.entries ?? []) {
      if (query) {
        const haystack = `${entryTitle(entry)} ${entry.songNumber}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      // The star narrows the same view the search does, so the two compose.
      if (favoritesOnly && !favorites.has(entry.songNumber)) continue;
      if (entry.tags.length === 0) {
        bySection.set(UNTAGGED, [...(bySection.get(UNTAGGED) ?? []), { entry, assignment: null }]);
        continue;
      }
      for (const assignment of entry.tags) {
        bySection.set(assignment.tagName, [...(bySection.get(assignment.tagName) ?? []), { entry, assignment }]);
      }
    }

    const tagNames = Array.from(bySection.keys())
      .filter((k) => k !== UNTAGGED)
      .sort((a, b) => a.localeCompare(b));
    // Untagged always sits last so the named sections stay stable as tags come and go.
    if (bySection.has(UNTAGGED)) tagNames.push(UNTAGGED);

    return tagNames.map((name) => ({
      name,
      label: name === UNTAGGED ? LL.SET_LISTS.UNTAGGED() : name,
      rows: (bySection.get(name) ?? []).sort((a, b) => entryTitle(a.entry).localeCompare(entryTitle(b.entry))),
    }));
  }, [activeList, mode, search, entryTitle, favorites, favoritesOnly, LL]);

  // ── Accordion state, scoped per set list ──────────────────────────────────
  const accordionState = activeId != null ? (setListSettings.accordionStateBySetListId[String(activeId)] ?? {}) : {};

  const setAccordionOpen = (tagName: string, expanded: boolean) => {
    if (activeId == null) return;
    updateSetting('setLists', {
      ...setListSettings,
      accordionStateBySetListId: {
        ...setListSettings.accordionStateBySetListId,
        [String(activeId)]: { ...accordionState, [tagName]: expanded },
      },
    });
  };

  // ── Add mode: search the global song library ──────────────────────────────
  const importQuery = mode === 'import' ? search.trim() : '';
  const { data: libraryResults, isFetching: importFetching } = useSearchSongsQuery(
    // The rows here are single-line, so more of them fit than the deployment default allows.
    { q: importQuery, mode: 'title', limit: ADD_MODE_RESULT_LIMIT },
    { skip: !open || importQuery.length < 2 },
  );

  /**
   * Starting point when the Add box is still empty: the songs of the show currently open,
   * minus the ones this set list already holds. Building a set list usually starts from
   * what was just planned, so this saves searching for songs you can already see.
   * Duplicated agenda items collapse into one suggestion.
   */
  const agendaSuggestions = useMemo(() => {
    const inList = new Set((activeList?.entries ?? []).map((e) => e.songNumber));
    const seen = new Set<number>();
    const result: SongListItem[] = [];
    for (const item of currentShow?.order ?? []) {
      if (item.type !== 'song' || item.songNumber == null) continue;
      if (inList.has(item.songNumber) || seen.has(item.songNumber)) continue;
      seen.add(item.songNumber);
      result.push({
        songNumber: item.songNumber,
        title: songs[item.songNumber]?.title || `#${item.songNumber}`,
        authors: songs[item.songNumber]?.authors,
      });
    }
    return result;
  }, [currentShow?.order, activeList, songs]);

  /** Row shared by the agenda suggestions and the library search results. */
  /**
   * Heading for the Add-mode lists. Uses the same label + count + rule rhythm as the tag
   * accordions so the two halves of the dialog feel like one screen — minus the chip, which
   * belongs to tags specifically.
   */
  const renderSectionHeading = (label: string, count: number) => (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1, pb: 0.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
        {count}
      </Typography>
      <Divider sx={{ flex: 1, minWidth: 16 }} />
    </Stack>
  );

  const renderAddableRow = (song: SongListItem) => {
    const already = (activeList?.entries ?? []).some((e) => e.songNumber === song.songNumber);
    return (
      <ListItem
        key={song.songNumber}
        disablePadding
        sx={(theme) => ({
          // Matches the set list rows so both halves of the dialog read the same.
          borderRadius: 1,
          mb: 0.5,
          border: '1px solid',
          borderColor: 'transparent',
          // Songs already in the list stay visible but clearly spent.
          bgcolor: already ? alpha(theme.palette.action.disabled, 0.08) : 'transparent',
          // MUI's stock 48px leaves only ~2px next to the add button; see the note in renderRow
          // for why the override has to sit on the ListItem rather than the button.
          '& > .MuiListItemButton-root': { pr: '58px' },
        })}
        secondaryAction={
          <Tooltip title={already ? LL.SET_LISTS.ALREADY_IN_LIST() : LL.SET_LISTS.ADD_TO_LIST()}>
            <span>
              <IconButton size="small" onClick={() => handleAddSongToSetList(song)} disabled={already}>
                <AddIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        }
      >
        <ListItemButton dense disabled={already} onClick={() => handleAddSongToSetList(song)} sx={{ borderRadius: 1, minWidth: 0 }}>
          {/* Same label as the set list rows so both halves of the dialog match. */}
          <SongLine title={song.title} songNumber={song.songNumber} authors={song.authors} stacked={isMobile} />
        </ListItemButton>
      </ListItem>
    );
  };

  const runGuarded = async (fn: () => Promise<unknown>) => {
    try {
      setErrorMsg(null);
      await fn();
    } catch (e) {
      const message = (e as { data?: { error?: string }; message?: string })?.data?.error ?? (e as Error)?.message;
      setErrorMsg(message || LL.SET_LISTS.ERROR_GENERIC());
    }
  };

  const handleAddSongToSetList = (song: SongListItem) => {
    if (activeId == null) return;
    void runGuarded(async () => {
      await addEntry({ setListId: activeId, songNumber: song.songNumber }).unwrap();
      trackEvent('set_list_song_added', 'song', String(song.songNumber));
    });
  };

  /**
   * Copy an occurrence into the current agenda. The payload is taken from THIS Tag Assignment,
   * so the same entry added from a different tag section can land with a different key/order.
   */
  const handleAddToAgenda = (occurrence: TaggedOccurrence) => {
    const { entry, assignment } = occurrence;
    void runGuarded(async () => {
      // The song may not be in the local store yet (set lists span the whole library).
      if (!songs[entry.songNumber]) {
        const full = await fetchSong({ songNumber: entry.songNumber }).unwrap();
        if (full?.songNumber != null) {
          dispatch(addSongToStore(new Song(full)));
          dispatch(addToSongsOrder(full.songNumber));
        }
      }
      const payload = {
        songNumber: entry.songNumber,
        order: assignment?.blockOrderName || 'Default',
        ...(assignment?.customKey ? { key: assignment.customKey } : {}),
      };
      dispatch(addShowItem({ type: 'song', ...payload }));
      setLastAdded(payload);
      trackEvent('set_list_added_to_agenda', 'song', String(entry.songNumber), { tag: assignment?.tagName ?? '' });
    });
  };

  /**
   * Undo the most recent add-to-agenda click. The item was appended, but the user may have
   * touched the agenda since — so scan from the end for the matching payload instead of
   * blindly popping the last item, and do nothing when it is already gone.
   */
  const handleUndoLastAdd = () => {
    if (!lastAdded || !currentShow) return;
    for (let i = currentShow.order.length - 1; i >= 0; i--) {
      const item = currentShow.order[i];
      if (
        item.type === 'song' &&
        item.songNumber === lastAdded.songNumber &&
        (item.order ?? 'Default') === lastAdded.order &&
        (item.key ?? undefined) === lastAdded.key
      ) {
        dispatch(removeShowItem(i));
        break;
      }
    }
    setLastAdded(null);
  };

  const handleRemove = (scope: 'tag' | 'song') => {
    if (!removeCtx) return;
    const { entry, tagName } = removeCtx;
    setRemoveCtx(null);
    void runGuarded(async () => {
      if (scope === 'tag' && tagName) {
        await deleteEntryTag({ entryId: entry.id, tagName }).unwrap();
      } else {
        await deleteEntry({ entryId: entry.id }).unwrap();
      }
    });
  };

  /**
   * Plain-text rendering of the active set list for pasting into mail or a messenger.
   * Groups are separated by a blank line; songs inside a group are sorted alphabetically.
   * An entry with several tags is listed under each of them, matching what the UI shows.
   * Deliberately built from the unfiltered list — the search box narrows the view, not the export.
   */
  const buildSetListText = useCallback((): string => {
    if (!activeList) return '';
    const bySection = new Map<string, string[]>();

    for (const entry of activeList.entries) {
      const line = formatExportLine(entryTitle(entry), entryAuthors(entry), entry.songNumber);
      const targets = entry.tags.length > 0 ? entry.tags.map((t) => t.tagName) : [UNTAGGED];
      for (const target of targets) {
        bySection.set(target, [...(bySection.get(target) ?? []), line]);
      }
    }

    const tagNames = Array.from(bySection.keys())
      .filter((k) => k !== UNTAGGED)
      .sort((a, b) => a.localeCompare(b));
    if (bySection.has(UNTAGGED)) tagNames.push(UNTAGGED);

    const blocks = tagNames.map((name) => {
      const heading = name === UNTAGGED ? LL.SET_LISTS.UNTAGGED() : name;
      const lines = (bySection.get(name) ?? []).sort((a, b) => a.localeCompare(b));
      return [heading, ...lines].join('\n');
    });

    return [activeList.name, ...blocks].join('\n\n');
  }, [activeList, entryTitle, entryAuthors, LL]);

  const handleCopyToClipboard = () => {
    const text = buildSetListText();
    if (!text) return;
    void (async () => {
      if (!(await copyTextToClipboard(text))) {
        setErrorMsg(LL.SET_LISTS.COPY_FAILED());
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      trackEvent('set_list_copied', undefined, String(activeList?.id ?? ''));
    })();
  };

  const handleNameSubmit = () => {
    if (!nameDialog) return;
    const name = nameDialog.value.trim();
    if (!name) return;
    const isCreate = nameDialog.mode === 'create';
    const bandIds = nameDialog.bandIds;
    setNameDialog(null);
    void runGuarded(async () => {
      if (isCreate) {
        const created = await createSetList({ name, bandIds }).unwrap();
        if (created?.id) setActiveId(created.id);
      } else if (activeId != null) {
        // Name and bands go in one request — the endpoint takes either or both.
        await updateSetList({ id: activeId, name, bandIds }).unwrap();
      }
    });
  };

  /** Move the active set list one slot left or right in the tab strip and persist the order. */
  const handleMoveSetList = (delta: -1 | 1) => {
    const from = lists.findIndex((l) => l.id === activeId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= lists.length) return;
    const reordered = [...lists];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    void runGuarded(async () => {
      await reorderSetLists({ order: reordered.map((l) => l.id) }).unwrap();
    });
  };

  const handleDeleteList = () => {
    if (activeId == null) return;
    const id = activeId;
    setDeleteListConfirm(false);
    void runGuarded(async () => {
      await deleteSetList({ id }).unwrap();
      setActiveId(null);
    });
  };

  const renderRow = (occurrence: TaggedOccurrence, sectionName: string) => {
    const { entry, assignment } = occurrence;
    const inAgenda = songNumbersInShow.has(entry.songNumber);
    const usage = usageCounts.get(entry.songNumber) ?? 0;
    const rowTagName = sectionName === UNTAGGED ? null : sectionName;
    const isFavorite = favorites.has(entry.songNumber);

    // Same two chips either way; only their sequence differs by breakpoint (see below).
    // The order name is capped so a long one ellipsizes inside its chip instead of
    // crowding the title out of the row.
    const orderChip = assignment?.blockOrderName ? (
      <Chip label={assignment.blockOrderName} size="small" variant="outlined" sx={{ height: 18, maxWidth: { xs: 110, sm: 130 } }} />
    ) : null;
    const keyChip = assignment?.customKey ? <Chip label={assignment.customKey} size="small" color="primary" sx={{ height: 18 }} /> : null;
    return (
      <ListItem
        key={`${entry.id}-${assignment?.id ?? 'none'}`}
        disablePadding
        sx={(theme) => ({
          borderRadius: 1,
          mb: 0.5,
          // Planned entries get a tinted row — visible at a glance without making the row
          // read as disabled. The tint alone carries it; the tooltip below names it.
          bgcolor: inAgenda ? alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.18 : 0.12) : 'transparent',
          border: '1px solid',
          borderColor: inAgenda ? alpha(theme.palette.success.main, 0.5) : 'transparent',
          // Clear the absolutely-positioned actions: 126px for the desktop trio (3 × 30px + 2 × 4px
          // gap + MUI's 16px secondaryAction inset), 48px for the single overflow button on mobile.
          // ListItem itself sets 48px on the child button through this very selector, which
          // outranks an `sx` on the button — so the override has to live here to win the cascade.
          '& > .MuiListItemButton-root': { pr: { xs: '48px', sm: '126px' } },
        })}
        secondaryAction={
          isMobile ? (
            <RowActionMenu
              edge={false}
              actions={[
                {
                  key: 'favorite',
                  label: isFavorite ? LL.SET_LISTS.UNFAVORITE() : LL.SET_LISTS.FAVORITE(),
                  icon: isFavorite ? <FavoriteIcon fontSize="small" color="warning" /> : <NotFavoriteIcon fontSize="small" />,
                  onClick: () => toggleFavorite(entry.songNumber),
                },
                {
                  key: 'tags',
                  label: LL.SET_LISTS.EDIT_TAGS(),
                  icon: <TagIcon fontSize="small" />,
                  onClick: () => setTagEditorEntry(entry),
                },
                {
                  key: 'remove',
                  label: LL.SET_LISTS.REMOVE(),
                  icon: <DeleteIcon fontSize="small" />,
                  // The remove popover needs an anchor that outlives the menu — the overflow button.
                  onClick: (anchor) => setRemoveCtx({ anchor, entry, tagName: rowTagName }),
                  destructive: true,
                },
              ]}
            />
          ) : (
            <Stack direction="row" spacing={0.5}>
              {/* Personal and local: starring a song never leaves this device. */}
              <Tooltip title={isFavorite ? LL.SET_LISTS.UNFAVORITE() : LL.SET_LISTS.FAVORITE()}>
                <IconButton size="small" onClick={() => toggleFavorite(entry.songNumber)}>
                  {isFavorite ? <FavoriteIcon fontSize="small" color="warning" /> : <NotFavoriteIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
              <Tooltip title={LL.SET_LISTS.EDIT_TAGS()}>
                <IconButton size="small" onClick={() => setTagEditorEntry(entry)}>
                  <TagIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={LL.SET_LISTS.REMOVE()}>
                <IconButton size="small" onClick={(e) => setRemoveCtx({ anchor: e.currentTarget, entry, tagName: rowTagName })}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          )
        }
      >
        {/* An empty title renders no tooltip, so this doubles as the explanation of the tint
            for planned entries without needing a separate indicator icon. Clicking the row adds
            the occurrence to the agenda (tags are edited via the tag button instead). */}
        <Tooltip title={inAgenda ? LL.SET_LISTS.IN_AGENDA() : currentShow ? LL.SET_LISTS.ADD_TO_AGENDA() : ''}>
          <ListItemButton dense disabled={!currentShow} onClick={() => handleAddToAgenda(occurrence)} sx={{ borderRadius: 1, minWidth: 0 }}>
            {/* One line, two zones: a text zone that absorbs all the shrinking, and a chip zone
                that holds its size. Keeping the chips out of the text zone means a very long
                title can never push the key / order out of view. A phone has no width for both
                zones side by side, so there the chips move under the title. */}
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={{ xs: 0.25, sm: 0.75 }}
              sx={{
                alignItems: { xs: 'flex-start', sm: 'center' },
                minWidth: 0,
                flex: 1,
                width: '100%',
                overflow: 'hidden',
              }}
            >
              <SongLine title={entryTitle(entry)} songNumber={entry.songNumber} authors={entryAuthors(entry)} stacked={isMobile} />
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexShrink: 0, maxWidth: '100%' }}>
                {/* Desktop leads with the order: the wide outlined chip anchors the group and the
                    short filled key reads as its qualifier. Mobile leads with the key instead —
                    the chips sit on their own line under the title there, where the short chip
                    first keeps the left edge tidy and the truncated order name trails it. */}
                {isMobile ? (
                  <>
                    {keyChip}
                    {orderChip}
                  </>
                ) : (
                  <>
                    {orderChip}
                    {keyChip}
                  </>
                )}
                {/* How often the song appeared in the recent-shows window. Dimmed at zero so
                    unplayed songs stand out by their absence of emphasis, not by a missing chip. */}
                <Tooltip title={LL.SET_LISTS.USAGE_TOOLTIP({ count: usage, total: recentShows.length })}>
                  <Chip
                    label={`${usage}×`}
                    size="small"
                    variant="outlined"
                    sx={{ height: 18, flexShrink: 0, color: usage === 0 ? 'text.disabled' : 'text.secondary' }}
                  />
                </Tooltip>
              </Stack>
            </Stack>
          </ListItemButton>
        </Tooltip>
      </ListItem>
    );
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="md"
        fullWidth
        // Everything here is dense (tabs, per-row actions, chips) — on a phone it needs the
        // whole screen to be operable at all.
        fullScreen={isMobile}
        slotProps={{ paper: { sx: { height: { xs: '100%', sm: 'min(90vh, 820px)' } } } }}
      >
        <DialogTitle sx={{ pb: 1, px: { xs: 2, sm: 3 } }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <SetListIcon color="primary" />
            <Typography variant="h6" noWrap sx={{ fontWeight: 700, flexGrow: 1, minWidth: 0 }}>
              {LL.SET_LISTS.TITLE()}
            </Typography>
          </Stack>
        </DialogTitle>

        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, overflow: 'hidden', px: { xs: 2, sm: 3 } }}>
          {/* Set list selector — scrolls horizontally rather than wrapping. The six list actions
              sit beside it as icons on desktop; on a phone they collapse into one overflow menu so the
              tab strip keeps the width. */}
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
            <Tabs
              value={activeId ?? false}
              onChange={(_e, value) => setActiveId(value as number)}
              variant="scrollable"
              scrollButtons
              allowScrollButtonsMobile
              sx={{ flexGrow: 1, minWidth: 0, minHeight: 44, '& .MuiTab-root': { minHeight: 44, textTransform: 'none' } }}
            >
              {lists.map((list) => (
                <Tab key={list.id} value={list.id} label={list.name} />
              ))}
            </Tabs>
            {isMobile ? (
              <RowActionMenu
                edge={false}
                actions={[
                  {
                    key: 'create',
                    label: LL.SET_LISTS.CREATE(),
                    icon: <AddIcon fontSize="small" />,
                    onClick: () => setNameDialog({ mode: 'create', value: '', bandIds: [] }),
                  },
                  {
                    key: 'rename',
                    label: LL.SET_LISTS.RENAME(),
                    icon: <EditIcon fontSize="small" />,
                    onClick: () =>
                      activeList && setNameDialog({ mode: 'rename', value: activeList.name, bandIds: activeList.bandIds ?? [] }),
                    hidden: !activeList,
                  },
                  {
                    key: 'copy',
                    label: copied ? LL.SET_LISTS.COPIED() : LL.SET_LISTS.COPY(),
                    icon: copied ? <CopiedIcon fontSize="small" /> : <CopyIcon fontSize="small" />,
                    onClick: handleCopyToClipboard,
                    disabled: !activeList || activeList.entries.length === 0,
                    hidden: !activeList,
                  },
                  {
                    key: 'move-left',
                    label: LL.SET_LISTS.MOVE_LEFT(),
                    icon: <MoveLeftIcon fontSize="small" />,
                    onClick: () => handleMoveSetList(-1),
                    disabled: activeIndex <= 0,
                    hidden: !activeList,
                  },
                  {
                    key: 'move-right',
                    label: LL.SET_LISTS.MOVE_RIGHT(),
                    icon: <MoveRightIcon fontSize="small" />,
                    onClick: () => handleMoveSetList(1),
                    disabled: activeIndex < 0 || activeIndex >= lists.length - 1,
                    hidden: !activeList,
                  },
                  {
                    key: 'delete',
                    label: LL.SET_LISTS.DELETE(),
                    icon: <DeleteIcon fontSize="small" />,
                    onClick: () => setDeleteListConfirm(true),
                    destructive: true,
                    hidden: !activeList,
                  },
                ]}
              />
            ) : (
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <Tooltip title={LL.SET_LISTS.CREATE()}>
                  <IconButton size="small" onClick={() => setNameDialog({ mode: 'create', value: '', bandIds: [] })}>
                    <AddIcon />
                  </IconButton>
                </Tooltip>
                {activeList && (
                  <>
                    <Tooltip title={LL.SET_LISTS.MOVE_LEFT()}>
                      <span>
                        <IconButton size="small" disabled={activeIndex <= 0} onClick={() => handleMoveSetList(-1)}>
                          <MoveLeftIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title={LL.SET_LISTS.MOVE_RIGHT()}>
                      <span>
                        <IconButton
                          size="small"
                          disabled={activeIndex < 0 || activeIndex >= lists.length - 1}
                          onClick={() => handleMoveSetList(1)}
                        >
                          <MoveRightIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title={LL.SET_LISTS.RENAME()}>
                      <IconButton
                        size="small"
                        onClick={() => setNameDialog({ mode: 'rename', value: activeList.name, bandIds: activeList.bandIds ?? [] })}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={copied ? LL.SET_LISTS.COPIED() : LL.SET_LISTS.COPY()}>
                      <span>
                        <IconButton
                          size="small"
                          color={copied ? 'success' : 'default'}
                          disabled={activeList.entries.length === 0}
                          onClick={handleCopyToClipboard}
                        >
                          {copied ? <CopiedIcon fontSize="small" /> : <CopyIcon fontSize="small" />}
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title={LL.SET_LISTS.DELETE()}>
                      <IconButton size="small" color="error" onClick={() => setDeleteListConfirm(true)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </>
                )}
              </Stack>
            )}
          </Stack>

          {/* Who plays this list. Read-only here; the picker lives in the rename dialog,
              where the list's own properties are edited. */}
          {activeList && (activeList.bandIds?.length ?? 0) > 0 && (
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
              <BandChips bandIds={activeList.bandIds} max={4} />
            </Stack>
          )}

          {errorMsg && (
            <Alert severity="error" onClose={() => setErrorMsg(null)}>
              {errorMsg}
            </Alert>
          )}

          {/* Search row — the mode control sits left of the field and drives its meaning */}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={mode}
              onChange={(_e, value: SearchMode | null) => value && setMode(value)}
              aria-label={LL.SET_LISTS.SEARCH_MODE()}
            >
              <ToggleButton value="filter" aria-label={LL.SET_LISTS.MODE_FILTER()}>
                <Tooltip title={LL.SET_LISTS.MODE_FILTER()}>
                  <FilterIcon fontSize="small" />
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="import" aria-label={LL.SET_LISTS.MODE_IMPORT()}>
                <Tooltip title={LL.SET_LISTS.MODE_IMPORT()}>
                  <ImportIcon fontSize="small" />
                </Tooltip>
              </ToggleButton>
            </ToggleButtonGroup>
            {/* The toggle above already shows the mode; on a phone this label is width the
                search field needs more. */}
            {!isMobile && (
              <Chip
                size="small"
                color={mode === 'import' ? 'secondary' : 'default'}
                variant={mode === 'import' ? 'filled' : 'outlined'}
                label={mode === 'filter' ? LL.SET_LISTS.MODE_FILTER() : LL.SET_LISTS.MODE_IMPORT()}
              />
            )}
            <TextField
              fullWidth
              size="small"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={!activeList}
              placeholder={mode === 'filter' ? LL.SET_LISTS.FILTER_PLACEHOLDER() : LL.SET_LISTS.IMPORT_PLACEHOLDER()}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                },
              }}
            />
            {/* Narrows the list to what this device has starred. Sits next to the search
                field because it is the same kind of narrowing, just a saved one. */}
            <Tooltip title={favoritesOnly ? LL.SET_LISTS.FAVORITES_SHOW_ALL() : LL.SET_LISTS.FAVORITES_ONLY()}>
              <span>
                <IconButton
                  size="small"
                  color={favoritesOnly ? 'warning' : 'default'}
                  disabled={!activeList}
                  onClick={() => setFavoritesOnly(!favoritesOnly)}
                >
                  {favoritesOnly ? <FavoriteIcon fontSize="small" /> : <NotFavoriteIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={LL.SET_LISTS.USAGE_SLIDER({ count: usageShowCount })}>
              <IconButton size="small" onClick={(e) => setUsageAnchor(e.currentTarget)}>
                <UsageIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={LL.SET_LISTS.UNDO_LAST_ADD()}>
              <span>
                <IconButton size="small" disabled={!lastAdded || !currentShow} onClick={handleUndoLastAdd}>
                  <UndoIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>

          <Divider />

          {/* Body */}
          <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {isLoading ? (
              <Stack sx={{ alignItems: 'center', p: 4 }}>
                <CircularProgress />
              </Stack>
            ) : isError ? (
              <Alert severity="error">{LL.SET_LISTS.ERROR_LOAD()}</Alert>
            ) : lists.length === 0 ? (
              <Stack spacing={2} sx={{ alignItems: 'center', p: 4, textAlign: 'center' }}>
                <Typography color="text.secondary">{LL.SET_LISTS.EMPTY_NO_LISTS()}</Typography>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => setNameDialog({ mode: 'create', value: '', bandIds: [] })}
                >
                  {LL.SET_LISTS.CREATE()}
                </Button>
              </Stack>
            ) : mode === 'import' ? (
              // ── Add mode: an empty box offers the current agenda, typing searches the library ──
              importQuery.length < 2 ? (
                agendaSuggestions.length > 0 ? (
                  <Box sx={{ px: 1, pt: 1 }}>
                    {renderSectionHeading(LL.SET_LISTS.FROM_AGENDA(), agendaSuggestions.length)}
                    <List dense disablePadding>
                      {agendaSuggestions.map(renderAddableRow)}
                    </List>
                    <Typography variant="caption" sx={{ px: 1, pb: 1, display: 'block', color: 'text.secondary' }}>
                      {LL.SET_LISTS.IMPORT_HINT()}
                    </Typography>
                  </Box>
                ) : (
                  <Stack spacing={1} sx={{ p: 3 }}>
                    {(currentShow?.order ?? []).some((i) => i.type === 'song') && (
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        {LL.SET_LISTS.FROM_AGENDA_EMPTY()}
                      </Typography>
                    )}
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {LL.SET_LISTS.IMPORT_HINT()}
                    </Typography>
                  </Stack>
                )
              ) : importFetching ? (
                <Stack sx={{ alignItems: 'center', p: 4 }}>
                  <CircularProgress size={28} />
                </Stack>
              ) : (libraryResults ?? []).length === 0 ? (
                <Typography sx={{ p: 3, color: 'text.secondary' }}>{LL.SET_LISTS.EMPTY_IMPORT({ query: importQuery })}</Typography>
              ) : (
                <Box sx={{ px: 1, pt: 1 }}>
                  {renderSectionHeading(LL.SET_LISTS.LIBRARY_RESULTS(), (libraryResults ?? []).length)}
                  <List dense disablePadding>
                    {(libraryResults ?? []).map(renderAddableRow)}
                  </List>
                </Box>
              )
            ) : sections.length === 0 ? (
              // ── Filter mode empty states ──
              <Typography sx={{ p: 3, color: 'text.secondary' }}>
                {favoritesOnly
                  ? LL.SET_LISTS.EMPTY_FAVORITES()
                  : search.trim()
                    ? LL.SET_LISTS.EMPTY_FILTER({ query: search.trim() })
                    : LL.SET_LISTS.EMPTY_SET_LIST()}
              </Typography>
            ) : (
              sections.map((section) => (
                <Accordion
                  key={section.name}
                  disableGutters
                  // A filter query force-opens the sections so matches are never hidden.
                  expanded={search.trim() ? true : (accordionState[section.name] ?? true)}
                  onChange={(_e, expanded) => !search.trim() && setAccordionOpen(section.name, expanded)}
                  sx={{ '&:before': { display: 'none' }, bgcolor: 'transparent' }}
                >
                  {/* Section header: the tag itself as a chip (so it reads as the thing it is),
                      the entry count, and a rule running to the edge to anchor it as a heading
                      rather than a line of text floating above the rows. */}
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%', pr: 1 }}>
                      <Chip
                        icon={<TagIcon sx={{ fontSize: '0.85rem' }} />}
                        label={section.label}
                        size="small"
                        color={section.name === UNTAGGED ? 'default' : 'primary'}
                        variant={section.name === UNTAGGED ? 'outlined' : 'filled'}
                        sx={{
                          fontWeight: 700,
                          fontStyle: section.name === UNTAGGED ? 'italic' : 'normal',
                          flexShrink: 0,
                          maxWidth: '60%',
                        }}
                      />
                      <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
                        {section.rows.length}
                      </Typography>
                      <Divider sx={{ flex: 1, minWidth: 16 }} />
                    </Stack>
                  </AccordionSummary>
                  <AccordionDetails sx={{ pt: 0 }}>
                    <List dense disablePadding>
                      {section.rows.map((row) => renderRow(row, section.name))}
                    </List>
                  </AccordionDetails>
                </Accordion>
              ))
            )}
          </Box>
        </DialogContent>

        <DialogActions>
          <Button onClick={onClose}>{LL.COMMON.CLOSE()}</Button>
        </DialogActions>
      </Dialog>

      {/* Remove: tag assignment only vs. the whole song */}
      <Popover
        open={!!removeCtx}
        anchorEl={removeCtx?.anchor ?? null}
        onClose={() => setRemoveCtx(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Stack spacing={1} sx={{ p: 2, maxWidth: 320 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {removeCtx ? entryTitle(removeCtx.entry) : ''}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {removeCtx && removeCtx.tagName && removeCtx.entry.tags.length > 1
              ? LL.SET_LISTS.REMOVE_MULTI_HINT({ tag: removeCtx.tagName })
              : LL.SET_LISTS.REMOVE_SINGLE_HINT()}
          </Typography>
          <Stack spacing={1} sx={{ pt: 0.5 }}>
            {removeCtx && removeCtx.tagName && removeCtx.entry.tags.length > 1 && (
              <Button size="small" variant="outlined" onClick={() => handleRemove('tag')}>
                {LL.SET_LISTS.REMOVE_TAG_ONLY({ tag: removeCtx.tagName })}
              </Button>
            )}
            <Button size="small" variant="contained" color="error" onClick={() => handleRemove('song')}>
              {LL.SET_LISTS.REMOVE_SONG_ENTIRELY()}
            </Button>
            <Button size="small" onClick={() => setRemoveCtx(null)}>
              {LL.COMMON.CANCEL()}
            </Button>
          </Stack>
        </Stack>
      </Popover>

      {/* Usage window — how many of the most recently saved shows feed the per-song counts.
          Dragging only re-slices the already-fetched window; the setting persists on release. */}
      <Popover
        open={!!usageAnchor}
        anchorEl={usageAnchor}
        onClose={() => setUsageAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Stack spacing={0.5} sx={{ px: 2.5, pt: 1.5, pb: 3, width: { xs: 240, sm: 300 }, maxWidth: '90vw', overflow: 'hidden' }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {LL.SET_LISTS.USAGE_SLIDER({ count: usageShowCount })}
          </Typography>
          <Slider
            size="small"
            min={1}
            max={MAX_USAGE_SHOWS}
            value={usageShowCount}
            onChange={(_e, value) => setUsageShowCount(value as number)}
            onChangeCommitted={(_e, value) => updateSetting('setLists', { ...setListSettings, usageShowCount: value as number })}
            valueLabelDisplay="auto"
            marks={[
              { value: 1, label: '1' },
              { value: 8, label: '8' },
              { value: MAX_USAGE_SHOWS, label: String(MAX_USAGE_SHOWS) },
            ]}
            aria-label={LL.SET_LISTS.USAGE_SLIDER({ count: usageShowCount })}
          />
        </Stack>
      </Popover>

      {/* Create / rename set list */}
      <Dialog open={!!nameDialog} onClose={() => setNameDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{nameDialog?.mode === 'rename' ? LL.SET_LISTS.RENAME() : LL.SET_LISTS.CREATE()}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <TextField
              autoFocus
              margin="dense"
              fullWidth
              label={LL.COMMON.NAME()}
              value={nameDialog?.value ?? ''}
              onChange={(e) => setNameDialog((d) => (d ? { ...d, value: e.target.value } : d))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleNameSubmit();
                }
              }}
            />
            {/* Which bands work from this list. Nothing is filtered by it — it labels the
                list and feeds the tag suggestions with the right names. */}
            <BandPicker
              value={nameDialog?.bandIds ?? []}
              onChange={(bandIds) => setNameDialog((d) => (d ? { ...d, bandIds } : d))}
              label={LL.BANDS.ASSIGN_LABEL()}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNameDialog(null)}>{LL.COMMON.CANCEL()}</Button>
          <Button variant="contained" onClick={handleNameSubmit} disabled={!nameDialog?.value.trim()}>
            {nameDialog?.mode === 'rename' ? LL.COMMON.SAVE() : LL.COMMON.ADD()}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete set list confirmation */}
      <Dialog open={deleteListConfirm} onClose={() => setDeleteListConfirm(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{LL.SET_LISTS.DELETE()}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{LL.SET_LISTS.DELETE_CONFIRM({ name: activeList?.name ?? '' })}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteListConfirm(false)}>{LL.COMMON.CANCEL()}</Button>
          <Button variant="contained" color="error" onClick={handleDeleteList}>
            {LL.COMMON.DELETE()}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Tag assignment editor */}
      <SetListTagEditor
        open={!!tagEditorEntry}
        onClose={() => setTagEditorEntry(null)}
        entry={tagEditorEntry}
        knownTags={knownTags}
        knownKeys={knownKeys}
        onSave={async (tags) => {
          if (!tagEditorEntry) return;
          await runGuarded(async () => {
            await setEntryTags({ entryId: tagEditorEntry.id, tags }).unwrap();
          });
        }}
      />
    </>
  );
};
