import type { useI18nContext } from '@/i18n/i18n-react';

/** The CSS length units the style editor offers, in the order they are listed. */
export const CSS_UNITS = ['px', 'pt', 'em', 'rem', 'vh', 'vw', 'vmin', 'vmax', '%'] as const;
export type CssUnit = (typeof CSS_UNITS)[number];

const LENGTH_PATTERN = /^(-?\d*\.?\d+)\s*(px|pt|em|rem|vh|vw|vmin|vmax|%)$/i;

/** Split a length like "4vh" into number and unit; null when it is not a plain length. */
export const splitLength = (value: string): { num: number; unit: CssUnit } | null => {
  const match = value.trim().match(LENGTH_PATTERN);
  return match ? { num: parseFloat(match[1]), unit: match[2].toLowerCase() as CssUnit } : null;
};

/**
 * What a unit measures, in words someone who has never written CSS can choose from. Shown
 * next to each unit in the pickers — the bare abbreviations meant nothing to most operators.
 */
export const cssUnitHint = (LL: ReturnType<typeof useI18nContext>['LL'], unit: CssUnit): string => {
  const H = LL.STYLE.UNIT_HINTS;
  const hints: Record<CssUnit, () => string> = {
    px: () => H.PX(),
    pt: () => H.PT(),
    em: () => H.EM(),
    rem: () => H.REM(),
    vh: () => H.VH(),
    vw: () => H.VW(),
    vmin: () => H.VMIN(),
    vmax: () => H.VMAX(),
    '%': () => H.PERCENT(),
  };
  return hints[unit]();
};

/**
 * How far one arrow-key press moves a value: whole steps for the fixed units, tenths for the
 * relative ones — a whole vh or em is already a visible jump on a presentation screen.
 */
export const keyboardStep = (unit: CssUnit): number => (unit === 'px' || unit === 'pt' || unit === '%' ? 1 : 0.1);

/** `num` moved one arrow-key step, rounded so repeated tenths do not drift (0.30000000000000004). */
export const stepValue = (num: number, unit: CssUnit, direction: 1 | -1): number =>
  Math.round((num + direction * keyboardStep(unit)) * 100) / 100;
