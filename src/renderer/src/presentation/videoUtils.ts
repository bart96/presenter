// rAF-based fade helpers and per-element state tracking
// Enable debug logging if localStorage key 'presenter.videoDebug' is set to '1'.
const log = (...args: any[]) => {
  console.log('[videoUtils]', ...args);
};
// Track animation frame id and a token for robust cancellation semantics.
type FadeState = { id: number; token: number };
const fadeRaf = new WeakMap<HTMLVideoElement, FadeState>();
const fadeTokens = new WeakMap<HTMLVideoElement, number>();

// Separate RAF tracking for playbackRate fades
type RateState = { id: number; token: number };
const rateRaf = new WeakMap<HTMLVideoElement, RateState>();
const rateTokens = new WeakMap<HTMLVideoElement, number>();

// Minimum playback rate to avoid visual stutter when resuming
const MIN_PLAYBACK_RATE = 0.05;
// Grace period during which a recent user-set volume prevents programmatic
// fades from overwriting the user's choice
const USER_SET_GRACE_MS = 2000;

const isUserSetRecent = (v: HTMLVideoElement | null) => {
  if (!v) return false;
  try {
    const ts = userSetTimestamps.get(v);
    if (ts && Date.now() - ts < USER_SET_GRACE_MS) return true;
    const src = (v.currentSrc || v.src || '').toString();
    if (src) {
      const s = userSetSrcTimestamps.get(src);
      if (s && Date.now() - s < USER_SET_GRACE_MS) return true;
    }
  } catch (_) {}
  return false;
};

const applyProgrammaticVolume = (v: HTMLVideoElement, vol: number) => {
  // Only apply programmatic volume if the user hasn't set a value recently.
  if (isUserSetRecent(v)) {
    log('applyProgrammaticVolume skipped due to recent user set', { el: v, vol });
    return;
  }
  try {
    cancelFade(v);
    v.volume = vol;
    v.muted = vol === 0;
  } catch (_) {}
};

function cancelFade(video: HTMLVideoElement | null) {
  if (!video) return;
  const st = fadeRaf.get(video);
  if (st !== undefined) {
    cancelAnimationFrame(st.id);
    fadeRaf.delete(video);
    // bump token so any in-flight tick won't call onDone
    const prev = fadeTokens.get(video) ?? 0;
    fadeTokens.set(video, prev + 1);
    log('cancelFade for element', video, 'id', st.id, 'token bumped to', prev + 1);
    try {
      suppressAutoSave.delete(video);
    } catch (_) {}
  }
}

export function fadeVolumeRAF(video: HTMLVideoElement, from: number, to: number, durationMs: number, onDone?: () => void) {
  // Bump token for this new fade so any previous in-flight fade's onDone
  // won't run (defensive against race where a tick is executing while a new
  // fade is started).
  const prevToken = fadeTokens.get(video) ?? 0;
  const myToken = prevToken + 1;
  fadeTokens.set(video, myToken);
  cancelFade(video);
  // suppress auto-save of volumechange events while we programmatically
  // animate volume — prevents transient programmatic values overwriting
  // user-set values.
  try {
    suppressAutoSave.set(video, true);
  } catch (_) {}
  // If the user recently adjusted this video's volume, abort the programmatic
  // fade to avoid stomping their change.
  if (isUserSetRecent(video)) {
    log('fadeVolumeRAF aborted due to recent user set', { el: video });
    try {
      suppressAutoSave.delete(video);
    } catch (_) {}
    onDone?.();
    return;
  }
  log('fadeVolumeRAF start', { from, to, durationMs, el: video, token: myToken });
  if (durationMs <= 0) {
    video.volume = Math.max(0, Math.min(1, to));
    log('fadeVolumeRAF immediate set ->', video.volume);
    // only call onDone if token still matches
    try {
      suppressAutoSave.delete(video);
    } catch (_) {}
    const cur = fadeTokens.get(video);
    if (cur === myToken) onDone?.();
    return;
  }
  const start = performance.now();
  const clampedFrom = Math.max(0, Math.min(1, from));
  const clampedTo = Math.max(0, Math.min(1, to));
  // cubic ease-in-out for smoother fades
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const tick = (now: number) => {
    const elapsed = now - start;
    const raw = Math.min(1, elapsed / durationMs);
    const p = ease(raw);
    // Only write programmatic volume if user hasn't set recently.
    if (!isUserSetRecent(video)) {
      video.volume = Math.max(0, Math.min(1, clampedFrom + (clampedTo - clampedFrom) * p));
    }
    if (raw < 1) {
      const id = requestAnimationFrame(tick);
      fadeRaf.set(video, { id, token: myToken });
    } else {
      // only run onDone if our token still matches the latest token for this element
      const st = fadeRaf.get(video);
      if (st) fadeRaf.delete(video);
      try {
        suppressAutoSave.delete(video);
      } catch (_) {}
      log('fadeVolumeRAF done', { el: video, volume: video.volume, token: myToken });
      const cur = fadeTokens.get(video);
      if (cur === myToken) onDone?.();
    }
  };
  const id = requestAnimationFrame(tick);
  fadeRaf.set(video, { id, token: myToken });
}

