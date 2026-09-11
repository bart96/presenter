import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';

/**
 * Bands — the groups of people that play the shows of an account.
 *
 * A band used to exist only as the name of a song order ("Youth Band [G]"), which meant it
 * could not be renamed, coloured or listed. It is now an account-scoped record; shows and
 * set lists reference it by id (several bands per show are allowed), and its name and its
 * members are what the autocompletes around the app suggest.
 */
export type Band = {
  id: number;
  name: string;
  /** Hex tint for the band's chips. Null = the default chip colour. */
  color: string | null;
  /** The musicians on the band, in the order the band itself lists them. */
  members: string[];
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
};

const bandsApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    getBands: build.query<ApiSuccess<Band[]>, void>({
      query: () => 'rest/Bands',
      providesTags: [{ type: 'Bands', id: 'LIST' }],
    }),
    createBand: build.mutation<ApiSuccess<Band>, { name: string; color?: string | null; members?: string[] }>({
      query: (body) => ({ url: 'rest/Bands', method: 'POST', body }),
      invalidatesTags: [{ type: 'Bands', id: 'LIST' }],
    }),
    /** Partial update — sending only `members` leaves name and colour alone. */
    updateBand: build.mutation<ApiSuccess<Band>, { id: number; name?: string; color?: string | null; members?: string[] }>({
      query: ({ id, ...body }) => ({ url: `rest/Bands/${id}`, method: 'PUT', body }),
      invalidatesTags: [{ type: 'Bands', id: 'LIST' }],
    }),
    deleteBand: build.mutation<ApiSuccess<{ message: string }>, { id: number }>({
      query: ({ id }) => ({ url: `rest/Bands/${id}`, method: 'DELETE' }),
      // Deleting a band drops its assignments, so anything showing band chips is stale now.
      invalidatesTags: [
        { type: 'Bands', id: 'LIST' },
        { type: 'Shows', id: 'LIST' },
        { type: 'SetLists', id: 'LIST' },
      ],
    }),
    /** Persist the display order. Takes every id in its new position. */
    reorderBands: build.mutation<ApiSuccess<{ message: string; order: number[] }>, { order: number[] }>({
      query: (body) => ({ url: 'rest/Bands/reorder', method: 'PUT', body }),
      invalidatesTags: [{ type: 'Bands', id: 'LIST' }],
    }),
  }),
  overrideExisting: false,
});

export const { useGetBandsQuery, useCreateBandMutation, useUpdateBandMutation, useDeleteBandMutation, useReorderBandsMutation } = bandsApi;

export { bandsApi };
