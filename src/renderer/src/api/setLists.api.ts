import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';

/**
 * A Tag Assignment: one tag on one Set List Entry, carrying the playback metadata that
 * applies in that tag's context. The same song can therefore be prepared differently for
 * e.g. `Christmas` and `Fast`.
 */
export type SetListTagAssignment = {
  id: number;
  tagName: string;
  /** Literal display key such as `Bb`. Null when the song's own key should be used. */
  customKey: string | null;
  /** Name of an order that already exists on the song — set lists never invent new ones. */
  blockOrderName: string | null;
};

/** One Song inside one Set List. Adding the same song again extends this entry's tags. */
export type SetListEntry = {
  id: number;
  songNumber: number;
  /** Denormalized from the song library so the list renders without loading every song. */
  songTitle: string | null;
  songAuthors?: string | null;
  tags: SetListTagAssignment[];
};

export type SetList = {
  id: number;
  name: string;
  /** Bands this list belongs to. Several are allowed (a list a whole team works from). */
  bandIds?: number[];
  createdAt?: string;
  updatedAt?: string;
  entries: SetListEntry[];
};

/** Payload shape accepted by the tag-assignment endpoints. */
export type SetListTagInput = {
  tagName: string;
  customKey?: string | null;
  blockOrderName?: string | null;
};

const setListsApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    /** All set lists of the account with entries + tag assignments nested (one round trip). */
    getSetLists: build.query<ApiSuccess<SetList[]>, void>({
      query: () => 'rest/SetLists',
      providesTags: [{ type: 'SetLists', id: 'LIST' }],
    }),
    createSetList: build.mutation<ApiSuccess<SetList>, { name: string; bandIds?: number[] }>({
      query: (body) => ({ url: 'rest/SetLists', method: 'POST', body }),
      invalidatesTags: [{ type: 'SetLists', id: 'LIST' }],
    }),
    /** Partial update: a rename need not carry the bands, and a band change need not rename. */
    updateSetList: build.mutation<ApiSuccess<{ id: number; name: string }>, { id: number; name?: string; bandIds?: number[] }>({
      query: ({ id, ...body }) => ({ url: `rest/SetLists/${id}`, method: 'PUT', body }),
      invalidatesTags: [{ type: 'SetLists', id: 'LIST' }],
    }),
    deleteSetList: build.mutation<ApiSuccess<{ message: string }>, { id: number }>({
      query: ({ id }) => ({ url: `rest/SetLists/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'SetLists', id: 'LIST' }],
    }),
    /** Persist the left-to-right tab order. Takes every id in its new position. */
    reorderSetLists: build.mutation<ApiSuccess<{ message: string; order: number[] }>, { order: number[] }>({
      query: (body) => ({ url: 'rest/SetLists/reorder', method: 'PUT', body }),
      invalidatesTags: [{ type: 'SetLists', id: 'LIST' }],
    }),

    /**
     * Add a song to a set list. Idempotent per (set list, song): an existing entry is reused
     * and the given tag assignments are merged into it.
     */
    addSetListEntry: build.mutation<ApiSuccess<SetListEntry>, { setListId: number; songNumber: number; tags?: SetListTagInput[] }>({
      query: (body) => ({ url: 'rest/SetListEntries', method: 'POST', body }),
      invalidatesTags: [{ type: 'SetLists', id: 'LIST' }],
    }),
    /** Replace the full tag-assignment list of one entry. */
    setSetListEntryTags: build.mutation<ApiSuccess<SetListEntry>, { entryId: number; tags: SetListTagInput[] }>({
      query: ({ entryId, tags }) => ({ url: `rest/SetListEntries/${entryId}`, method: 'PUT', body: { tags } }),
      invalidatesTags: [{ type: 'SetLists', id: 'LIST' }],
    }),
    /** Remove the whole entry (song leaves the set list, all its tag assignments go with it). */
    deleteSetListEntry: build.mutation<ApiSuccess<{ message: string }>, { entryId: number }>({
      query: ({ entryId }) => ({ url: `rest/SetListEntries/${entryId}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'SetLists', id: 'LIST' }],
    }),
    /** Remove a single tag assignment, keeping the entry and its other tags. */
    deleteSetListEntryTag: build.mutation<ApiSuccess<SetListEntry>, { entryId: number; tagName: string }>({
      query: ({ entryId, tagName }) => ({
        url: `rest/SetListEntries/${entryId}/${encodeURIComponent(tagName)}`,
        method: 'DELETE',
      }),
      invalidatesTags: [{ type: 'SetLists', id: 'LIST' }],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetSetListsQuery,
  useCreateSetListMutation,
  useUpdateSetListMutation,
  useDeleteSetListMutation,
  useReorderSetListsMutation,
  useAddSetListEntryMutation,
  useSetSetListEntryTagsMutation,
  useDeleteSetListEntryMutation,
  useDeleteSetListEntryTagMutation,
} = setListsApi;

export { setListsApi };
