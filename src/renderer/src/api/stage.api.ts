import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';
import type { StageLayerData, StageLayerEntity } from '@/stage/types';

/**
 * Stage-monitor layers.
 *
 * Structurally this is `styles.api.ts`: one row per layer, a JSON `data` blob holding the
 * placement, typography and cue list, and an optimistic patch on update so an edit reaches
 * the presentation windows as the operator types rather than after the round trip.
 *
 * The types themselves live in `@/stage/types` — dependency-free, because the presentation
 * window imports them and must not pull RTK into its bundle. They are re-exported here so
 * there is still one obvious import path.
 */
export type {
  StageAnchor,
  StageBlankCue,
  StageClockCue,
  StageCountdownCue,
  StageCountupCue,
  StageCue,
  StageCueKind,
  StageCueWire,
  StageLayerData,
  StageLayerEntity,
  StageLayerStyle,
  StageLayerWire,
  StageMessageCue,
  StageOverlayPayload,
  StagePlacement,
} from '@/stage/types';

export {
  DEFAULT_STAGE_PLACEMENT,
  DEFAULT_STAGE_STYLE,
  cueAutoAdvances,
  cueEndsAt,
  countdownTarget,
  emptyStageLayerData,
  newCue,
  newCueId,
  resolveStagePayload,
} from '@/stage/types';

const stageApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    getStageLayers: build.query<ApiSuccess<StageLayerEntity[]>, void>({
      query: () => 'rest/StageLayers',
      providesTags: [{ type: 'StageLayers', id: 'LIST' }],
    }),
    getStageLayer: build.query<ApiSuccess<StageLayerEntity>, { id: number }>({
      query: ({ id }) => `rest/StageLayers/${id}`,
      providesTags: (_res, _err, arg) => [{ type: 'StageLayers', id: arg.id }],
    }),
    createStageLayer: build.mutation<
      ApiSuccess<{ id: number; message: string }>,
      { name: string; enabled?: boolean; sort_order?: number; data: StageLayerData }
    >({
      query: (body) => ({ url: 'rest/StageLayers', method: 'POST', body }),
      invalidatesTags: [{ type: 'StageLayers', id: 'LIST' }],
    }),
    updateStageLayer: build.mutation<ApiSuccess<{ message: string }>, { id: number } & Partial<StageLayerEntity>>({
      query: ({ id, ...body }) => ({ url: `rest/StageLayers/${id}`, method: 'PUT', body }),
      invalidatesTags: (_res, _err, arg) => [
        { type: 'StageLayers', id: 'LIST' },
        { type: 'StageLayers', id: arg.id },
      ],
      async onQueryStarted({ id, ...patch }, { dispatch, queryFulfilled }) {
        // Editing a cue has to reach the presentation windows as the operator types —
        // waiting for the round trip would make the live preview lag behind the form.
        const patchResult = dispatch(
          stageApi.util.updateQueryData('getStageLayers', undefined, (draft) => {
            const layer = draft.find((l) => l.id === id);
            if (layer) Object.assign(layer, patch);
          }),
        );
        try {
          await queryFulfilled;
        } catch {
          patchResult.undo();
        }
      },
    }),
    deleteStageLayer: build.mutation<ApiSuccess<{ message: string }>, { id: number }>({
      query: ({ id }) => ({ url: `rest/StageLayers/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'StageLayers', id: 'LIST' }],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetStageLayersQuery,
  useGetStageLayerQuery,
  useCreateStageLayerMutation,
  useUpdateStageLayerMutation,
  useDeleteStageLayerMutation,
} = stageApi;
