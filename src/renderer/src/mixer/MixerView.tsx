/**
 * MixerView — the monitor mixer, and the entry point of the lazily-loaded mixer chunk.
 *
 * Nothing in `@/mixer` is fetched until this module is imported, which happens when a
 * musician presses the mixer button and not before. That is why the launcher, the bridge
 * hook and the protocol types live outside it: they are what the musician page needs in
 * order to decide whether the button exists at all.
 *
 * The screen is one mix at a time — the wedge you are standing in front of — with its
 * inputs as a horizontally scrollable row of faders and the mix's own master pinned to
 * the right where it cannot scroll away. Which strips appear is this device's business
 * and nobody else's (contract §4.2): a tech's tablet and a guitarist's phone want
 * different six channels, and syncing that choice would have them overwrite each other.
 *
 * **It opens as a panel across the bottom third, not full screen.** The usual reason to
 * open a monitor mixer mid-service is to nudge one thing and carry on playing, and a
 * full-screen mixer takes the music away to do it. The shape of the device agrees: tablets
 * on a stand are in portrait, where stretching a dozen faders over the whole height buys
 * travel nobody needs and costs the page you were reading. Full screen is one tap away for
 * when someone is actually building a mix, and which one you get is remembered per device.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Block as MainMuteIcon,
  Close as CloseIcon,
  CloseFullscreen as CollapseIcon,
  GraphicEq as MeterIcon,
  MoreVert as MoreVertIcon,
  OpenInFull as ExpandIcon,
  Tune as StripsIcon,
  VerticalAlignBottom as BottomIcon,
  VolumeOff as MuteIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetMusicianSettings, useUpdateMusicianSetting } from '@/store/musicianSlice';
import { formatDb } from '@/audio/fader';
import type { MixerBridge } from '@/hooks/useMixerBridge';
import type { MixerAnnouncement } from '@/audio/protocol';
import { MixerChannel } from './MixerChannel';
import { MixerFader } from './MixerFader';
import { MixerMeter } from './MixerMeter';
import { MixerResizeHandle, PANEL_MAX_VH } from './MixerResizeHandle';
import { MixerStripPicker } from './MixerStripPicker';
import { useMixerSession } from './useMixerSession';

interface MixerViewProps {
  bridge: MixerBridge;
  announcement: MixerAnnouncement;
  onClose: () => void;
  /**
   * Whether the mixer is actually on screen. It stays mounted when closed so reopening is
   * instant, which is only worth doing if it stops costing anything while hidden.
   */
  active: boolean;
}