function cancelRateFade(video: HTMLVideoElement | null) {
  if (!video) return;
  const st = rateRaf.get(video);
  if (st !== undefined) {
    cancelAnimationFrame(st.id);
    rateRaf.delete(video);
    const prev = rateTokens.get(video) ?? 0;
    rateTokens.set(video, prev + 1);
    log('cancelRateFade for element', video, 'id', st.id, 'token bumped to', prev + 1);
  }
}

export function fadePlaybackRateRAF(video: HTMLVideoElement, from: number, to: number, durationMs: number, onDone?: () => void) {
  // Bump token for this new rate fade
  const prevToken = rateTokens.get(video) ?? 0;
  const myToken = prevToken + 1;
  rateTokens.set(video, myToken);
  cancelRateFade(video);
  log('fadePlaybackRateRAF start', { from, to, durationMs, el: video, token: myToken });
  if (durationMs <= 0) {
    try {
      video.playbackRate = Math.max(MIN_PLAYBACK_RATE, Math.min(16, to));
    } catch (_) {}
    const cur = rateTokens.get(video);
    if (cur === myToken) onDone?.();
    return;
  }
  const start = performance.now();
  const clampedFrom = Math.max(MIN_PLAYBACK_RATE, Math.min(16, from));
  const clampedTo = Math.max(MIN_PLAYBACK_RATE, Math.min(16, to));
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const tick = (now: number) => {
    const elapsed = now - start;
    const raw = Math.min(1, elapsed / durationMs);
    const p = ease(raw);
    try {
      video.playbackRate = clampedFrom + (clampedTo - clampedFrom) * p;
    } catch (_) {}
    if (raw < 1) {
      const id = requestAnimationFrame(tick);
      rateRaf.set(video, { id, token: myToken });
    } else {
      const st = rateRaf.get(video);
      if (st) rateRaf.delete(video);
      log('fadePlaybackRateRAF done', { el: video, rate: video.playbackRate, token: myToken });
      const cur = rateTokens.get(video);
      if (cur === myToken) onDone?.();
    }
  };
  const id = requestAnimationFrame(tick);
  rateRaf.set(video, { id, token: myToken });
}

// Track the last-known non-zero volume for a video so we can restore it after
// fading to 0 (pause/stop). Use a WeakMap so entries don't leak when videos are removed.
const savedVolumes = new WeakMap<HTMLVideoElement, number>();
// Also keep a source-keyed map so saved volume survives element recreation.
const savedVolumesBySrc = new Map<string, number>();
// Track the last non-zero volume separately so we can restore "meaningful"
// volume when needed (but still allow explicit zero to be saved).
const lastNonZeroVolumes = new WeakMap<HTMLVideoElement, number>();
const lastNonZeroBySrc = new Map<string, number>();
// Per-element listener registry so we can auto-save manual volume changes
const volumeListeners = new WeakMap<HTMLVideoElement, EventListener>();
// Suppress auto-save while programmatic fades/updates are happening.
const suppressAutoSave = new WeakMap<HTMLVideoElement, boolean>();
// Track recent user-initiated sets so auto-save from fades doesn't briefly
// overwrite a user's slider change. Keyed by element and by src.
const userSetTimestamps = new WeakMap<HTMLVideoElement, number>();
const userSetSrcTimestamps = new Map<string, number>();
// Persisted muted state
const savedMuted = new WeakMap<HTMLVideoElement, boolean>();
const savedMutedBySrc = new Map<string, boolean>();
// Timestamps for saved values to avoid overwriting newer user choices
const savedTimestamps = new WeakMap<HTMLVideoElement, number>();
const savedSrcTimestamps = new Map<string, number>();

