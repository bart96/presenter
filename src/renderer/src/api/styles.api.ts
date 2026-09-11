import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';

/**
 * Typography for one language *slot* of a style.
 *
 * Slots are positional, not named: slot 1 is whatever language the song lists first, slot 2 its
 * second, and so on (see `utils/languageSlots.ts`). A style therefore describes "how the second
 * language looks" once, and it holds for every song regardless of which languages those are.
 */
export interface LanguageStyleEntry {
  /** 1 = the song's main language, 2 its second, and so on. */
  slot: number;
  /** Whether lines in this slot are shown at all. Absent means shown. */
  visible?: boolean;
  fontColorEnabled?: boolean;
  fontColor?: string;
  fontSizeEnabled?: boolean;
  fontSize?: string;
  fontStyleEnabled?: boolean;
  fontBold?: boolean;
  fontItalic?: boolean;
  fontUnderline?: boolean;
  letterSpacingEnabled?: boolean;
  letterSpacing?: string;
  textShadowEnabled?: boolean;
  textShadow?: string;
  textShadowColor?: string;
  textStrokeEnabled?: boolean;
  textStroke?: string;
  opacityEnabled?: boolean;
  opacity?: number;
  nextLinePreviewEnabled?: boolean;
  nextLinePreview?: boolean;
  nextLinePreviewColor?: string;
  nextLinePreviewOpacity?: number;
  /** Font size of the preview lines. Absent means the same size as the lyrics. */
  nextLinePreviewFontSize?: string;
  /** Right below the lyrics, or pinned to the bottom edge of the slide. Absent means below. */
  nextLinePreviewPosition?: 'below' | 'bottom';
  /** Gap to the lyrics — or to the bottom edge when pinned there. */
  nextLinePreviewSpacing?: string;
  /** Alignment of the preview lines. Absent means the lyrics' alignment. */
  nextLinePreviewTextAlign?: 'left' | 'center' | 'right';
}

export type StyleData = {
  backgroundImage?: { enabled: boolean; value: string };
  backgroundVideo?: { enabled: boolean; value: string };
  backgroundVideoAutoplay?: { enabled: boolean; value: boolean };
  /** Whether the background video loops (default true) */
  backgroundVideoLoop?: { enabled: boolean; value: boolean };
  backgroundVideoVolume?: { enabled: boolean; value: number };
  backgroundVideoSize?: { enabled: boolean; value: 'cover' | 'contain' | '100% auto' | 'auto 100%' | 'auto' };
  backgroundVideoPosition?: { enabled: boolean; value: string };
  backgroundVideoZoom?: { enabled: boolean; value: number };
  backgroundVideoBlur?: { enabled: boolean; value: number };
  backgroundColor?: { enabled: boolean; value: string };
  backgroundBlur?: { enabled: boolean; value: number };
  backgroundSize?: { enabled: boolean; value: 'cover' | 'contain' | '100% auto' | 'auto 100%' | 'auto' };
  backgroundPosition?: { enabled: boolean; value: string };
  backgroundZoom?: { enabled: boolean; value: number };
  nextLinePreview?: { enabled: boolean; value: boolean };
  fontFamily?: { enabled: boolean; value: string };
  fontFallback?: { enabled: boolean; value: string[] };
  fontColor?: { enabled: boolean; value: string };
  fontSize?: { enabled: boolean; value: string };
  fontBold?: { enabled: boolean; value: boolean };
  fontItalic?: { enabled: boolean; value: boolean };
  fontUnderline?: { enabled: boolean; value: boolean };
  lineHeight?: { enabled: boolean; value: string };
  letterSpacing?: { enabled: boolean; value: string };
  padding?: { enabled: boolean; value: string };
  /** CSS padding shorthand around each paragraph (song block) — "top right bottom left" */
  paragraphPadding?: { enabled: boolean; value: string };
  textTransform?: { enabled: boolean; value: 'none' | 'uppercase' | 'lowercase' | 'capitalize' };
  textAlign?: { enabled: boolean; value: 'left' | 'center' | 'right' | 'justify' };
  verticalAlign?: { enabled: boolean; value: 'top' | 'center' | 'bottom' };
  textStroke?: { enabled: boolean; value: string };
  textShadow?: { enabled: boolean; value: string };
  textShadowColor?: { enabled: boolean; value: string };
  opacity?: { enabled: boolean; value: number };
  hideText?: boolean;
  hideBackground?: boolean;
  /** When true, every language of the song is shown, including slots this style does not define. */
  showAllLanguages?: boolean;
  nextLinePreviewColor?: { enabled: boolean; value: string };
  nextLinePreviewOpacity?: { enabled: boolean; value: number };
  /** Per-slot typography and visibility. Slot 1 is the song's main language. */
  languageStyles?: { enabled: boolean; value: LanguageStyleEntry[] };
  /** Copyright section styles */
  copyrightFontFamily?: { enabled: boolean; value: string };
  copyrightFontColor?: { enabled: boolean; value: string };
  copyrightFontSize?: { enabled: boolean; value: string };
  copyrightFontBold?: { enabled: boolean; value: boolean };
  copyrightFontItalic?: { enabled: boolean; value: boolean };
  copyrightFontUnderline?: { enabled: boolean; value: boolean };
  copyrightTextAlign?: { enabled: boolean; value: 'left' | 'center' | 'right' };
  copyrightPadding?: { enabled: boolean; value: string };
  copyrightOpacity?: { enabled: boolean; value: number };
  /** Copyright title row settings */
  copyrightTitleFontSize?: { enabled: boolean; value: string };
  copyrightTitleFontBold?: { enabled: boolean; value: boolean };
  copyrightTitleFontItalic?: { enabled: boolean; value: boolean };
  copyrightTitleFontUnderline?: { enabled: boolean; value: boolean };
  copyrightTitleSpacing?: { enabled: boolean; value: string };
  copyrightShowSongNumber?: { enabled: boolean; value: boolean };
  /** Suppress inherited background image/video from parent style levels */
  suppressBackgroundImage?: boolean;
  suppressBackgroundVideo?: boolean;
  /** Video ease-in / ease-out (fade volume) */
  backgroundVideoEaseIn?: { enabled: boolean; value: number };
  backgroundVideoEaseOut?: { enabled: boolean; value: number };
  css?: string;
};

