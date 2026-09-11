import { CSSProperties } from 'react';
import { PresentationLine } from '@/presentation/types';
import { LanguageStyleEntry } from '@/api/styles.api';
import { filterLinesByLanguage, resolveLineLangCss } from '@/presentation/index';
import { MAIN_LANGUAGE_SLOT, slotForLanguage } from '@/utils/languageSlots';
import { DEFAULT_NEXT_LINE_COLOR, DEFAULT_NEXT_LINE_OPACITY, type NextLinePreviewLayout } from '@/utils/styleUtils';

/**
 * Next-block preview shown with the presentation.
 * Shows the first primary line plus any translation lines that follow it.
 */
export const NextBlockPreview = ({
  lines,
  color,
  opacity,
  textStyle,
  languages,
  songLanguages,
  langStyles,
  paragraphPadding,
  layout,
  edgePadding,
}: {
  lines: PresentationLine[];
  color?: string;
  opacity?: number;
  textStyle: CSSProperties;
  languages?: string[];
  songLanguages?: string[];
  langStyles?: LanguageStyleEntry[];
  /** CSS padding shorthand around the preview paragraph (spacing towards the active block) */
  paragraphPadding?: string;
  /** Size, position, spacing and alignment from the style. Absent: right below the lyrics, at their size. */
  layout?: NextLinePreviewLayout;
  /** The slide's padding. A strip pinned to the bottom edge stays inside it, as the lyrics do. */
  edgePadding?: string;
}) => {
  const filtered = filterLinesByLanguage(lines, languages, songLanguages?.[0]);
  if (filtered.length === 0) return null;

  const pinned = layout?.position === 'bottom';

  const strip = (
    <div
      className="presentation-next-preview"
      style={{
        width: '100%',
        boxSizing: 'border-box',
        opacity: opacity ?? DEFAULT_NEXT_LINE_OPACITY,
        ...(paragraphPadding ? { padding: paragraphPadding } : {}),
        ...(!pinned && layout?.spacing ? { marginTop: layout.spacing } : {}),
      }}
    >
      {filtered.map((line, i) => {
        const slot = slotForLanguage(line.language, songLanguages);
        return (
          <div
            key={i}
            className="presentation-line"
            data-lang={line.language || undefined}
            data-slot={slot}
            style={{
              ...textStyle,
              ...resolveLineLangCss(line.language, langStyles, songLanguages),
              color: color || DEFAULT_NEXT_LINE_COLOR,
              // Translations are set apart in italics. Keyed on the slot rather than on a language tag
              // being present: songs tag their main-language lines too, which turned the whole strip italic.
              ...(line.language && slot !== MAIN_LANGUAGE_SLOT ? { fontStyle: 'italic' } : {}),
              // Set last, so the style's own preview size and alignment win over the lyrics' — the size
              // used to be inherited from the lyrics with nothing to override it.
              ...(layout?.fontSize ? { fontSize: layout.fontSize } : {}),
              ...(layout?.textAlign ? { textAlign: layout.textAlign } : {}),
            }}
          >
            {line.text}
          </div>
        );
      })}
    </div>
  );

  if (!pinned) return strip;

  // Pinned: taken out of the flow, so the lyrics keep the position their own alignment gives them
  // instead of being pushed up by the strip underneath.
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: layout?.spacing || 0,
        padding: edgePadding || 0,
        boxSizing: 'border-box',
      }}
    >
      {strip}
    </div>
  );
};