function persistSavedVolumeForElement(el: HTMLVideoElement, vol: number, muted: boolean, isUser = false) {
  try {
    const now = Date.now();
    // If not a user action and the user has set recently, don't overwrite
    if (!isUser && isUserSetRecent(el)) return;
    savedVolumes.set(el, vol);
    savedMuted.set(el, muted);
    savedTimestamps.set(el, now);
    if (vol > 0) lastNonZeroVolumes.set(el, vol);
    try {
      const src = (el.currentSrc || el.src || '').toString();
      if (src) {
        savedVolumesBySrc.set(src, vol);
        savedMutedBySrc.set(src, muted);
        savedSrcTimestamps.set(src, now);
        if (vol > 0) lastNonZeroBySrc.set(src, vol);
      }
    } catch (_) {}
  } catch (_) {}
}

function persistSavedVolumeForSrc(src: string, vol: number, muted: boolean, isUser = false) {
  try {
    const now = Date.now();
    // if not user and user set recently for this src, skip
    const us = userSetSrcTimestamps.get(src);
    if (!isUser && us && Date.now() - us < USER_SET_GRACE_MS) return;
    savedVolumesBySrc.set(src, vol);
    savedMutedBySrc.set(src, muted);
    savedSrcTimestamps.set(src, now);
  } catch (_) {}
}

// Per-element action token to avoid older actions (pause/stop) from
// colliding with newer actions (play). Bump on each user-initiated action.
const actionTokens = new WeakMap<HTMLVideoElement, number>();
type ActionRecord = { action: 'play' | 'pause' | 'stop' | 'other'; ts: number };
const actionTimes = new WeakMap<HTMLVideoElement, ActionRecord>();
const bumpActionToken = (v: HTMLVideoElement, action: ActionRecord['action'] = 'other') => {
  const prev = actionTokens.get(v) ?? 0;
  const now = prev + 1;
  actionTokens.set(v, now);
  try {
    actionTimes.set(v, { action, ts: Date.now() });
  } catch (_) {}
  return now;
};

const ensureAutoSaveListener = (v: HTMLVideoElement) => {
  if (!v) return;
  if (volumeListeners.get(v)) return;
  const fn = () => {
    try {
      const vol = v.volume ?? 0;
      if (suppressAutoSave.get(v)) {
        // ignore programmatic changes
        return;
      }
      // If the user recently set this element or this src, prefer their
      // choice and don't auto-save transient values for a short window.
      try {
        const us = userSetTimestamps.get(v);
        if (us && Date.now() - us < 2000) return;
        const src = (v.currentSrc || v.src || '').toString();
        const uSrc = src ? userSetSrcTimestamps.get(src) : undefined;
        if (uSrc && Date.now() - uSrc < 2000) return;
      } catch (_) {}
      // Only save meaningful positive volumes — we preserve the last non-zero
      // level so the user can temporarily silence the video without losing
      // their previous setting.
      // Always record the explicit, user-driven volume change so the UI
      // reflects the user's intent even when set to 0. Also persist to the
      // per-src map so recreated elements pick it up.
      const val = Math.max(0, Math.min(1, vol));
      // Treat volumechange from the element as a user action (immediate save)
      persistSavedVolumeForElement(v, val, v.muted ?? false, true);
      log('auto-saved volume via volumechange', val, v);
    } catch (_e) {
      /* ignore */
    }
  };
  v.addEventListener('volumechange', fn);
  volumeListeners.set(v, fn);
};
export const saveLastVolume = (v: HTMLVideoElement) => {
  if (!v) return;
  // Only record a meaningful non-zero volume. Do not overwrite an existing
  // saved volume with 0 or the fallback 1 — we want to preserve the last
  // non-zero level the user had.
  if (v.volume > 0) {
    const val = Math.max(0, Math.min(1, v.volume));
    // Record as the last non-zero value; do not clobber the explicit saved
    // volume entry (which may be 0 if the user set it so).
    lastNonZeroVolumes.set(v, val);
    try {
      const src = (v.currentSrc || v.src || '').toString();
      if (src) lastNonZeroBySrc.set(src, val);
    } catch (_) {}
    log('saveLastVolume', v, val);
  }
};
export const getSavedVolume = (v: HTMLVideoElement) => {
  if (!v) return 0;
  // Prefer an explicitly saved non-zero volume. Fall back to the element's
  // current volume (which may be 0). Do NOT assume 1 as a safe default —
  // that was causing sudden jumps to max volume.
  const sv = savedVolumes.get(v);
  let srcVal: number | undefined;
  try {
    const src = (v.currentSrc || v.src || '').toString();
    if (src) srcVal = savedVolumesBySrc.get(src);
  } catch (_) {
    srcVal = undefined;
  }
  log('getSavedVolume', { el: v, saved: sv, srcSaved: srcVal, current: v.volume });
  // Return explicit user-set volume (even if zero) first, then src-backed
  // explicit, then fallback to element volume, then 0.
  return sv !== undefined ? sv : srcVal !== undefined ? srcVal : (v.volume ?? 0);
};

