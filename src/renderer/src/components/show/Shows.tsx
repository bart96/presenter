import { useState, useEffect, type UIEvent } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Stack,
  Typography,
  CircularProgress,
  Alert,
  Box,
  Chip,
  Paper,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  CheckCircle as CheckCircleIcon,
  Event as EventIcon,
  Edit as EditIcon,
  Upload as UploadIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetShowsQuery, useLazyGetShowQuery, useDeleteShowMutation, useSaveShowMutation } from '@/api/shows.api';
import type { Show } from '@/api/shows.api';
import { useGetSettings } from '@/store/settingsSlice';
import { useGetSessionQuery } from '@/api/session.api';
import { type CtEvent } from '@/api/churchtools.api';
import { EventPicker } from '@/components/show/EventPicker';
import { BandChips, BandPicker } from '@/components/common/BandPicker';
import { RowActionMenu } from '@/components/common/RowActionMenu';
import { useIsMobile } from '@/hooks/useIsMobile';
import { SONG_CUSTOM_NUMBER_LIMIT } from '@/song';
import ccliIcon from '@/assets/ccli.svg';

interface ShowsProps {
  open: boolean;
  onShowSelected: (show: Show | null, isNew: boolean, override?: boolean) => void;
  onClose?: () => void;
  allowClose?: boolean;
  currentShowTitle?: string;
}

// Function to resolve date/time variables in template (defaults to now, or a given date —
// e.g. a linked ChurchTools event's date).
const resolveShowTemplate = (template: string, date?: Date): string => {
  const now = date ?? new Date();

  const replacements: Record<string, string> = {
    yyyy: now.getFullYear().toString(),
    yy: now.getFullYear().toString().slice(-2),
    MM: (now.getMonth() + 1).toString().padStart(2, '0'),
    M: (now.getMonth() + 1).toString(),
    dd: now.getDate().toString().padStart(2, '0'),
    d: now.getDate().toString(),
    HH: now.getHours().toString().padStart(2, '0'),
    H: now.getHours().toString(),
    mm: now.getMinutes().toString().padStart(2, '0'),
    m: now.getMinutes().toString(),
    ss: now.getSeconds().toString().padStart(2, '0'),
    s: now.getSeconds().toString(),
  };

  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }

  return result;
};