const MixerView = ({ bridge, announcement, onClose, active }: MixerViewProps) => {
  const { LL } = useI18nContext();
  const {
    mixerLastMixId,
    mixerVisibleStrips,
    mixerShowStripMutes,
    mixerShowMeters,
    mixerCompact,
    mixerPanelHeight,
    mixerMyStrips,
    mixerMainMuteAtBottom,
  } = useGetMusicianSettings();
  const updateSetting = useUpdateMusicianSetting();

  const [selectedMixId, setSelectedMixId] = useState(mixerLastMixId);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * Height while the grip is being dragged. Local, so the panel follows the finger without
   * writing the whole settings object to localStorage on every frame — see the note in
   * `MixerResizeHandle`. Cleared on release, once the committed value has taken over.
   */
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const { permissions, capabilities, link, mixer } = announcement;

  /**
   * Meters are four separate yeses: the mixer is on screen, the desk can produce them, the
   * operator allows them on the relay, and this device wants them. Any one being no means
   * the client never subscribes — so the traffic is not merely hidden, it is not sent, and
   * the operator stops asking the desk for meters once the last listener goes away.
   */
  const metersWanted = active && mixerShowMeters && permissions.meters && !!capabilities?.meters;
  /** What the meters *switch* says, independent of whether the mixer is on screen. */
  const metersPreferred = mixerShowMeters && permissions.meters && !!capabilities?.meters;

  /**
   * The channels this device shows on this mix — always an explicit list.
   *
   * A device with no preference yet shows **none**, not all. An X32 has forty-eight
   * strips and a musician cares about six; opening onto all of them is a wall of faders
   * to scroll past before you can do anything, and it is the one screen a new user meets.
   * Starting empty makes the first action "pick your channels", which is the right one.
   *
   * Memoised: it keys the subscription.
   */
  const visibleStripIds = useMemo(() => mixerVisibleStrips[selectedMixId] ?? [], [mixerVisibleStrips, selectedMixId]);

  const session = useMixerSession({
    bridge,
    mixId: selectedMixId || undefined,
    stripIds: visibleStripIds,
    meters: metersWanted,
  });

  const { mixes, strips, muteGroups, ready, send, onMeters, lastError } = session;

  /**
   * The mixes as the chips show them, with the main first.
   *
   * The desk publishes it last, because on a console the master lives at the right-hand
   * end. On a phone that row scrolls, and the one mix everybody recognises should not be
   * the one you have to go looking for. The buses keep the desk's own order behind it —
   * sort is stable — so a numbered wedge stays where the numbering says it is.
   *
   * Only the order moves. A musician still *opens* on a bus rather than the main, because
   * the mix they came for is their own wedge and not the room; see the fallback below.
   */
  const mixesInOrder = useMemo(() => [...mixes].sort((a, b) => Number(b.kind === 'main') - Number(a.kind === 'main')), [mixes]);

  // ── Which mix ──────────────────────────────────────────────────────────────
  // The remembered mix may not exist any more: the operator's allow-list changed, or this
  // phone was last used at another venue. Fall back rather than showing an empty screen.
  //
  // Adjusted during render rather than in an effect, which is what React recommends for
  // state that a new prop has invalidated — an effect would paint one frame of a mixer
  // with no mix selected before correcting itself.
  if (mixes.length && !mixes.some((mix) => mix.id === selectedMixId)) {
    setSelectedMixId((mixes.find((mix) => mix.kind === 'bus') ?? mixes[0]).id);
  }

  useEffect(() => {
    if (selectedMixId && selectedMixId !== mixerLastMixId) updateSetting('mixerLastMixId', selectedMixId);
  }, [selectedMixId, mixerLastMixId, updateSetting]);

  const selectedMix = mixes.find((mix) => mix.id === selectedMixId);

  /** The desk is not answering. Controls stay put and go inert — see contract §8. */
  const deskDown = link === 'offline' || link === 'connecting' || (!!mixer && !mixer.connected);

  const shownStrips = useMemo(() => {
    const wanted = new Set(visibleStripIds);
    return strips.filter((strip) => wanted.has(strip.id));
  }, [strips, visibleStripIds]);

  /** Every channel the desk offers, for the picker's "show all". */
  const allStripIds = useMemo(() => strips.map((strip) => strip.id), [strips]);

  /** Marked channels, as a set — read once per strip while the row renders. */
  const mineSet = useMemo(() => new Set(mixerMyStrips), [mixerMyStrips]);

  const setVisibleStrips = useCallback(
    (ids: string[]) => {
      updateSetting('mixerVisibleStrips', { ...mixerVisibleStrips, [selectedMixId]: ids });
    },
    [mixerVisibleStrips, selectedMixId, updateSetting],
  );

  /**
   * Per-mix mute buttons exist only where the hardware has them.
   *
   * On an X-Air `setSendMute` is refused outright rather than falling back to the strip
   * mute, so drawing the button there would offer a control that can only ever fail.
   * `sends.main` never carries one on any desk — a strip's contribution to the main *is*
   * its fader.
   */
  const showSendMutes = !!capabilities?.sendMutes && selectedMix?.kind === 'bus';

  /**
   * Where the "mute everywhere" button appears.
   *
   * The operator's permission is the gate, and nothing below it can open one. What the
   * device switch decides is only how *far* the button spreads: on your own channels it is
   * always there once it is allowed, and the switch adds it to everybody else's.
   *
   * Your own channel is the one case where muting everywhere is plainly the thing you
   * meant — a guitarist swapping an instrument is taking themselves out of the room, not
   * out of one wedge — so making them find a second switch first only hides the control
   * from the person it is for. Somebody else's channel is the loaded gun the switch exists
   * to keep holstered.
   */
  const stripMuteShown = useCallback(
    (id: string) => permissions.stripMutes && (mixerShowStripMutes || mineSet.has(id)),
    [permissions.stripMutes, mixerShowStripMutes, mineSet],
  );

  /** Whether any strip on screen has one, so the rest can hold the space open. */
  const anyStripMute = useMemo(() => shownStrips.some((strip) => stripMuteShown(strip.id)), [shownStrips, stripMuteShown]);

  /**
   * What the panel is currently as tall as.
   *
   * Until someone drags it, a third of the viewport floored and capped: a third of a phone
   * in landscape is too little to hold a fader, and a third of a desktop browser is more
   * than this ever needs. A dragged height wins, but `min()` still caps it against the
   * viewport in CSS — so rotating a tablet cannot leave a panel taller than its screen,
   * without this needing to watch for resizes.
   */
  const panelHeight =
    dragHeight !== null
      ? `${dragHeight}px`
      : mixerPanelHeight > 0
        ? `min(${mixerPanelHeight}px, ${PANEL_MAX_VH * 100}vh)`
        : 'clamp(200px, 34vh, 380px)';

  return (
    <Box
      ref={panelRef}
      sx={{
        position: 'fixed',
        zIndex: 1300,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#141618',
        color: 'rgba(255,255,255,0.92)',
        ...(mixerCompact
          ? {
              // The bottom third, floored and capped: a third of a phone in landscape is
              // too little to hold a fader, and a third of a desktop browser is more than
              // this ever needs. Everything above it stays visible *and* usable — there is
              // no backdrop, so the sheet can still be scrolled while a fader is open.
              left: 0,
              right: 0,
              bottom: 0,
              height: panelHeight,
              borderTop: '1px solid rgba(255,255,255,0.16)',
              boxShadow: '0 -10px 30px rgba(0,0,0,0.55)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }
          : { inset: 0 }),
      }}
    >
      {mixerCompact && (
        <MixerResizeHandle
          label={LL.MIXER.RESIZE()}
          measure={() => panelRef.current?.getBoundingClientRect().height ?? 0}
          onResize={setDragHeight}
          onCommit={(height) => {
            updateSetting('mixerPanelHeight', Math.round(height));
            setDragHeight(null);
          }}
        />
      )}

      <AppBar position="static" elevation={0} sx={{ backgroundColor: '#1c1f22', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <Toolbar variant="dense" sx={{ gap: 0.5, minHeight: mixerCompact ? 42 : 52, px: mixerCompact ? 1 : undefined }}>
          <IconButton edge="start" size="small" onClick={onClose} sx={{ color: 'inherit' }} aria-label={LL.MIXER.CLOSE()}>
            <CloseIcon />
          </IconButton>

          {/* The title is the first thing to go: in the panel every pixel of this row is
              needed for the mixes, and the faders below say what this is. */}
          {!mixerCompact && <Typography sx={{ fontWeight: 700, fontSize: '0.95rem', mr: 1 }}>{LL.MIXER.TITLE()}</Typography>}

          {/* Mix picker. Chips rather than a dropdown: on a phone the wedge you want is
              one tap away, and there are rarely more than a handful to choose from. */}
          <Box sx={{ flex: 1, minWidth: 0, overflowX: 'auto', '&::-webkit-scrollbar': { display: 'none' } }}>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={selectedMixId}
              onChange={(_event, value) => value && setSelectedMixId(value as string)}
              sx={{
                flexWrap: 'nowrap',
                '& .MuiToggleButton-root': {
                  color: 'rgba(255,255,255,0.6)',
                  borderColor: 'rgba(255,255,255,0.14)',
                  textTransform: 'none',
                  whiteSpace: 'nowrap',
                  px: 1.25,
                  py: 0.35,
                  fontSize: '0.75rem',
                },
                '& .Mui-selected': { color: '#fff !important', backgroundColor: 'rgba(80,140,255,0.35) !important' },
              }}
            >
              {mixesInOrder.map((mix) => (
                <ToggleButton key={mix.id} value={mix.id}>
                  {mix.name}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>

          <Tooltip title={mixerCompact ? LL.MIXER.EXPAND() : LL.MIXER.COLLAPSE()}>
            <IconButton size="small" sx={{ color: 'inherit' }} onClick={() => updateSetting('mixerCompact', !mixerCompact)}>
              {mixerCompact ? <ExpandIcon fontSize="small" /> : <CollapseIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title={LL.MIXER.VISIBLE_STRIPS()}>
            <span>
              <IconButton size="small" sx={{ color: 'inherit' }} onClick={() => setPickerOpen(true)} disabled={!strips.length}>
                <StripsIcon />
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" sx={{ color: 'inherit' }} onClick={(event) => setMenuAnchor(event.currentTarget)}>
            <MoreVertIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      {/* Mute groups — one row, only when the operator allows them.
          Left out of the panel: they mute the whole band rather than this musician's own
          monitor, so they are not what "nudge one thing and keep playing" is for, and the
          row costs a tenth of the panel's height. Expanding brings them back. */}
      {!mixerCompact && permissions.muteGroups && muteGroups.length > 0 && (
        <Stack
          direction="row"
          spacing={0.75}
          sx={{ px: 1.5, py: 0.75, overflowX: 'auto', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}
        >
          {muteGroups.map((group) => (
            <Chip
              key={group.index}
              label={group.name}
              size="small"
              icon={<MuteIcon sx={{ fontSize: '0.9rem' }} />}
              onClick={() => send({ cmd: 'setMuteGroup', args: { index: group.index, active: !group.active } })}
              disabled={deskDown}
              sx={{
                flexShrink: 0,
                fontWeight: 600,
                color: group.active ? '#fff' : 'rgba(255,255,255,0.6)',
                backgroundColor: group.active ? 'rgba(224,74,63,0.85)' : 'rgba(255,255,255,0.06)',
                '& .MuiChip-icon': { color: 'inherit' },
              }}
            />
          ))}
        </Stack>
      )}

      {deskDown && (
        <Alert severity="warning" variant="filled" sx={{ borderRadius: 0, py: 0.25, fontSize: mixerCompact ? '0.75rem' : undefined }}>
          {link === 'connecting' ? LL.MIXER.STATE_CONNECTING() : LL.MIXER.STATE_DESK_DOWN()}
        </Alert>
      )}

      {/* Strips + master */}
      {!ready && !deskDown ? (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <CircularProgress size={28} />
        </Box>
      ) : (
        <Stack direction="row" sx={{ flex: 1, minHeight: 0 }}>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              overflowX: 'auto',
              overflowY: 'hidden',
              px: mixerCompact ? 1 : 1.5,
              py: mixerCompact ? 0.75 : 1.5,
              display: 'flex',
              // A handful of channels should sit in the middle rather than against the
              // left edge — but centring a scroll container the ordinary way puts the
              // overflow on BOTH sides once the strips are wider than the row, and the
              // first channel then cannot be scrolled back to. `safe` is the keyword for
              // exactly that: centre while it fits, fall back to the start when it does
              // not. The plain `flex-start` underneath is what browsers without it get,
              // which is merely off-centre rather than broken.
              justifyContent: 'flex-start',
              '@supports (justify-content: safe center)': { justifyContent: 'safe center' },
              // The strips are the one thing that scrolls; everything else is pinned.
              WebkitOverflowScrolling: 'touch',
            }}
          >
            {!shownStrips.length ? (
              // The first thing a new device sees, since nothing is shown until channels
              // are picked — so it carries the way out rather than just stating the fact.
              <Stack spacing={1} sx={{ flex: 1, height: '100%', alignItems: 'center', justifyContent: 'center', px: 2 }}>
                <Typography sx={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem', textAlign: 'center' }}>
                  {LL.MIXER.NO_STRIPS()}
                </Typography>
                <Button size="small" variant="outlined" startIcon={<StripsIcon />} onClick={() => setPickerOpen(true)}>
                  {LL.MIXER.VISIBLE_STRIPS()}
                </Button>
              </Stack>
            ) : (
              <Stack
                direction="row"
                spacing={mixerCompact ? 0.75 : 1}
                sx={{
                  height: '100%',
                  // Exactly as wide as the strips it holds, and never squeezed by the flex
                  // parent — the parent is what centres it.
                  width: 'max-content',
                  flexShrink: 0,
                }}
              >
                {shownStrips.map((strip) => (
                  <MixerChannel
                    key={strip.id}
                    strip={strip}
                    mixId={selectedMixId}
                    level={session.sendLevel(strip, selectedMixId)}
                    onLevel={(level) => send({ cmd: 'setSendLevel', args: { stripId: strip.id, mixId: selectedMixId, level } })}
                    sendMuted={showSendMutes ? session.sendMuted(strip, selectedMixId) : undefined}
                    onSendMute={(muted) => send({ cmd: 'setSendMute', args: { stripId: strip.id, mixId: selectedMixId, muted } })}
                    stripMuted={stripMuteShown(strip.id) ? session.stripMuted(strip) : undefined}
                    onStripMute={(muted) => send({ cmd: 'setStripMute', args: { stripId: strip.id, muted } })}
                    reserveMuteRow={anyStripMute}
                    muteAtBottom={mixerMainMuteAtBottom}
                    showMeter={metersWanted}
                    onMeters={onMeters}
                    disabled={deskDown}
                    compact={mixerCompact}
                    mine={mineSet.has(strip.id)}
                  />
                ))}
              </Stack>
            )}
          </Box>

          {/* Master — the mix's own level, pinned so it never scrolls out of reach. */}
          {selectedMix && (
            <Stack
              sx={{
                width: mixerCompact ? 76 : 96,
                flexShrink: 0,
                px: mixerCompact ? 0.75 : 1,
                py: mixerCompact ? 0.75 : 1.5,
                alignItems: 'center',
                borderLeft: '1px solid rgba(255,255,255,0.1)',
                // Opaque, not tinted: the strip row scrolls *underneath* this panel, and a
                // translucent one showed half a channel fader through the master.
                backgroundColor: '#0e1012',
              }}
            >
              <Typography noWrap sx={{ fontSize: '0.7rem', fontWeight: 700, mb: 0.25, maxWidth: '100%' }}>
                {selectedMix.name}
              </Typography>
              {/* What the meter beside it is measuring. Dropped in the panel, where the
                  height it costs is worth more than the distinction. */}
              {!mixerCompact && (
                <Typography sx={{ fontSize: '0.55rem', color: 'rgba(255,255,255,0.45)', mb: 1 }}>
                  {selectedMix.kind === 'main' ? LL.MIXER.TAP_OUTPUT() : LL.MIXER.TAP_SIGNAL()}
                </Typography>
              )}

              <Stack direction="row" spacing={0.75} sx={{ flex: 1, minHeight: 0, justifyContent: 'center', width: '100%' }}>
                {metersWanted && <MixerMeter id={selectedMix.id} source="mixes" onMeters={onMeters} width={mixerCompact ? 6 : 8} />}
                <MixerFader
                  level={session.mixLevel(selectedMix)}
                  onChange={(level) => send({ cmd: 'setMixLevel', args: { mixId: selectedMix.id, level } })}
                  color="#508cff"
                  disabled={deskDown}
                  showValue={false}
                  compact={mixerCompact}
                />
              </Stack>

              <Typography sx={{ mt: 0.5, fontSize: mixerCompact ? '0.65rem' : '0.7rem', fontVariantNumeric: 'tabular-nums' }}>
                {formatDb(session.mixLevel(selectedMix))}
              </Typography>

              {/* The main's mute is its own permission: this one silences the room. */}
              {(selectedMix.kind === 'main' ? permissions.mainMute : permissions.mixMute) && (
                <Box
                  component="button"
                  onClick={() => send({ cmd: 'setMixMute', args: { mixId: selectedMix.id, muted: !session.mixMuted(selectedMix) } })}
                  disabled={deskDown}
                  sx={{
                    mt: mixerCompact ? 0.5 : 1,
                    width: '100%',
                    py: mixerCompact ? 0.4 : 0.75,
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: session.mixMuted(selectedMix) ? '#e04a3f' : 'rgba(255,255,255,0.16)',
                    backgroundColor: session.mixMuted(selectedMix) ? 'rgba(224,74,63,0.9)' : 'rgba(255,255,255,0.05)',
                    color: session.mixMuted(selectedMix) ? '#fff' : 'rgba(255,255,255,0.65)',
                    cursor: deskDown ? 'default' : 'pointer',
                    fontWeight: 700,
                    fontSize: '0.65rem',
                    opacity: deskDown ? 0.4 : 1,
                  }}
                >
                  {LL.MIXER.MUTE()}
                </Box>
              )}
            </Stack>
          )}
        </Stack>
      )}

      {/* Device preferences */}
      <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
        <MenuItem
          disabled={!permissions.meters || !capabilities?.meters}
          onClick={() => updateSetting('mixerShowMeters', !mixerShowMeters)}
        >
          <MeterIcon fontSize="small" sx={{ mr: 1.5 }} />
          <Typography sx={{ flex: 1, fontSize: '0.85rem' }}>{LL.MIXER.SHOW_METERS()}</Typography>
          <Switch size="small" checked={metersPreferred} />
        </MenuItem>
        {permissions.stripMutes && (
          <MenuItem onClick={() => updateSetting('mixerShowStripMutes', !mixerShowStripMutes)}>
            <MainMuteIcon fontSize="small" sx={{ mr: 1.5 }} />
            <Typography sx={{ flex: 1, fontSize: '0.85rem' }}>{LL.MIXER.SHOW_STRIP_MUTES()}</Typography>
            <Switch size="small" checked={mixerShowStripMutes} />
          </MenuItem>
        )}
        {/* Offered whenever a main mute can appear at all — which includes the case where
            the switch above is off and the button is showing only on this musician's own
            channels, since those are exactly the ones they reach for. */}
        {permissions.stripMutes && (
          <MenuItem onClick={() => updateSetting('mixerMainMuteAtBottom', !mixerMainMuteAtBottom)}>
            <BottomIcon fontSize="small" sx={{ mr: 1.5 }} />
            <Typography sx={{ flex: 1, fontSize: '0.85rem' }}>{LL.MIXER.MAIN_MUTE_AT_BOTTOM()}</Typography>
            <Switch size="small" checked={mixerMainMuteAtBottom} />
          </MenuItem>
        )}
        <Divider />
        <MenuItem disabled sx={{ opacity: '1 !important' }}>
          <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>
            {mixer?.model ? `${mixer.model} · ${mixer.firmware}` : LL.MIXER.STATE_DESK_DOWN()}
          </Typography>
        </MenuItem>
      </Menu>

      <MixerStripPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        strips={strips}
        mixId={selectedMixId}
        allIds={allStripIds}
        selected={visibleStripIds}
        onChange={setVisibleStrips}
        mine={mixerMyStrips}
        onChangeMine={(ids) => updateSetting('mixerMyStrips', ids)}
      />

      {/* A refusal is the one thing worth interrupting for — an ok is confirmed by the
          patch that follows it, so success stays silent. */}
      <Snackbar
        open={!!lastError}
        autoHideDuration={4000}
        onClose={() => undefined}
        key={lastError?.at}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" variant="filled">
          {lastError?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default MixerView;