export const getMeaningfulVolume = (v: HTMLVideoElement) => {
  if (!v) return 0;
  // If the element currently reports a real (>0) volume, use it.
  if (v.volume > 0) return v.volume;
  // If muted, that's intentionally silent.
  if (v.muted) return 0;
  // If we have a previously saved non-zero volume for this element, prefer it.
  const sv = lastNonZeroVolumes.get(v);
  let srcVal: number | undefined;
  try {
    const src = (v.currentSrc || v.src || '').toString();
    if (src) srcVal = lastNonZeroBySrc.get(src);
  } catch (_) {
    srcVal = undefined;
  }
  log('getMeaningfulVolume', { el: v, current: v.volume, muted: v.muted, lastNonZero: sv, srcLastNonZero: srcVal });
  if (sv !== undefined) return sv;
  if (srcVal !== undefined) return srcVal;
  // Otherwise assume silent (0). Previously this returned 1 which caused
  // an audible jump to 100% in some edge cases.
  return 0;
};

// Ramp an element to target volume over seconds (easeInSeconds). Uses fadeVolumeRAF.
export const rampToVolume = (el: HTMLVideoElement | null, targetVol: number, easeInSeconds?: number) => {
  if (!el) return;
  // Ensure we auto-save manual changes for this element so user-driven
  // slider updates are respected immediately.
  ensureAutoSaveListener(el);
  const dur = Math.max(0, Math.floor((easeInSeconds ?? 0) * 1000));
  // Cancel prior fades
  cancelFade(el);
  const from = el.volume;
  if (dur <= 0) {
    const val = Math.max(0, Math.min(1, targetVol));
    el.volume = val;
    el.muted = el.volume === 0;
    // Persist this immediate set so future play/pause restores the user's
    // expectation even if the element is re-created.
    persistSavedVolumeForElement(el, val, el.muted ?? false, false);
    log('rampToVolume immediate', { el, volume: el.volume });
    return;
  }
  // When ramping up from 0 we should ensure element is not muted
  if (targetVol > 0) el.muted = false;
  fadeVolumeRAF(el, from, targetVol, dur, () => {
    el.muted = el.volume === 0;
    log('rampToVolume done', { el, volume: el.volume });
  });
};