export type StyleEntity = {
  id: number;
  name: string;
  enabled: boolean;
  data: StyleData;
  windowOverrides?: { window_name: string; override_style_id: number }[];
  created_at?: string;
  updated_at?: string;
};

const stylesApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    getStyles: build.query<ApiSuccess<StyleEntity[]>, void>({
      query: () => 'rest/Styles',
      providesTags: [{ type: 'Styles', id: 'LIST' }],
    }),
    getStyle: build.query<ApiSuccess<StyleEntity>, { id: number }>({
      query: ({ id }) => `rest/Styles/${id}`,
      providesTags: (_res, _err, arg) => [{ type: 'Styles', id: arg.id }],
    }),
    createStyle: build.mutation<ApiSuccess<{ id: number; message: string }>, { name: string; enabled?: boolean; data: StyleData }>({
      query: (body) => ({ url: 'rest/Styles', method: 'POST', body }),
      invalidatesTags: [{ type: 'Styles', id: 'LIST' }],
    }),
    updateStyle: build.mutation<ApiSuccess<{ message: string }>, { id: number } & Partial<StyleEntity>>({
      query: ({ id, ...body }) => ({ url: `rest/Styles/${id}`, method: 'PUT', body }),
      invalidatesTags: (_res, _err, arg) => [
        { type: 'Styles', id: 'LIST' },
        { type: 'Styles', id: arg.id },
      ],
      async onQueryStarted({ id, ...patch }, { dispatch, queryFulfilled }) {
        // Optimistic update so presentation windows reflect the new style immediately
        // without waiting for the round-trip API refetch.
        const patchResult = dispatch(
          stylesApi.util.updateQueryData('getStyles', undefined, (draft) => {
            const style = draft.find((s) => s.id === id);
            if (style) Object.assign(style, patch);
          }),
        );
        try {
          await queryFulfilled;
        } catch {
          patchResult.undo();
        }
      },
    }),
    deleteStyle: build.mutation<ApiSuccess<{ message: string }>, { id: number }>({
      query: ({ id }) => ({ url: `rest/Styles/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'Styles', id: 'LIST' }],
    }),
  }),
  overrideExisting: false,
});

export const { useGetStylesQuery, useGetStyleQuery, useCreateStyleMutation, useUpdateStyleMutation, useDeleteStyleMutation } = stylesApi;
