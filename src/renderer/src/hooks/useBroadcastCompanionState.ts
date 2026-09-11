/**
 * Monitors Redux presentation state and broadcasts a `state_update` payload
 * to all connected WS clients whenever navigation state changes.
 * This covers changes triggered by the operator UI, keyboard, MIDI, and WS commands.
 *
 * The WS command hook sets `wsActionTrigger` before dispatching so the last/active
 * action names are included in the broadcast.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useAppSelector } from '@/store';
import { useGetPresentationSettings } from '@/store/presentationSlice';
import { selectCurrentSongOrder, useGetSongs } from '@/store/songsSlice';
import { useGetShow } from '@/store/showSlice';

/** Shared mutable trigger set by useWsCompanionCommands before each dispatch. */
export const wsActionTrigger = {
  pending: '',
};

const ACTIVE_ACTION_RESET_MS = 400;

export const useBroadcastCompanionState = () => {
  const { activeItemIndex, activeBlockIndex, activeLineIndex, isBlack } = useGetPresentationSettings();
  const { songsOrder, songs } = useGetSongs();
  const { currentShow } = useGetShow();

  // Resolve the current song from the SHOW order (not songsOrder — that array only
  // contains songs, so its indices diverge from activeItemIndex once non-song items exist).
  const activeShowItem = currentShow?.order?.[activeItemIndex];
  const currentSongNumber = activeShowItem
    ? activeShowItem.type === 'song'
      ? activeShowItem.songNumber
      : undefined
    : songsOrder[activeItemIndex];
  const orderName = useAppSelector((state) => (currentSongNumber != null ? selectCurrentSongOrder(state, currentSongNumber) : 'Default'));

  const showItemCount = currentShow?.order?.length ?? songsOrder.length;

  // Stable ref for broadcast metadata
  const lastTriggeredActionRef = useRef('');
  const activeActionRef = useRef('');
  const activeActionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref bundle for non-reactive values needed in the broadcast
  const ctxRef = useRef({
    activeItemIndex,
    activeBlockIndex,
    activeLineIndex,
    isBlack,
    songsOrder,
    songs,
    orderName,
    showItemCount,
    currentShow,
  });
  ctxRef.current = {
    activeItemIndex,
    activeBlockIndex,
    activeLineIndex,
    isBlack,
    songsOrder,
    songs,
    orderName,
    showItemCount,
    currentShow,
  };

  // Stable broadcast function — always reads latest state from ctxRef
  const doBroadcast = useCallback((overrideActiveAction?: string) => {
    if (!window.api?.wsBroadcastState) return;
    const s = ctxRef.current;

    const showItem = s.currentShow?.order?.[s.activeItemIndex];
    // Resolve the song via the show item — songsOrder indices don't line up with
    // activeItemIndex when the show contains non-song items.
    const songNum = showItem ? (showItem.type === 'song' ? showItem.songNumber : undefined) : s.songsOrder[s.activeItemIndex];
    const song = songNum != null ? s.songs[songNum] : undefined;
    const blocks = song?.getBlocks(s.orderName) ?? [];
    const nonCopyrightBlocks = blocks.filter((b) => !b.copyright);
    const activeBlock = nonCopyrightBlocks[s.activeBlockIndex];
    const nextBlock = nonCopyrightBlocks[s.activeBlockIndex + 1];

    window.api.wsBroadcastState({
      lastTriggeredAction: lastTriggeredActionRef.current,
      activeAction: overrideActiveAction !== undefined ? overrideActiveAction : activeActionRef.current,
      itemIndex: s.activeItemIndex,
      blockIndex: s.activeBlockIndex,
      lineIndex: s.activeLineIndex,
      isBlack: s.isBlack,
      showTitle: s.currentShow?.title ?? '',
      showItemCount: s.showItemCount,
      songTitle: song?.title ?? '',
      songNumber: songNum ?? null,
      blockName: activeBlock?.name ?? '',
      nextBlockName: nextBlock?.name ?? '',
      blockCount: nonCopyrightBlocks.length,
      showItemType: showItem?.type ?? '',
      orderName: s.orderName,
    });
  }, []); // stable — reads everything via refs

  // Broadcast whenever any tracked presentation state changes
  useEffect(() => {
    // Consume any pending WS/MIDI action trigger
    if (wsActionTrigger.pending) {
      lastTriggeredActionRef.current = wsActionTrigger.pending;
      activeActionRef.current = wsActionTrigger.pending;
      wsActionTrigger.pending = '';

      // Schedule reset of activeAction
      if (activeActionTimerRef.current) clearTimeout(activeActionTimerRef.current);
      activeActionTimerRef.current = setTimeout(() => {
        activeActionRef.current = '';
        doBroadcast('');
      }, ACTIVE_ACTION_RESET_MS);
    }

    doBroadcast();
  }, [activeItemIndex, activeBlockIndex, activeLineIndex, isBlack, songsOrder, orderName, doBroadcast]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (activeActionTimerRef.current) clearTimeout(activeActionTimerRef.current);
    };
  }, []);
};
