import { useState, type ElementType } from 'react';
import { Box, IconButton, Popover, Tooltip } from '@mui/material';
import {
  NorthWest as NWIcon,
  North as NIcon,
  NorthEast as NEIcon,
  West as WIcon,
  OpenWith as CenterIcon,
  East as EIcon,
  SouthWest as SWIcon,
  South as SIcon,
  SouthEast as SEIcon,
} from '@mui/icons-material';

export type PositionValue =
  'top left' | 'top center' | 'top right' | 'center left' | 'center' | 'center right' | 'bottom left' | 'bottom center' | 'bottom right';

const CELLS: { pos: PositionValue; Icon: ElementType }[] = [
  { pos: 'top left', Icon: NWIcon },
  { pos: 'top center', Icon: NIcon },
  { pos: 'top right', Icon: NEIcon },
  { pos: 'center left', Icon: WIcon },
  { pos: 'center', Icon: CenterIcon },
  { pos: 'center right', Icon: EIcon },
  { pos: 'bottom left', Icon: SWIcon },
  { pos: 'bottom center', Icon: SIcon },
  { pos: 'bottom right', Icon: SEIcon },
];

interface CompactPositionPickerProps {
  value: string;
  onChange: (v: string) => void;
  /** Optional tooltip override; defaults to the current value. */
  tooltip?: string;
}

/**
 * Compact position picker — shows only the active direction icon; click opens
 * a Popover with the full 3×3 grid. Used for object-position / background-position.
 */
const CompactPositionPicker = ({ value, onChange, tooltip }: CompactPositionPickerProps) => {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const current = CELLS.find((c) => c.pos === value) ?? CELLS[4];
  const CurrentIcon = current.Icon;
  return (
    <>
      <Tooltip title={tooltip ?? value ?? 'center'}>
        <IconButton
          size="small"
          onClick={(e) => setAnchorEl(e.currentTarget)}
          sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 0.5, width: 40, height: 40 }}
        >
          <CurrentIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Box sx={{ p: 0.5, display: 'grid', gridTemplateColumns: 'repeat(3, 28px)', gap: 0.3 }}>
          {CELLS.map(({ pos, Icon }) => (
            <Tooltip key={pos} title={pos}>
              <Box
                onClick={() => {
                  onChange(pos);
                  setAnchorEl(null);
                }}
                sx={{
                  width: 28,
                  height: 28,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 0.5,
                  cursor: 'pointer',
                  bgcolor: value === pos ? 'primary.main' : 'action.hover',
                  color: value === pos ? 'primary.contrastText' : 'text.secondary',
                  '&:hover': { bgcolor: value === pos ? 'primary.dark' : 'action.selected' },
                }}
              >
                <Icon sx={{ fontSize: 16 }} />
              </Box>
            </Tooltip>
          ))}
        </Box>
      </Popover>
    </>
  );
};

export default CompactPositionPicker;
