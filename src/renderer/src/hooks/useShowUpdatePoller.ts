import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppSelector, useAppDispatch } from '@/store';
import { setCurrentShow, useGetShow } from '@/store/showSlice';
import { loadShowSongs } from '@/store/songsSlice';
import { useGetShowsRevisionQuery, useLazyGetShowQuery } from '@/api/shows.api';
import { useGetSessionQuery } from '@/api/session.api';
import { useGetSettings } from '@/store/settingsSlice';
import type { Show } from '@/api/shows.api';
import { normalizeOrderSig } from '@/utils/syncProtocol';

const POLL_INTERVAL_MS = 30_000;
/** Delay before re-attempting a failed classification fetch (shorter than the poll). */
const RETRY_DELAY_MS = 10_000;

/**
 * Polls the server every 30 s for changes to the currently loaded show and flags when
 * *someone else* changed it on the server.
 *
 * To keep the background poll cheap, it hits the lightweight `ShowsRevision` feed
 * (title + date only) rather than downloading every show's full `order` payload. The
 * full show is fetched **only when the server timestamp actually changes** — and then
 * its order is compared against our snapshot to tell our own save apart from a foreign
 * edit (so saving your own show never raises the banner).
 *
 * - `updateAvailable` — a newer, foreign version exists on the server.
 * - `updatedAt`        — the server timestamp of the loaded show (for relative display).
 * - `reloadShow()`     — apply the server version and reset the flag.
 * - `dismiss()`        — clear the flag without reloading.
 *
 * With `autoReload` enabled a detected foreign update is applied straight away and
 * `updateAvailable` never goes true — used by the musician auto-refresh mode and by the
 * operator while it follows remote commands, where a manual confirmation only gets in the way.
 *
 * - `reloadFailed` — a change WAS detected but fetching it keeps failing; the change is
 *   retried automatically, and this flag lets the UI say so instead of silently drifting
 *   out of sync (indices sent by remote pages then point into a stale order).
 */
export const useShowUpdatePoller = ({ autoReload = false }: { autoReload?: boolean } = {}) => {
  const dispatch = useAppDispatch();
  const { currentShow, isShowSelectorOpen } = useGetShow();
  const { serverSnapshot } = useAppSelector((s) => s.show);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [reloadFailed, setReloadFailed] = useState(false);
  /** Bumped after a failed classification fetch to re-run the effect (the revision data
   *  itself is referentially stable between polls, so it cannot re-trigger the retry). */
  const [retryTick, setRetryTick] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureCountRef = useRef(0);

  // The server timestamp last observed for the current show (avoids re-fetching the
  // full show unless it actually changed).
  const lastSeenDateRef = useRef<string | null>(null);
  const currentTitleRef = useRef<string | null>(null);
  // Read inside the classification callback and by reloadShow so neither has to be
  // re-created (and the poll effect re-run) when the flag or the show object changes.
  const autoReloadRef = useRef(autoReload);
  autoReloadRef.current = autoReload;
  const currentShowRef = useRef(currentShow);
  currentShowRef.current = currentShow;

  const { offlineMode } = useGetSettings();
  const { data: session } = useGetSessionQuery(undefined, { skip: offlineMode });
  const isAuthenticated = offlineMode || session?.isAuthenticated === true;

  const { data: revisionData } = useGetShowsRevisionQuery(undefined, {
    pollingInterval: POLL_INTERVAL_MS,
    skip: !currentShow || isShowSelectorOpen || !isAuthenticated,
  });
  const [fetchShow] = useLazyGetShowQuery();

  // Reset the baseline when the loaded show changes.
  useEffect(() => {
    if (currentShow?.title !== currentTitleRef.current) {
      currentTitleRef.current = currentShow?.title ?? null;
      lastSeenDateRef.current = null;
      failureCountRef.current = 0;
      setUpdateAvailable(false);
      setUpdatedAt(null);
      setReloadFailed(false);
    }
  }, [currentShow?.title]);

  // Clear a pending retry on unmount.
  useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!currentShow || !revisionData) return;
    const rev = revisionData.shows?.find((r) => r.title === currentShow.title);
    if (!rev) return;

    setUpdatedAt(rev.date ?? null);

    // Server timestamp unchanged since we last looked → nothing to do (cheap path).
    if (rev.date === lastSeenDateRef.current) return;

    // Timestamp changed — fetch just this show and classify our own save vs a foreign edit.
    // The revision is only marked as seen once that fetch SUCCEEDS: stamping it up front
    // meant one transient failure (sleep/wake, network blip) silently swallowed the change
    // forever — no reload, no banner — until the next foreign save bumped the timestamp.
    fetchShow({ title: currentShow.title })
      .unwrap()
      .then((data) => {
        lastSeenDateRef.current = rev.date ?? null;
        failureCountRef.current = 0;
        setReloadFailed(false);
        const polledShow = data.shows?.[0];
        if (!polledShow) return;
        const polledSig = normalizeOrderSig(polledShow);
        const snapshotSig = normalizeOrderSig(serverSnapshot ?? currentShow);
        if (polledSig === snapshotSig) return;
        if (autoReloadRef.current) {
          // Auto mode — we already hold the server version, so apply it directly
          // instead of raising the banner and re-fetching on confirmation.
          dispatch(setCurrentShow(polledShow));
          void dispatch(loadShowSongs(polledShow));
        } else {
          setUpdateAvailable(true);
        }
      })
      .catch(() => {
        // Leave lastSeenDateRef unstamped so the change stays pending, and retry sooner
        // than the next poll. One failed attempt is routine (wake from sleep); from the
        // second on, tell the UI the show is known-stale.
        failureCountRef.current += 1;
        if (failureCountRef.current >= 2) setReloadFailed(true);
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => setRetryTick((t) => t + 1), RETRY_DELAY_MS);
      });
  }, [revisionData, retryTick, currentShow, serverSnapshot, fetchShow, dispatch]);

  /**
   * Apply the server version of the current show.
   * `forceSongs` bypasses the song cache — used by the explicit "update everything"
   * action, where song/order edits must be picked up even if the show order is unchanged.
   */
  const reloadShow = useCallback(
    async ({ forceSongs = false }: { forceSongs?: boolean } = {}) => {
      setUpdateAvailable(false);
      const show = currentShowRef.current;
      if (!show) return;
      const data = await fetchShow({ title: show.title }).unwrap();
      const polled: Show | undefined = data.shows?.[0];
      if (polled) {
        lastSeenDateRef.current = polled.date ?? lastSeenDateRef.current;
        failureCountRef.current = 0;
        setReloadFailed(false);
        dispatch(setCurrentShow(polled));
        await dispatch(loadShowSongs({ show: polled, forceRefetch: forceSongs }));
      }
    },
    [dispatch, fetchShow],
  );

  const dismiss = useCallback(() => setUpdateAvailable(false), []);

  return { updateAvailable, updatedAt, reloadShow, dismiss, reloadFailed };
};
