/**
 * MixerChannel — one input strip, as it appears in one mix.
 *
 * The layout follows the audio bridge contract §4.2.1 rather than convenience. The main
 * mute is drawn *outside* the strip's own frame, separated from it, and labelled for what
 * it does — because it is not a per-mix control and must not read as one. A guitarist who
 * thinks they are pulling themselves out of their own wedge, and is instead cut from the
 * house, is the failure that separation exists to prevent.
 *
 * Which end it sits on is the musician's choice (`mixerMainMuteAtBottom`), because a
 * tablet held low and a phone in a bottom panel do not put the same corner under the same
 * thumb. Above stays the default: it is the end furthest from the per-mix mute inside the
 * strip, and so the harder of the two to confuse it with.
 */
import { memo } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { Block as MainMuteIcon, VolumeOff as MuteIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import type { IStrip } from '@/audio/protocol';
import { MixerFader } from './MixerFader';
import { MixerMeter } from './MixerMeter';
import type { MetersHandler } from './useMixerSession';

/**
 * Strip width, full and compact.
 *
 * The compact one is narrower rather than merely shorter: the panel it lives in is the
 * bottom third of a portrait tablet, so the constraint that bites is how many channels
 * fit across before you have to scroll, not how tall a fader is.
 */
const CHANNEL_WIDTH = 78;
const CHANNEL_WIDTH_COMPACT = 60;

interface MixerChannelProps {
  strip: IStrip;
  mixId: string;
  level: number;
  onLevel: (level: number) => void;
  /** Per-send mute; undefined when the desk has none (an X-Air) — see contract §5.3. */
  sendMuted?: boolean;
  onSendMute?: (muted: boolean) => void;
  /** Global strip mute; undefined when it is not on offer for this device. */
  stripMuted?: boolean;
  onStripMute?: (muted: boolean) => void;
  showMeter: boolean;
  onMeters: (handler: MetersHandler) => () => void;
  /** The desk is not answering — controls stay visible, but greyed and inert. */
  disabled?: boolean;
  /** Narrower, and without the second line of labelling. */
  compact?: boolean;
  /** This musician marked the channel as themselves — outlined so it is found at a glance. */
  mine?: boolean;
  /**
   * Keep the height of the global mute row even on a channel that has no button in it.
   *
   * The button is now offered per channel rather than per device, so a row can hold some
   * strips that have one and some that do not. Without the gap the tops of the faders
   * would sit at two different heights, which reads as a rendering fault rather than as a
   * permission.
   */
  reserveMuteRow?: boolean;
  /** Draw the main mute under the strip instead of over it. */
  muteAtBottom?: boolean;
}

/**
 * The "that's me" outline.
 *
 * Orange because a Behringer scribble cannot be: the desk's own sixteen colours have no
 * orange in them, so this mark can never be mistaken for a channel that simply happens to
 * be coloured the same on the desk.
 */
export const MINE_COLOUR = '#ff9f1c';

/** A desk colour that is legible on a dark strip, whatever the scribble says. */
const stripColor = (raw: string): string => {
  const value = (raw || '').trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value;
  return '#7a8087';
};

export const MixerChannel = memo(
  ({
    strip,
    mixId,
    level,
    onLevel,
    sendMuted,
    onSendMute,
    stripMuted,
    onStripMute,
    showMeter,
    onMeters,
    disabled,
    compact,
    mine,
    reserveMuteRow,
    muteAtBottom,
  }: MixerChannelProps) => {
    const { LL } = useI18nContext();
    const color = stripColor(strip.color);
    const offered = strip.sends[mixId] !== undefined;

    /**
     * The main mute, or the gap it would have left.
     *
     * Built once and placed at whichever end the device asked for, so the two positions
     * cannot drift apart — the margin is the only thing that differs, and it always points
     * back at the strip. The invisible copy keeps a row of strips level when only some of
     * them carry the button: without it the fader tops sit at two heights and read as a
     * rendering fault rather than as a permission.
     */
    const mainMute =
      stripMuted === undefined ? (
        reserveMuteRow ? (
          <Box
            aria-hidden
            sx={{
              width: '100%',
              ...(muteAtBottom ? { mt: 0.75 } : { mb: 0.75 }),
              py: 0.4,
              fontSize: '0.6rem',
              lineHeight: 1.3,
              visibility: 'hidden',
            }}
          >
            {LL.MIXER.MUTE_MAIN()}
          </Box>
        ) : null
      ) : (
        <Tooltip title={LL.MIXER.MUTE_MAIN_HINT()} placement={muteAtBottom ? 'bottom' : 'top'}>
          <Box
            component="button"
            onClick={() => onStripMute?.(!stripMuted)}
            disabled={disabled}
            sx={{
              width: '100%',
              ...(muteAtBottom ? { mt: 0.75 } : { mb: 0.75 }),
              py: 0.4,
              px: 0.25,
              border: '1px solid',
              borderColor: stripMuted ? '#e04a3f' : 'rgba(255,255,255,0.14)',
              borderRadius: 1,
              cursor: disabled ? 'default' : 'pointer',
              backgroundColor: stripMuted ? 'rgba(224,74,63,0.85)' : 'rgba(255,255,255,0.04)',
              color: stripMuted ? '#fff' : 'rgba(255,255,255,0.55)',
              // Two short words that can break, rather than one long one that could not:
              // "everywhere" is ten unbreakable characters and overflowed a compact strip
              // outright. Sentence case for the same reason — uppercase is wider.
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'center',
              columnGap: '3px',
              fontSize: '0.6rem',
              fontWeight: 700,
              lineHeight: 1.3,
              opacity: disabled ? 0.4 : 1,
            }}
          >
            {/* Not the speaker the per-mix mute wears: these two buttons do different
                things and must not be told apart by their labels alone. Dropped on a
                compact strip, where it will not sit beside the words and a whole extra
                line is a poor trade for height that is already the scarce thing. */}
            {!compact && <MainMuteIcon sx={{ fontSize: '0.8rem' }} />}
            {LL.MIXER.MUTE_MAIN()}
          </Box>
        </Tooltip>
      );

    return (
      <Stack
        sx={{
          width: compact ? CHANNEL_WIDTH_COMPACT : CHANNEL_WIDTH,
          flexShrink: 0,
          height: '100%',
          alignItems: 'center',
        }}
      >
        {!muteAtBottom && mainMute}

        {/* The strip itself */}
        <Stack
          sx={{
            flex: 1,
            minHeight: 0,
            width: '100%',
            alignItems: 'center',
            borderRadius: 1,
            overflow: 'hidden',
            backgroundColor: mine ? 'rgba(255,159,28,0.07)' : 'rgba(255,255,255,0.035)',
            border: mine ? `2px solid ${MINE_COLOUR}` : '1px solid rgba(255,255,255,0.07)',
            boxShadow: mine ? `0 0 10px ${MINE_COLOUR}44` : 'none',
          }}
        >
          <Box
            sx={{
              width: '100%',
              px: 0.5,
              py: compact ? 0.25 : 0.5,
              borderTop: `3px solid ${color}`,
              backgroundColor: 'rgba(0,0,0,0.35)',
            }}
          >
            <Typography
              noWrap
              title={strip.name}
              sx={{ fontSize: '0.68rem', fontWeight: 600, textAlign: 'center', color: 'rgba(255,255,255,0.92)' }}
            >
              {strip.name}
            </Typography>
            {/* The desk's channel number. First thing to go when height is short: the
                scribble name is what a musician recognises, the number is a tie-breaker. */}
            {!compact && (
              <Typography sx={{ fontSize: '0.55rem', textAlign: 'center', color: 'rgba(255,255,255,0.4)', lineHeight: 1.2 }}>
                {strip.id}
              </Typography>
            )}
          </Box>

          <Stack
            direction="row"
            spacing={compact ? 0.5 : 0.75}
            sx={{ flex: 1, minHeight: 0, width: '100%', px: compact ? 0.5 : 0.75, py: compact ? 0.5 : 1, justifyContent: 'center' }}
          >
            {showMeter && <MixerMeter id={strip.id} source="strips" onMeters={onMeters} width={compact ? 5 : 6} />}
            <MixerFader
              level={level}
              onChange={onLevel}
              color={color}
              // A strip the desk does not route to this mix has no fader to move. It is
              // shown rather than hidden so the channel numbering stays stable.
              disabled={disabled || !offered}
              compact={compact}
              inScrollRow
            />
          </Stack>

          {sendMuted !== undefined && (
            <Box
              component="button"
              onClick={() => onSendMute?.(!sendMuted)}
              disabled={disabled}
              sx={{
                width: 'calc(100% - 8px)',
                mb: compact ? 0.5 : 0.75,
                py: compact ? 0.25 : 0.5,
                border: '1px solid',
                borderColor: sendMuted ? '#e04a3f' : 'rgba(255,255,255,0.14)',
                borderRadius: 1,
                cursor: disabled ? 'default' : 'pointer',
                backgroundColor: sendMuted ? 'rgba(224,74,63,0.9)' : 'rgba(255,255,255,0.05)',
                color: sendMuted ? '#fff' : 'rgba(255,255,255,0.6)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '3px',
                fontSize: '0.6rem',
                fontWeight: 700,
                opacity: disabled ? 0.4 : 1,
              }}
            >
              <MuteIcon sx={{ fontSize: '0.85rem' }} />
              {LL.MIXER.MUTE()}
            </Box>
          )}
        </Stack>

        {muteAtBottom && mainMute}
      </Stack>
    );
  },
);

MixerChannel.displayName = 'MixerChannel';
