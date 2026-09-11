import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store';
import {
  freezeWindow,
  setActiveBlockIndex,
  setActiveItemIndex,
  setActiveLineIndex,
  setBlack,
  toggleBlack,
  unfreezeWindow,
  useGetPresentationSettings,
} from '@/store/presentationSlice';
import { useGetSettings } from '@/store/settingsSlice';
import { selectCurrentSongOrder, useGetSongs } from '@/store/songsSlice';
import { useGetShow } from '@/store/showSlice';
import { countPrimaryLines } from '@/song';
import { wsActionTrigger } from './useBroadcastCompanionState';

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** Set the pending action trigger so the state-watcher broadcast includes it. */
const trigger = (action: string) => {
  wsActionTrigger.pending = action;
};

export const useWsCompanionCommands = () => {
  const dispatch = useAppDispatch();
  const { companionCommandsEnabled, resetBlackOnSwitch } = useGetSettings();
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
  const currentSong = currentSongNumber != null ? songs[currentSongNumber] : undefined;
  const orderName = useAppSelector((state) => (currentSongNumber != null ? selectCurrentSongOrder(state, currentSongNumber) : 'Default'));

  const showItemCount = currentShow?.order?.length ?? songsOrder.length;

  // Keep a stable ref so event handlers always see latest state
  const stateRef = useRef({
    companionCommandsEnabled,
    resetBlackOnSwitch,
    activeItemIndex,
    activeBlockIndex,
    activeLineIndex,
    isBlack,
    currentSong,
    orderName,
    showItemCount,
    currentShow,
    songsOrder,
    songs,
  });

  stateRef.current = {
    companionCommandsEnabled,
    resetBlackOnSwitch,
    activeItemIndex,
    activeBlockIndex,
    activeLineIndex,
    isBlack,
    currentSong,
    orderName,
    showItemCount,
    currentShow,
    songsOrder,
    songs,
  };

  useEffect(() => {
    // Register navigation listener if available
    const removeNavigationListener = window.api?.onWsNavigationAction?.((data) => {
      const s = stateRef.current;
      if (!s.companionCommandsEnabled) return;

      switch (data.action) {
        case 'prev_item':
          if (s.activeItemIndex > 0) {
            trigger(data.action);
            dispatch(setActiveItemIndex(s.activeItemIndex - 1));
            if (s.resetBlackOnSwitch) dispatch(setBlack(false));
          }
          break;
        case 'next_item':
          if (s.activeItemIndex < s.showItemCount - 1) {
            trigger(data.action);
            dispatch(setActiveItemIndex(s.activeItemIndex + 1));
            if (s.resetBlackOnSwitch) dispatch(setBlack(false));
          }
          break;
        case 'prev_block':
          if (s.activeBlockIndex > 0) {
            trigger(data.action);
            dispatch(setActiveBlockIndex(s.activeBlockIndex - 1));
          }
          break;
        case 'next_block': {
          if (!s.currentSong) break;
          const allBlocks = s.currentSong.getBlocks(s.orderName);
          if (s.activeBlockIndex < allBlocks.length - 1) {
            trigger(data.action);
            dispatch(setActiveBlockIndex(s.activeBlockIndex + 1));
          }
          break;
        }
        case 'prev_line': {
          if (!s.currentSong) break;
          if (s.activeLineIndex > 0) {
            trigger(data.action);
            dispatch(setActiveLineIndex(s.activeLineIndex - 1));
          } else if (s.activeBlockIndex > 0) {
            const prevBlockLines = s.currentSong.getBlock(s.orderName, s.activeBlockIndex - 1);
            const primaryCount = countPrimaryLines(prevBlockLines, s.currentSong.languages?.[0]);
            trigger(data.action);
            dispatch(setActiveBlockIndex(s.activeBlockIndex - 1));
            dispatch(setActiveLineIndex(Math.max(0, primaryCount - 1)));
          }
          break;
        }
        case 'next_line': {
          if (!s.currentSong) break;
          const currentLines = s.currentSong.getBlock(s.orderName, s.activeBlockIndex);
          const primaryCount = countPrimaryLines(currentLines, s.currentSong.languages?.[0]);
          if (s.activeLineIndex < primaryCount - 1) {
            trigger(data.action);
            dispatch(setActiveLineIndex(s.activeLineIndex + 1));
          } else {
            const nonCopyrightCount = s.currentSong.getBlocks(s.orderName).filter((b) => !b.copyright).length;
            if (s.activeBlockIndex < nonCopyrightCount - 1) {
              trigger(data.action);
              dispatch(setActiveBlockIndex(s.activeBlockIndex + 1));
            }
          }
          break;
        }
        case 'set_item': {
          const index = asNumber(data.payload?.index);
          if (index != null) {
            const clamped = Math.max(0, Math.min(Math.floor(index), Math.max(0, s.showItemCount - 1)));
            trigger(data.action);
            dispatch(setActiveItemIndex(clamped));
            if (s.resetBlackOnSwitch) dispatch(setBlack(false));
          }
          break;
        }
        case 'set_block': {
          const index = asNumber(data.payload?.index);
          if (index != null && s.currentSong) {
            const max = Math.max(0, s.currentSong.getBlocks(s.orderName).length - 1);
            const clamped = Math.max(0, Math.min(Math.floor(index), max));
            trigger(data.action);
            dispatch(setActiveBlockIndex(clamped));
          }
          break;
        }
        case 'set_line': {
          const index = asNumber(data.payload?.index);
          if (index != null && s.currentSong) {
            const currentLines = s.currentSong.getBlock(s.orderName, s.activeBlockIndex);
            const max = Math.max(0, countPrimaryLines(currentLines, s.currentSong.languages?.[0]) - 1);
            const clamped = Math.max(0, Math.min(Math.floor(index), max));
            trigger(data.action);
            dispatch(setActiveLineIndex(clamped));
          }
          break;
        }
        case 'set_black': {
          const newBlack = Boolean(data.payload?.value);
          trigger(data.action);
          dispatch(setBlack(newBlack));
          break;
        }
        case 'toggle_black': {
          trigger(data.action);
          dispatch(toggleBlack());
          break;
        }
        case 'freeze_window':
          if (typeof data.payload?.windowName === 'string' && data.payload.windowName) {
            trigger(data.action);
            dispatch(freezeWindow(data.payload.windowName));
          }
          break;
        case 'unfreeze_window':
          if (typeof data.payload?.windowName === 'string' && data.payload.windowName) {
            trigger(data.action);
            dispatch(unfreezeWindow(data.payload.windowName));
          }
          break;
        default:
          break;
      }
    });

    const removeVideoListener = window.api?.onWsVideoAction?.((data) => {
      const s = stateRef.current;
      if (!s.companionCommandsEnabled || !window.api?.videoCommand) return;

      switch (data.action) {
        case 'video_play':
          trigger(data.action);
          void window.api.videoCommand({ action: 'play', windowName: data.target });
          break;
        case 'video_pause':
          trigger(data.action);
          void window.api.videoCommand({ action: 'pause', windowName: data.target });
          break;
        case 'video_stop':
          trigger(data.action);
          void window.api.videoCommand({ action: 'stop', windowName: data.target });
          break;
        case 'video_seek': {
          const position = asNumber(data.payload?.position);
          if (position != null) {
            trigger(data.action);
            void window.api.videoCommand({ action: 'seek', windowName: data.target, value: position });
          }
          break;
        }
        default:
          break;
      }
    });

    return () => {
      if (typeof removeNavigationListener === 'function') removeNavigationListener();
      if (typeof removeVideoListener === 'function') removeVideoListener();
    };
    // Register listeners once — state is always read from stateRef
  }, [dispatch]);
};