// Play with optional fade-in using saved volume when appropriate
export const playWithFade = (v: HTMLVideoElement, fadeDuration: number) => {
  if (fadeDuration > 0) {
    ensureAutoSaveListener(v);
    const myAction = bumpActionToken(v, 'play');
    // Prefer an explicit saved non-zero volume, then the element's current
    // positive volume. If neither exists and the element is muted, keep it
    // muted (target 0) to avoid sudden loudness.
    // Determine the target volume. Prefer an explicit saved value (per-element
    // or per-src). If that explicit value is zero but we have a recorded
    // last-non-zero volume (from saveLastVolume during pause), prefer that
    // so resuming restores the user's previous audible level instead of a
    // transient or programmatically-saved zero.
    const src = (v.currentSrc || v.src || '').toString();
    const explicitEl = savedVolumes.get(v);
    const explicitSrc = src ? savedVolumesBySrc.get(src) : undefined;
    const explicit = explicitEl !== undefined ? explicitEl : explicitSrc;
    const lastEl = lastNonZeroVolumes.get(v);
    const lastSrc = src ? lastNonZeroBySrc.get(src) : undefined;
    const last = lastEl !== undefined ? lastEl : lastSrc;
    let targetVol: number;
    if (explicit !== undefined) {
      if (explicit === 0 && last !== undefined) targetVol = last;
      else targetVol = explicit;
    } else if (v.volume > 0) {
      targetVol = v.volume;
    } else if (last !== undefined) {
      targetVol = last;
    } else {
      targetVol = 1;
    }

    log('playWithFade start', { el: v, targetVol, current: v.volume, muted: v.muted });
    // Start playback. If the target volume is 0 we simply play muted/silent
    // (no ramp). If it's >0 we ramp from 0 to the target.
    if (targetVol <= 0) {
      v.volume = 0;
      v.muted = true;
      // start playback visually; restore playbackRate to normal so the
      // visual doesn't appear slow after previous pauses slowed it down.
      try {
        // cancel any in-flight rate fades and ramp quickly to 1
        cancelRateFade(v);
        // use a short ramp to avoid jank
        fadePlaybackRateRAF(v, v.playbackRate ?? 0.25, 1, Math.min(150, fadeDuration), () => {
          log('playWithFade rate restored (silent)', { el: v, rate: v.playbackRate });
        });
      } catch (_) {}
      v.play()
        .then(() => log('play() started (silent)'))
        .catch((e) => log('play() rejected', e));
    } else {
      // Start playback silently and ramp to the target volume.
      v.muted = false;
      v.volume = 0;
      // start playback at reduced speed so the visual ramps with audio
      try {
        v.playbackRate = Math.max(0.05, Math.min(1, v.playbackRate ?? 0.25));
      } catch (_) {}
      v.play()
        .then(() => log('play() started'))
        .catch((e) => log('play() rejected', e));
      // Ramp both audio and playbackRate together
      fadeVolumeRAF(v, 0, targetVol, fadeDuration, () => {
        if (actionTokens.get(v) === myAction) log('playWithFade audio ramp done', { el: v, volume: v.volume });
      });
      fadePlaybackRateRAF(v, v.playbackRate ?? 0.25, 1, fadeDuration, () => {
        if (actionTokens.get(v) === myAction) log('playWithFade rate ramp done', { el: v, rate: v.playbackRate });
      });
    }
  } else {
    v.play().catch((e) => log('play() rejected', e));
  }
};

// Pause with optional fade-out and restore saved volume afterwards
export const pauseWithFade = (v: HTMLVideoElement, fadeDuration: number) => {
  if (fadeDuration > 0) {
    const prevAction = actionTimes.get(v);
    const myAction = bumpActionToken(v, 'pause');
    // If a play was started very recently for this element, assume that
    // play should take precedence and skip this immediate pause to avoid
    // flip-flop when switching items rapidly.
    if (prevAction && prevAction.action === 'play' && Date.now() - prevAction.ts < 400) {
      log('pauseWithFade skipped because a play occurred recently', { el: v, prevAction });
      return;
    }
    saveLastVolume(v);
    const startVol = getMeaningfulVolume(v);
    log('pauseWithFade start', { el: v, startVol, action: myAction });
    // Use playbackRate as primary visual fade measurement. Fade both audio
    // and playbackRate together; only pause when both have completed.
    const startRate = Math.max(0.01, v.playbackRate ?? 1);
    let volDone = false;
    let rateDone = false;
    const tryFinish = () => {
      if (volDone && rateDone && actionTokens.get(v) === myAction) {
        v.pause();
        // apply saved volume only if the user hasn't just set a value
        const sv = getSavedVolume(v);
        applyProgrammaticVolume(v, sv);
      }
    };

    // Ensure playbackRate fade runs even if startVol == 0
    try {
      v.playbackRate = startRate;
    } catch (_) {}
    fadeVolumeRAF(v, startVol, 0, fadeDuration, () => {
      volDone = true;
      log('pauseWithFade audio fade done', { el: v, action: myAction });
      tryFinish();
    });
    // Ramp playback speed down to near-zero for visual fade
    fadePlaybackRateRAF(v, startRate, 0.01, fadeDuration, () => {
      rateDone = true;
      log('pauseWithFade rate fade done', { el: v, action: myAction });
      tryFinish();
    });
  } else {
    v.pause();
  }
};

