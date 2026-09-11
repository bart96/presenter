import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';

export type LogEntry = {
  timestamp: string;
  severity: 'ERROR' | 'WARNING' | 'INFO' | 'UNKNOWN';
  location: string;
  function: string;
  message: string;
};

export type LogsResponse = {
  total: number;
  offset: number;
  limit: number;
  logs: LogEntry[];
};

const logsApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    getLogs: build.query<ApiSuccess<LogsResponse>, { offset?: number; limit?: number; severity?: string; version?: number }>({
      query: (arg) => {
        const { version: _version, ...rest } = arg ?? {};
        return {
          url: 'rest/Log',
          params: { format: 'json', ...rest },
        };
      },
      providesTags: [{ type: 'Logs', id: 'LIST' }],
    }),
    clearLogs: build.mutation<ApiSuccess<{ message: string }>, void>({
      query: () => ({ url: 'rest/Log', method: 'DELETE' }),
      invalidatesTags: [{ type: 'Logs', id: 'LIST' }],
    }),
    logClientError: build.mutation<ApiSuccess<void>, { message: string }>({
      query: (body) => ({ url: 'rest/Log', method: 'POST', body }),
    }),
  }),
  overrideExisting: false,
});

export const { useGetLogsQuery, useClearLogsMutation, useLogClientErrorMutation } = logsApi;
