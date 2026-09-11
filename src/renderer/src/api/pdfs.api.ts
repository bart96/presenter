import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';

export type PdfFileInfo = {
  filename: string;
  size: number;
  modified: number;
  songNumber?: number;
};

export type PdfAreaMapping = {
  blockName: string;
  page: number;
  region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

const pdfsApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    listPdfs: build.query<ApiSuccess<PdfFileInfo[]>, { songNumber: number }>({
      query: ({ songNumber }) => `rest/Pdfs/${songNumber}`,
      providesTags: (_res, _err, arg) => [{ type: 'Pdfs', id: arg.songNumber }],
    }),
    searchPdfs: build.query<ApiSuccess<PdfFileInfo[]>, { q: string }>({
      query: ({ q }) => ({ url: 'rest/Pdfs/search', params: { q } }),
    }),
    getPdfUpdates: build.query<ApiSuccess<PdfFileInfo[]>, { since: number }>({
      query: ({ since }) => ({ url: 'rest/Pdfs/updates', params: { since } }),
    }),
    uploadPdf: build.mutation<ApiSuccess<{ message: string; files: string[] }>, { songNumber: number; formData: FormData }>({
      query: ({ songNumber, formData }) => ({
        url: `rest/Pdfs/${songNumber}`,
        method: 'POST',
        body: formData,
        formData: true,
      }),
      invalidatesTags: (_res, _err, arg) => [{ type: 'Pdfs', id: arg.songNumber }],
    }),
    deletePdf: build.mutation<ApiSuccess<{ message: string }>, { songNumber: number; filename: string }>({
      query: ({ songNumber, filename }) => ({
        url: `rest/Pdfs/${songNumber}/${encodeURIComponent(filename)}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_res, _err, arg) => [{ type: 'Pdfs', id: arg.songNumber }],
    }),
    renamePdf: build.mutation<ApiSuccess<{ message: string }>, { songNumber: number; oldName: string; newName: string }>({
      query: ({ songNumber, oldName, newName }) => ({
        url: `rest/Pdfs/${songNumber}`,
        method: 'PUT',
        body: { oldName, newName },
      }),
      invalidatesTags: (_res, _err, arg) => [{ type: 'Pdfs', id: arg.songNumber }],
    }),
    savePdfBytes: build.mutation<ApiSuccess<{ message: string; size: number }>, { songNumber: number; filename: string; data: Uint8Array }>(
      {
        query: ({ songNumber, filename, data }) => ({
          url: `rest/Pdfs/${songNumber}/${encodeURIComponent(filename)}`,
          method: 'PUT',
          body: data,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
        invalidatesTags: (_res, _err, arg) => [{ type: 'Pdfs', id: arg.songNumber }],
      },
    ),

    // ──────── PDF Resolve & Counts (client-side helpers) ────────
    /**
     * Resolve the best PDF filename for a musician/order/key combination.
     * Tries musician-specific → order-specific → key match → first available → null.
     */
    resolvePdf: build.query<
      { filename: string | null; total: number },
      { songNumber: number; musician?: string; order?: string; key?: string }
    >({
      async queryFn(arg, _api, _extra, baseQuery) {
        const result = await baseQuery(`rest/Pdfs/${arg.songNumber}`);
        if (result.error) return { error: result.error };
        const files = (result.data as PdfFileInfo[]) ?? [];
        const total = files.length;
        if (total === 0) return { data: { filename: null, total: 0 } };

        const names = files.map((f) => f.filename);
        const lower = (s: string) => s.toLowerCase().replace(/\s+/g, '');

        if (arg.musician) {
          const m = lower(arg.musician);
          const match = names.find((n) => lower(n).includes(m));
          if (match) return { data: { filename: match, total } };
        }
        if (arg.order && arg.order !== 'Default') {
          const o = lower(arg.order);
          const match = names.find((n) => lower(n).includes(o));
          if (match) return { data: { filename: match, total } };
        }
        if (arg.key) {
          const k = lower(arg.key);
          // Prefer an exact "…-<key>.pdf" suffix (so key C doesn't match a "C#" chart);
          // fall back to a looser substring match for legacy filenames.
          const exact = names.find((n) => lower(n).endsWith(`-${k}.pdf`));
          if (exact) return { data: { filename: exact, total } };
          const loose = names.find((n) => lower(n).includes(k));
          if (loose) return { data: { filename: loose, total } };
        }
        // No musician/order/key match → use the song's default chart ("Default.pdf" /
        // "Default-<key>.pdf") in preference to any other file (its name may not sort first).
        const def = names.find((n) => lower(n).startsWith('default'));
        if (def) return { data: { filename: def, total } };
        return { data: { filename: names[0], total } };
      },
      providesTags: (_res, _err, arg) => [{ type: 'Pdfs', id: arg.songNumber }],
    }),

    /**
     * Batch query: get the PDF file count for each given song number.
     * Returns a Record<string, number> mapping songNumber → count.
     */
    getPdfCounts: build.query<Record<string, number>, { songNumbers: number[] }>({
      async queryFn(arg, _api, _extra, baseQuery) {
        const counts: Record<string, number> = {};
        await Promise.all(
          arg.songNumbers.map(async (sn) => {
            const result = await baseQuery(`rest/Pdfs/${sn}`);
            if (!result.error) {
              const files = (result.data as PdfFileInfo[]) ?? [];
              counts[String(sn)] = files.length;
            } else {
              counts[String(sn)] = 0;
            }
          }),
        );
        return { data: counts };
      },
      providesTags: (_res, _err, arg) => arg.songNumbers.map((sn) => ({ type: 'Pdfs' as const, id: sn })),
    }),

    // ──────── PDF Area Mappings ────────
    // Keyed by the PDF file alone: the regions describe the sheet, so they are shared by
    // everyone who opens it. Only annotations are per musician (see pdfAnnotations.api).
    getPdfAreaMappings: build.query<ApiSuccess<PdfAreaMapping[]>, { songNumber: number; filename: string }>({
      query: ({ songNumber, filename }) => ({
        url: `rest/Pdfs/${songNumber}/mappings`,
        params: { filename },
      }),
      providesTags: (_res, _err, arg) => [{ type: 'Pdfs', id: `mappings-${arg.songNumber}-${arg.filename}` }],
    }),
    savePdfAreaMappings: build.mutation<
      ApiSuccess<{ message: string }>,
      { songNumber: number; filename: string; mappings: PdfAreaMapping[] }
    >({
      query: ({ songNumber, filename, mappings }) => ({
        url: `rest/Pdfs/${songNumber}/mappings`,
        method: 'PUT',
        body: { filename, mappings },
      }),
      invalidatesTags: (_res, _err, arg) => [{ type: 'Pdfs', id: `mappings-${arg.songNumber}-${arg.filename}` }],
    }),
  }),
  overrideExisting: false,
});

export const {
  useListPdfsQuery,
  useSearchPdfsQuery,
  useGetPdfUpdatesQuery,
  useUploadPdfMutation,
  useDeletePdfMutation,
  useRenamePdfMutation,
  useSavePdfBytesMutation,
  useResolvePdfQuery,
  useGetPdfCountsQuery,
  useGetPdfAreaMappingsQuery,
  useSavePdfAreaMappingsMutation,
} = pdfsApi;