// Stop with optional fade-out and reset currentTime, restore saved volume
export const stopWithFade = (v: HTMLVideoElement, fadeDuration: number) => {
  if (fadeDuration > 0) {
    const prevAction = actionTimes.get(v);
    const myAction = bumpActionToken(v, 'stop');
    if (prevAction && prevAction.action === 'play' && Date.now() - prevAction.ts < 400) {
      log('stopWithFade skipped because a play occurred recently', { el: v, prevAction });
      return;
    }
    saveLastVolume(v);
    const startVol = getMeaningfulVolume(v);
    log('stopWithFade start', { el: v, startVol, action: myAction });
    if (startVol > 0) {
      const startRate = Math.max(0.01, v.playbackRate ?? 1);
      let volDone = false;
      let rateDone = false;
      const tryFinish = () => {
        if (volDone && rateDone && actionTokens.get(v) === myAction) {
          v.pause();
          v.currentTime = 0;
          const sv = getSavedVolume(v);
          applyProgrammaticVolume(v, sv);
        }
      };
      v.volume = startVol;
      v.muted = false;
      fadeVolumeRAF(v, startVol, 0, fadeDuration, () => {
        volDone = true;
        log('stopWithFade audio fade done', { el: v, action: myAction });
        tryFinish();
      });
      fadePlaybackRateRAF(v, startRate, 0.01, fadeDuration, () => {
        rateDone = true;
        log('stopWithFade rate fade done', { el: v, action: myAction });
        tryFinish();
      });
    } else {
      if (actionTokens.get(v) === myAction) {
        v.pause();
        v.currentTime = 0;
      } else {
        log('stopWithFade immediate skipped due to newer action', { el: v, action: myAction, now: actionTokens.get(v) });
      }
    }
  } else {
    v.pause();
    v.currentTime = 0;
  }
};

// cancelFade is internal; other modules can use the exposed ramp/play/pause helpers.

// Programmatic helpers for other modules to update saved volume state by src
export const setSavedVolumeForSrc = (src: string, vol: number) => {
  try {
    const v = Math.max(0, Math.min(1, vol));
    if (src) savedVolumesBySrc.set(src, v);
    // Apply immediately to any matching <video> elements so UI sliders
    // and active elements reflect the change without waiting for playback.
    try {
      document.querySelectorAll<HTMLVideoElement>(`video[src="${src}"]`).forEach((el) => {
        try {
          cancelFade(el);
          cancelRateFade(el);
          el.volume = v;
          el.muted = v === 0;
          persistSavedVolumeForElement(el, v, v === 0, true);
          try {
            userSetTimestamps.set(el, Date.now());
          } catch (_) {}
        } catch (_) {}
      });
      try {
        persistSavedVolumeForSrc(src, v, v === 0, true);
      } catch (_) {}
      try {
        userSetSrcTimestamps.set(src, Date.now());
      } catch (_) {}
    } catch (_) {}
    log('setSavedVolumeForSrc', src, v);
  } catch (_) {}
};

export const setSavedVolumeForElement = (el: HTMLVideoElement, vol: number) => {
  if (!el) return;
  const v = Math.max(0, Math.min(1, vol));
  // Apply immediately and cancel any fades to avoid race conditions.
  cancelFade(el);
  cancelRateFade(el);
  el.volume = v;
  el.muted = v === 0;
  persistSavedVolumeForElement(el, v, v === 0, true);
  try {
    userSetTimestamps.set(el, Date.now());
  } catch (_) {}
  try {
    const src = (el.currentSrc || el.src || '').toString();
    if (src) savedVolumesBySrc.set(src, v);
  } catch (_) {}
  log('setSavedVolumeForElement', el, v);
};

// Auto-attach volumechange listeners to any <video> elements that exist or
// are added to the document. This ensures slider changes (or other external
// volume adjustments) are recorded into savedVolumes regardless of how the
// element was created.
try {
  if (typeof window !== 'undefined' && typeof MutationObserver !== 'undefined') {
    const attachAll = () => {
      try {
        document.querySelectorAll('video').forEach((el) => {
          ensureAutoSaveListener(el as HTMLVideoElement);
        });
      } catch (_) {}
    };
    attachAll();
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of Array.from(m.addedNodes)) {
          try {
            if ((n as Element).tagName === 'VIDEO') ensureAutoSaveListener(n as HTMLVideoElement);
            if (n instanceof Element) {
              n.querySelectorAll && n.querySelectorAll('video').forEach((el) => ensureAutoSaveListener(el as HTMLVideoElement));
            }
          } catch (_) {}
        }
      }
    });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }
} catch (_) {}
