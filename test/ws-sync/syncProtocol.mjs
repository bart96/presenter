/**
 * Port of `src/renderer/src/utils/syncProtocol.ts`.
 *
 * Kept as a hand-port for the same reason the clients in `clients.mjs` are: this suite runs
 * on plain node against the real relay, and cannot import the app's TypeScript. Any change
 * to the source must be mirrored here — the assertions about which peer wins a disagreement
 * are only worth anything while the two agree on the rules.
 */

/** normalizeOrderSig — syncProtocol.ts:44 */
export const normalizeOrderSig = (show) => {
  const normalized = (show?.order ?? []).map((item) => {
    const entries = Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  });
  return JSON.stringify(normalized);
};

/** showOrderSignature — syncProtocol.ts:65 (FNV-1a over the normalized order) */
export const showOrderSignature = (show) => {
  if (!show) return undefined;
  const src = normalizeOrderSig(show);
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** resolveSyncIndex — syncProtocol.ts:104 */
export const resolveSyncIndex = ({ theirSig, ourSig, theirItemIndex, theirSongNumber, ourItems }) => {
  if (typeof theirItemIndex !== 'number') return { kind: 'exact' };
  if (!theirSig || !ourSig || theirSig === ourSig) return { kind: 'exact' };

  if (typeof theirSongNumber === 'number') {
    const atTheirIndex = ourItems[theirItemIndex];
    if (atTheirIndex?.type === 'song' && atTheirIndex.songNumber === theirSongNumber) return { kind: 'exact' };
    const found = ourItems.findIndex((it) => it?.type === 'song' && it.songNumber === theirSongNumber);
    if (found >= 0) return { kind: 'resolved', itemIndex: found };
  }

  return { kind: 'stale' };
};