export const Shows = ({ open, onShowSelected, onClose, allowClose = false, currentShowTitle }: ShowsProps) => {
  const { LL } = useI18nContext();
  const { showSaveFormat } = useGetSettings();
  const isMobile = useIsMobile();

  const [selectedShow, setSelectedShow] = useState<Show | null>(null);
  const [newShowTitle, setNewShowTitle] = useState('');
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CtEvent | null>(null);
  /** Bands picked for the show being created — several may share one service. */
  const [newShowBands, setNewShowBands] = useState<number[]>([]);
  // Whether the user has manually edited the title (stops auto-resolving from the template).
  const [titleEdited, setTitleEdited] = useState(false);

  const [showToDelete, setShowToDelete] = useState<string | null>(null);
  const [confirmOverride, setConfirmOverride] = useState<Show | null>(null);
  const [showToRename, setShowToRename] = useState<Show | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameEvent, setRenameEvent] = useState<CtEvent | null>(null);
  const [renameBands, setRenameBands] = useState<number[]>([]);
  // Infinite scroll: start with 10 shows, load 10 more each time the list is scrolled to the end.
  const SHOWS_PAGE_SIZE = 10;
  const [visibleCount, setVisibleCount] = useState(SHOWS_PAGE_SIZE);

  const { data: session } = useGetSessionQuery();
  const churchToolsEnabled = session?.settings?.churchToolsEnabled ?? false;

  const { data: showsData, isLoading, isFetching, refetch } = useGetShowsQuery({ limit: visibleCount, page: 0 });
  const [deleteShowMutation] = useDeleteShowMutation();
  const [saveShowMutation] = useSaveShowMutation();
  const [fetchShow] = useLazyGetShowQuery();

  // Buffer the list so growing the limit (load-more) doesn't blank it out while the new page loads.
  const [shows, setShows] = useState<Show[]>([]);
  useEffect(() => {
    if (showsData?.shows) setShows(showsData.shows);
  }, [showsData]);

  // A full page came back → there may be more to load.
  const hasMoreShows = shows.length >= visibleCount;

  const handleShowsScroll = (e: UIEvent<HTMLUListElement>) => {
    if (!hasMoreShows || isFetching) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      setVisibleCount((c) => c + SHOWS_PAGE_SIZE);
    }
  };

  const getCcliSongNumbers = (show: Show): number[] =>
    Array.from(
      new Set(
        (show.order ?? [])
          .filter((item) => item.type === 'song' && typeof item.songNumber === 'number' && item.songNumber >= SONG_CUSTOM_NUMBER_LIMIT)
          .map((item) => item.songNumber as number),
      ),
    );

  const openCcliReport = (show: Show) => {
    const songNumbers = getCcliSongNumbers(show);
    if (songNumbers.length === 0) return;
    const url = `https://reporting.ccli.com/search?s=${encodeURIComponent(songNumbers.join('|'))}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Reset to show list when dialog closes/opens
  useEffect(() => {
    if (open) {
      setIsCreatingNew(false);
      setNewShowTitle('');
      setSelectedShow(null);
      setSelectedEvent(null);
      setNewShowBands([]);
      setTitleEdited(false);
      setVisibleCount(SHOWS_PAGE_SIZE);
    }
  }, [open]);

  // Generate the default show title from the template. When an event is linked, resolve
  // date placeholders against the event's date so the title follows the selected event —
  // unless the user has manually edited the title.
  useEffect(() => {
    if (isCreatingNew && !titleEdited) {
      const eventDate = selectedEvent?.startDate ? new Date(selectedEvent.startDate) : undefined;
      setNewShowTitle(resolveShowTemplate(showSaveFormat, eventDate));
    }
  }, [isCreatingNew, selectedEvent, showSaveFormat, titleEdited]);

  const handleSelectShow = (show: Show) => {
    setSelectedShow(show);
  };

  const handleConfirmSelection = () => {
    if (selectedShow) {
      onShowSelected(selectedShow, false);
      onClose?.();
    }
  };

  const handleCreateOrOverride = async () => {
    const title = newShowTitle.trim();
    if (!title) return;

    // Reliable existence check — the loaded list is paginated, so confirm against the server
    // before creating (the save is an upsert and would silently overwrite a hidden show).
    let existingShow = shows.find((s) => s.title === title);
    if (!existingShow) {
      try {
        const res = await fetchShow({ title }).unwrap();
        existingShow = res.shows?.[0];
      } catch {
        /* treat as not found */
      }
    }

    if (existingShow) {
      // Show confirmation dialog for override
      setConfirmOverride(existingShow);
    } else {
      // Create new show, optionally linked to a ChurchTools event for agenda sync.
      const newShow: Show = {
        title,
        order: [],
        eventId: selectedEvent?.id ?? null,
        eventName: selectedEvent?.name ?? null,
        bandIds: newShowBands,
      };
      onShowSelected(newShow, true, false);
      setNewShowTitle('');
      setNewShowBands([]);
      setIsCreatingNew(false);
      onClose?.();
    }
  };

  const handleConfirmOverride = () => {
    if (confirmOverride) {
      const overrideShow: Show = {
        title: confirmOverride.title,
        order: [],
      };
      onShowSelected(overrideShow, true, true);
      setNewShowTitle('');
      setIsCreatingNew(false);
      setConfirmOverride(null);
      onClose?.();
    }
  };

  const handleDeleteShow = async (title: string) => {
    try {
      await deleteShowMutation({ title }).unwrap();
      if (selectedShow?.title === title) {
        setSelectedShow(null);
      }
      setShowToDelete(null);
      refetch();
    } catch (error) {
      console.error('Failed to delete show:', error);
    }
  };

  const handleRenameShow = async () => {
    if (!showToRename || !renameTitle.trim()) {
      return;
    }
    const titleChanged = renameTitle.trim() !== showToRename.title;
    const eventChanged = (renameEvent?.id ?? null) !== (showToRename.eventId ?? null);
    const bandsChanged = renameBands.join() !== (showToRename.bandIds ?? []).join();
    if (!titleChanged && !eventChanged && !bandsChanged) {
      setShowToRename(null);
      return;
    }

    try {
      // Renaming changes the primary key, so delete the old row first.
      if (titleChanged) {
        await deleteShowMutation({ title: showToRename.title }).unwrap();
      }

      // Upsert with the (possibly new) title, content, and event link.
      await saveShowMutation({
        title: renameTitle.trim(),
        order: showToRename.order,
        groups: showToRename.groups,
        styleId: showToRename.styleId ?? null,
        eventId: renameEvent?.id ?? null,
        eventName: renameEvent?.name ?? null,
        // Always sent, even unchanged: a rename deletes the old row, and the band
        // assignments cascade with it. Omitting them here would silently drop them.
        bandIds: renameBands,
      }).unwrap();

      // The save endpoint reconciles the linked event's agenda automatically (the save above
      // carries the new eventId), so no separate sync call is needed here.

      setShowToRename(null);
      setRenameTitle('');
      setRenameEvent(null);
      setRenameBands([]);
      refetch();
    } catch (error) {
      console.error('Failed to rename show:', error);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        maxWidth="sm"
        fullWidth
        // This dialog is the entry point of the app on mobile — give it the whole screen so the
        // list gets the height instead of the backdrop.
        fullScreen={isMobile}
        onClose={
          allowClose
            ? onClose
            : (_event, reason) => {
                if (reason !== 'escapeKeyDown') {
                  onClose?.();
                }
              }
        }
      >
        <DialogTitle>
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: 'center',
            }}
          >
            <EventIcon />
            <Typography variant="h6">{isCreatingNew ? LL.SHOWS.NEW() : LL.SHOWS.TITLE()}</Typography>
            <Box sx={{ flexGrow: 1 }} />
            {!isCreatingNew && (
              <Tooltip title={LL.SHOWS.REFETCH()}>
                <IconButton size="small" onClick={() => refetch()} disabled={isLoading}>
                  {isLoading ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
            )}
          </Stack>
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, px: { xs: 2, sm: 3 } }}>
          {isCreatingNew ? (
            <Stack spacing={3} sx={{ mt: 1 }}>
              <Alert severity="info" icon={<AddIcon />}>
                {LL.SHOWS.CREATE_INFO()}
              </Alert>
              <TextField
                autoFocus
                label={LL.COMMON.TITLE()}
                fullWidth
                value={newShowTitle}
                onChange={(e) => {
                  setTitleEdited(true);
                  setNewShowTitle(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newShowTitle.trim()) {
                    handleCreateOrOverride();
                  }
                }}
                placeholder={LL.SHOWS.PLACEHOLDER()}
              />

              {/* Who plays it. Labels the show and preselects the band in the order-name
                  and tag suggestions while it is open. */}
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  {LL.BANDS.TITLE()}
                </Typography>
                <BandPicker value={newShowBands} onChange={setNewShowBands} />
              </Box>

              {/* Optionally link to a ChurchTools event — songs sync to its agenda on save. */}
              {churchToolsEnabled && (
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    {LL.SHOWS.LINK_EVENT()}
                  </Typography>
                  <Paper variant="outlined">
                    <EventPicker value={selectedEvent} onChange={setSelectedEvent} />
                  </Paper>
                </Box>
              )}
            </Stack>
          ) : (
            <Stack spacing={2} sx={{ flex: 1, minHeight: 0 }}>
              {isLoading && shows.length === 0 ? (
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'center',
                    p: 4,
                  }}
                >
                  <CircularProgress />
                </Box>
              ) : shows.length === 0 ? (
                <Paper sx={{ p: 4, textAlign: 'center', bgcolor: 'background.default' }}>
                  <EventIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
                  <Typography variant="h6" gutterBottom>
                    {LL.SHOWS.NO_SHOWS()}
                  </Typography>
                  <Typography
                    component="p"
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    {LL.SHOWS.EMPTY_HELP()}
                  </Typography>
                  <Button variant="contained" startIcon={<AddIcon />} onClick={() => setIsCreatingNew(true)}>
                    {LL.SHOWS.NEW()}
                  </Button>
                </Paper>
              ) : (
                <>
                  <Typography
                    variant="body2"
                    sx={{
                      color: 'text.secondary',
                      mb: 1,
                    }}
                  >
                    {LL.SHOWS.SELECT_PROMPT()}
                  </Typography>
                  <Paper variant="outlined" sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <List sx={{ flex: 1, minHeight: 0, maxHeight: { xs: 'none', sm: 450 }, overflow: 'auto' }} onScroll={handleShowsScroll}>
                      {shows.map((show, index) => {
                        const isCurrentShow = !!(currentShowTitle && show.title === currentShowTitle);
                        const isSelected = selectedShow?.title === show.title;

                        const renameShow = () => {
                          setShowToRename(show);
                          setRenameTitle(show.title);
                          setRenameEvent(
                            show.eventId ? { id: show.eventId, name: show.eventName ?? `#${show.eventId}`, startDate: null } : null,
                          );
                          setRenameBands(show.bandIds ?? []);
                        };

                        // Four unlabelled icons do not fit next to a date-stamped title on a
                        // phone, so there they collapse into one menu that can name each action.
                        const rowActions = isMobile ? (
                          <RowActionMenu
                            actions={[
                              {
                                key: 'save',
                                label: LL.SHOWS.SAVE_CURRENT_TOOLTIP(),
                                icon: <UploadIcon fontSize="small" />,
                                onClick: () => setConfirmOverride(show),
                              },
                              {
                                key: 'ccli',
                                label: LL.SHOWS.CCLI_REPORT(),
                                icon: <Box component="img" src={ccliIcon} alt="" sx={{ width: 18, height: 18 }} />,
                                onClick: () => openCcliReport(show),
                                disabled: getCcliSongNumbers(show).length === 0,
                              },
                              {
                                key: 'rename',
                                label: LL.SHOWS.RENAME_TOOLTIP(),
                                icon: <EditIcon fontSize="small" />,
                                onClick: renameShow,
                              },
                              {
                                key: 'delete',
                                label: LL.SHOWS.DELETE_TOOLTIP(),
                                icon: <DeleteIcon fontSize="small" />,
                                onClick: () => setShowToDelete(show.title),
                                disabled: isCurrentShow,
                                destructive: true,
                              },
                            ]}
                          />
                        ) : (
                          <Stack direction="row" spacing={0.5}>
                            <Tooltip title={LL.SHOWS.SAVE_CURRENT_TOOLTIP()}>
                              <IconButton
                                edge="end"
                                size="small"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmOverride(show);
                                }}
                              >
                                <UploadIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title={LL.SHOWS.CCLI_REPORT()}>
                              <span>
                                <IconButton
                                  edge="end"
                                  size="small"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openCcliReport(show);
                                  }}
                                  disabled={getCcliSongNumbers(show).length === 0}
                                >
                                  <Box component="img" src={ccliIcon} alt="CCLI" sx={{ width: 16, height: 16 }} />
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title={LL.SHOWS.RENAME_TOOLTIP()}>
                              <IconButton
                                edge="end"
                                size="small"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  renameShow();
                                }}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title={LL.SHOWS.DELETE_TOOLTIP()}>
                              <IconButton
                                edge="end"
                                size="small"
                                color="error"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowToDelete(show.title);
                                }}
                                disabled={isCurrentShow}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        );

                        return (
                          <ListItem
                            key={show.title}
                            disablePadding
                            divider={index < shows.length - 1}
                            secondaryAction={rowActions}
                            sx={{
                              // Keep the row text clear of the absolutely positioned actions:
                              // one menu button on mobile, the four-icon cluster on desktop.
                              '& > .MuiListItemButton-root': { pr: { xs: '48px', sm: '150px' } },
                            }}
                          >
                            <ListItemButton
                              selected={isSelected}
                              onClick={() => handleSelectShow(show)}
                              sx={{
                                borderLeft: isCurrentShow ? 4 : 0,
                                borderColor: 'success.main',
                                minWidth: 0,
                              }}
                            >
                              <ListItemText
                                primary={
                                  <Stack
                                    direction="row"
                                    spacing={1}
                                    sx={{
                                      alignItems: 'center',
                                      minWidth: 0,
                                    }}
                                  >
                                    <Typography variant="body1" noWrap sx={{ minWidth: 0 }}>
                                      {show.title}
                                    </Typography>
                                    {isCurrentShow && (
                                      <Chip
                                        label={LL.SHOWS.CURRENT()}
                                        size="small"
                                        color="success"
                                        icon={<CheckCircleIcon />}
                                        sx={{ flexShrink: 0 }}
                                      />
                                    )}
                                  </Stack>
                                }
                                secondary={
                                  <Stack
                                    direction="row"
                                    spacing={1}
                                    sx={{
                                      alignItems: 'center',
                                    }}
                                  >
                                    <Typography variant="caption">
                                      {`${(show.order ?? []).length} ${(show.order ?? []).length === 1 ? (LL as any).SONG() : (LL as any).SONGS()}`}
                                    </Typography>
                                    {show.date && (
                                      <>
                                        <Typography variant="caption">•</Typography>
                                        <Typography
                                          variant="caption"
                                          sx={{
                                            color: 'text.secondary',
                                          }}
                                        >
                                          {new Date(show.date).toLocaleString()}
                                        </Typography>
                                      </>
                                    )}
                                    <BandChips bandIds={show.bandIds} max={2} />
                                  </Stack>
                                }
                                slotProps={{
                                  secondary: { component: 'div' } as object,
                                }}
                                sx={{ minWidth: 0, my: 0 }}
                              />
                            </ListItemButton>
                          </ListItem>
                        );
                      })}
                      {isFetching && shows.length > 0 && (
                        <Box sx={{ display: 'flex', justifyContent: 'center', py: 1.5 }}>
                          <CircularProgress size={22} />
                        </Box>
                      )}
                    </List>
                  </Paper>
                </>
              )}
            </Stack>
          )}
        </DialogContent>
        <Divider />
        <DialogActions sx={{ p: 2 }}>
          {isCreatingNew ? (
            <>
              <Button
                onClick={() => {
                  setIsCreatingNew(false);
                  setNewShowTitle('');
                }}
              >
                {LL.COMMON.CANCEL()}
              </Button>
              <Button onClick={handleCreateOrOverride} variant="contained" disabled={!newShowTitle.trim()} startIcon={<AddIcon />}>
                {LL.COMMON.SAVE()}
              </Button>
            </>
          ) : (
            <>
              {shows.length > 0 && (
                <Button startIcon={<AddIcon />} onClick={() => setIsCreatingNew(true)}>
                  {LL.SHOWS.NEW()}
                </Button>
              )}
              <Box
                sx={{
                  flexGrow: 1,
                }}
              />
              {allowClose && <Button onClick={onClose}>{LL.COMMON.CANCEL()}</Button>}
              <Button onClick={handleConfirmSelection} variant="contained" disabled={!selectedShow}>
                {LL.COMMON.CONFIRM()}
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
      {/* Delete confirmation dialog */}
      <Dialog open={!!showToDelete} onClose={() => setShowToDelete(null)} maxWidth="xs">
        <DialogTitle>{LL.ADMIN.CONFIRM_DELETE()}</DialogTitle>
        <DialogContent>
          <Typography>
            {LL.SHOWS.DELETE_CONFIRMATION_START()}
            <strong>&quot;{showToDelete}&quot;</strong>?
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
              mt: 1,
            }}
          >
            {LL.ADMIN.ACTION_CANNOT_BE_UNDONE()}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowToDelete(null)}>{LL.COMMON.CANCEL()}</Button>
          <Button onClick={() => showToDelete && handleDeleteShow(showToDelete)} color="error" variant="contained">
            {LL.COMMON.DELETE()}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Override confirmation dialog */}
      <Dialog open={!!confirmOverride} onClose={() => setConfirmOverride(null)} maxWidth="xs">
        <DialogTitle>{LL.SHOWS.SAVE_OVERRIDE_TITLE()}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            {newShowTitle ? (
              <>
                {LL.SHOWS.SAVE_OVERRIDE_EXISTING()}
                <strong>&quot;{newShowTitle}&quot;</strong>
              </>
            ) : (
              <>
                {LL.SHOWS.SAVE_OVERRIDE_TO()}
                <strong>&quot;{confirmOverride?.title}&quot;</strong>
              </>
            )}
          </Alert>
          <Typography variant="body2">
            {LL.SHOWS.SAVE_OVERRIDE_DESCRIPTION_START()}
            <strong>
              {confirmOverride?.order?.length || 0} {LL.COMMON.SONGS()}
            </strong>
            {LL.SHOWS.SAVE_OVERRIDE_DESCRIPTION_END()}
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
              mt: 1,
            }}
          >
            {LL.ADMIN.ACTION_CANNOT_BE_UNDONE()}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOverride(null)}>{LL.COMMON.CANCEL()}</Button>
          <Button onClick={handleConfirmOverride} color="warning" variant="contained" startIcon={<UploadIcon />}>
            {LL.COMMON.SAVE()} & {LL.COMMON.OVERRIDE()}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Edit dialog — rename + (re)link a ChurchTools event */}
      <Dialog open={!!showToRename} onClose={() => setShowToRename(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{LL.SHOWS.RENAME_DIALOG_TITLE()}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label={LL.COMMON.TITLE()}
            fullWidth
            value={renameTitle}
            onChange={(e) => setRenameTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameTitle.trim() && showToRename) {
                handleRenameShow();
              }
            }}
          />
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              {LL.BANDS.TITLE()}
            </Typography>
            <BandPicker value={renameBands} onChange={setRenameBands} />
          </Box>
          {churchToolsEnabled && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2" gutterBottom>
                {LL.SHOWS.LINK_EVENT()}
              </Typography>
              <Paper variant="outlined">
                <EventPicker value={renameEvent} onChange={setRenameEvent} />
              </Paper>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowToRename(null)}>{LL.COMMON.CANCEL()}</Button>
          <Button
            onClick={handleRenameShow}
            variant="contained"
            disabled={
              !renameTitle.trim() ||
              (renameTitle === showToRename?.title &&
                (renameEvent?.id ?? null) === (showToRename?.eventId ?? null) &&
                renameBands.join() === (showToRename?.bandIds ?? []).join())
            }
          >
            {LL.COMMON.SAVE()}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
