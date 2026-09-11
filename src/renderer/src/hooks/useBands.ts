import { useMemo } from 'react';
import { useGetBandsQuery, type Band } from '@/api/bands.api';

/**
 * The account's bands, plus the suggestion pools built from them.
 *
 * Everything that used to guess at band names — the musician page's band select, the
 * order-name dialog, the set list tag editor — reads them from here, so naming a band once
 * in the settings is enough for it to be offered everywhere it makes sense.
 *
 * Offline mode resolves the query to `undefined`, which lands on the empty list: the pools
 * simply contribute nothing and each caller falls back to what it derives locally.
 */
export const useBands = () => {
  const { data: bands, isLoading } = useGetBandsQuery();

  return useMemo(() => {
    const list: Band[] = bands ?? [];
    const byId = new Map(list.map((band) => [band.id, band]));

    // Members are deduped across bands: someone playing in two of them is one suggestion.
    const memberNames = Array.from(new Set(list.flatMap((band) => band.members))).sort((a, b) => a.localeCompare(b));

    return {
      bands: list,
      byId,
      /** Band names in the account's display order — the order suggestions are offered in. */
      bandNames: list.map((band) => band.name),
      memberNames,
      /** Resolve an assignment (ids) to bands, dropping ids whose band is gone. */
      resolve: (ids?: number[]): Band[] => (ids ?? []).map((id) => byId.get(id)).filter((band): band is Band => !!band),
      isLoading,
    };
  }, [bands, isLoading]);
};
