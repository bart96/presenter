import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';

export type ShowItemType = 'song' | 'media' | 'bible_verse';
export type MediaSubType = 'image' | 'video' | 'color';

/**
 * A named, optionally-colored group that items can be organized into within a show. Groups are an
 * additive layer over the flat `order`: every item carries a `groupId`, and items of a group are
 * kept contiguous in `order`, in the same sequence as `Show.groups`.
 */
export type ShowGroup = {
  id: string;
  name: string;
  /** Sidebar background tint (hex). Undefined = no tint. */
  color?: string;
  /** Persisted collapse state (collapsed hides the group's items in the sidebar). */
  collapsed?: boolean;
};

/**
 * A stage-monitor action fired when the item it sits on goes live.
 *
 * These live on the item itself, inside the show's `order` JSON, rather than in a table
 * keyed by position: `ShowItem` has no stable id, so anything index-keyed would point at
 * the wrong item the first time the order is rearranged.
 */
export type StageTrigger = {
  /** `stage_layers.id`. A trigger naming a layer that no longer exists is ignored. */
  layerId: number;
  action: 'start' | 'next' | 'reset' | 'hide' | 'show';
  /** For `start`: jump to this cue instead of the first one. */
  cueId?: string;
};

export type ShowItem = {
  type: ShowItemType;
  /** Id of the group this item belongs to (see Show.groups). Items without one fall into Default. */
  groupId?: string;
  songNumber?: number;
  order?: string;
  key?: string;
  translations?: string[];
  mediaPath?: string;
  mediaSubType?: MediaSubType;
  mediaColor?: string;
  /** CSS objectFit for image/video: 'cover' | 'contain' | 'fill' */
  mediaObjectFit?: 'cover' | 'contain' | 'fill';
  /** CSS objectPosition e.g. 'center', 'top', 'bottom left' */
  mediaObjectPosition?: string;
  /** Zoom factor 100 = 1x */
  mediaZoom?: number;
  /** Blur in px */
  mediaBlur?: number;
  /** Video autoplay (default true) */
  mediaAutoplay?: boolean;
  /** Video loop (default true) */
  mediaLoop?: boolean;
  bibleRef?: string;
  bibleTranslation?: string;
  bibleFormattedSegments?: { start: number; end: number; bold: boolean }[];
  label?: string;
  styleId?: number;
  /** Stage-monitor actions fired when this item becomes active. */
  stageTriggers?: StageTrigger[];
  /** Per-window style override: keys are window names, values are style IDs (or null = no style). */
  itemStyleByWindow?: Record<string, number | null>;
};

export type Show = {
  title: string;
  order: ShowItem[];
  /** Ordered list of item groups (metadata + sequence). A Default group is ensured on load. */
  groups?: ShowGroup[];
  date?: string;
  styleId?: number;
  /** Linked ChurchTools event id (for agenda sync), if any. */
  eventId?: number | null;
  eventName?: string | null;
  /**
   * Bands playing this show. Several are allowed — two bands sharing a service is normal —
   * and they are only rewritten when the save actually carries them (see saveShow).
   */
  bandIds?: number[];
};

export type ShowsResponse = {
  limit: number;
  offset: number;
  shows: Show[];
};

const showsApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    getShows: build.query<ApiSuccess<ShowsResponse>, { limit?: number; page?: number } | void>({
      query: (arg) => {
        const limit = arg && 'limit' in arg ? (arg.limit ?? 10) : 10;
        const page = arg && 'page' in arg ? (arg.page ?? 0) : 0;
        return `rest/Shows/${limit}/${page}`;
      },
      providesTags: [{ type: 'Shows', id: 'LIST' }],
    }),
    /** Fetch a single show by title (avoids loading the whole library to look one up). */
    getShow: build.query<ApiSuccess<ShowsResponse>, { title: string }>({
      query: ({ title }) => `rest/Shows/1/0?title=${encodeURIComponent(title)}`,
      providesTags: [{ type: 'Shows', id: 'LIST' }],
    }),
    /** Lightweight change-detection feed (title + date only) for background polling. */
    getShowsRevision: build.query<ApiSuccess<{ shows: { title: string; date?: string }[]; count: number }>, void>({
      query: () => 'rest/ShowsRevision',
      providesTags: [{ type: 'Shows', id: 'LIST' }],
    }),
    saveShow: build.mutation<
      ApiSuccess<{ message: string; eventSync?: { ok: boolean; synced: number; reason?: string } | null }>,
      {
        title: string;
        order: ShowItem[];
        groups?: ShowGroup[];
        styleId?: number | null;
        eventId?: number | null;
        eventName?: string | null;
        /**
         * Omit to leave the show's bands as they are — an order-only auto-save must not
         * strip them. Send an empty array to clear them.
         */
        bandIds?: number[];
      }
    >({
      query: (body) => ({ url: 'rest/Shows', method: 'POST', body }),
      invalidatesTags: [{ type: 'Shows', id: 'LIST' }],
    }),
    deleteShow: build.mutation<ApiSuccess<{ message: string }>, { title: string }>({
      query: (body) => ({ url: 'rest/Shows', method: 'DELETE', body }),
      invalidatesTags: [{ type: 'Shows', id: 'LIST' }],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetShowsQuery,
  useLazyGetShowsQuery,
  useGetShowQuery,
  useLazyGetShowQuery,
  useGetShowsRevisionQuery,
  useSaveShowMutation,
  useDeleteShowMutation,
} = showsApi;
