import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';

export type ViewerTokenInfo = {
  hasToken: boolean;
  /** First 8 chars + "..." — never the full token */
  tokenPrefix: string | null;
};

export type GenerateViewerTokenResult = {
  token: string;
  message: string;
};

const viewerTokenApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    getViewerToken: build.query<ApiSuccess<ViewerTokenInfo>, void>({
      query: () => 'rest/AccountTokens',
      providesTags: ['ViewerToken'],
    }),
    generateViewerToken: build.mutation<ApiSuccess<GenerateViewerTokenResult>, void>({
      query: () => ({ url: 'rest/AccountTokens', method: 'POST' }),
      invalidatesTags: ['ViewerToken'],
    }),
    revokeViewerToken: build.mutation<ApiSuccess<{ message: string }>, void>({
      query: () => ({ url: 'rest/AccountTokens', method: 'DELETE' }),
      invalidatesTags: ['ViewerToken'],
    }),
  }),
  overrideExisting: false,
});

export const { useGetViewerTokenQuery, useGenerateViewerTokenMutation, useRevokeViewerTokenMutation } = viewerTokenApi;
