/**
 * Shared vocabulary for the `musician_sync` / `remote_command` messages that travel over
 * the WebSocket relay between the operator (`usePresentationSync`), the musician pages
 * (`MusicianPage`) and the mobile control page.
 *
 * Two facts every broadcast carries, and why:
 *
 * - **Who sent it** (`senderRole`/`senderId`). The relay fans a broadcast out to every peer
 *   of the account regardless of role, so an operator receives the broadcasts of *other
 *   operators* and cannot otherwise tell them apart from a musician driving the show. A
 *   background app instance sitting on a stale position used to drag the live operator back
 *   to its own item every time any musician connected or hit the footswitch.
 * - **Which show it is** (`showSig`). The protocol addresses items by *index*, so an index
 *   only means anything between two clients holding the same show order. Editing the show
 *   mid-service (inserting an item at the top, say) silently shifts every index on the
 *   clients that have not reloaded yet.
 *
 * Both fields are optional on the wire: a client that predates them sends neither, and the
 * receiver then falls back to the old, trusting behaviour rather than freezing it out.
 */
import type { Show } from '@/api/shows.api';

/** Who produced a `musician_sync`. Absent on clients that predate the field. */
export type SyncSenderRole = 'operator' | 'musician' | 'remote';

/** Envelope fields every `musician_sync` payload should carry. */
export interface SyncOrigin {
  /** Role of the client that produced this state. */
  senderRole?: SyncSenderRole;
  /** Stable per-device id, so a client can recognise its own echo. */
  senderId?: string;
  /** Fingerprint of the sender's show order — see `showOrderSignature`. */
  showSig?: string;
}

/**
 * Canonical JSON of a show's order, with per-item keys sorted and `undefined` dropped so
 * two structurally identical orders always stringify the same way.
 *
 * Shared with `useShowUpdatePoller`, which uses it to tell our own save apart from a
 * foreign edit — the two must agree on what "the same order" means or the poller and the
 * sync gate would disagree about whether a client is stale.
 */
export const normalizeOrderSig = (show: Show | null | undefined): string => {
  const normalized = (show?.order ?? []).map((item) => {
    const entries = Object.entries(item as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  });
  return JSON.stringify(normalized);
};

/**
 * Short content hash of a show's order, used as the version token in `musician_sync`.
 *
 * Deliberately derived from the order itself rather than from `shows.date`: server-side
 * rewrites of `shows.order` (the admin song merge, song renumbering) do not bump the
 * timestamp, so two clients can share a `date` and still disagree about the order. A
 * content hash cannot drift that way.
 *
 * FNV-1a, rendered as 8 hex chars — collisions do not matter here: the worst case of a
 * collision is the old, trusting behaviour, not a wrong jump.
 */
export const showOrderSignature = (show: Show | null | undefined): string | undefined => {
  if (!show) return undefined;
  const src = normalizeOrderSig(show);
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** How an incoming index compares to the receiver's own show. */
export type SyncMatch =
  /** Same show order — the index means what the sender meant. */
  | { kind: 'exact' }
  /** Different order, but the item the sender named was found here at another index. */
  | { kind: 'resolved'; itemIndex: number }
  /** Different order and the item could not be located — applying the index would jump. */
  | { kind: 'stale' };

interface ResolveArgs {
  /** `showSig` from the incoming payload; absent for clients that predate the field. */
  theirSig?: string;
  /** Our own show's signature. */
  ourSig?: string;
  /** Item index the sender is on. */
  theirItemIndex?: number;
  /** Song the sender says sits at that index, when the item is a song. */
  theirSongNumber?: number;
  /** Our show's items, in order. */
  ourItems: Array<{ type?: string; songNumber?: number }>;
}

/**
 * Decide whether an incoming item index can be trusted, and rescue it when it cannot.
 *
 * The signature is the fast path: equal signatures mean equal orders, so the index is
 * simply right. When they differ we fall back to the song number the sender put in the
 * payload — the show may have been reordered, but "the song they are on" is still a
 * question we can answer, and answering it beats refusing a footswitch press mid-service.
 * Only when neither works do we call it stale and let the caller warn the user.
 */
export const resolveSyncIndex = ({ theirSig, ourSig, theirItemIndex, theirSongNumber, ourItems }: ResolveArgs): SyncMatch => {
  // No index to place at all — nothing to disagree about.
  if (typeof theirItemIndex !== 'number') return { kind: 'exact' };

  // Either side predates the field, or the orders genuinely match: trust the index.
  // Trusting an untagged sender keeps an un-updated musician page working instead of
  // freezing it out, which is the safer direction for a client we cannot inspect.
  if (!theirSig || !ourSig || theirSig === ourSig) return { kind: 'exact' };

  // Orders differ. If the sender named a song, find where that song lives in OUR order.
  if (typeof theirSongNumber === 'number') {
    // Prefer the index they sent when it happens to hold the same song (an edit further
    // down the list leaves earlier indices meaning exactly what they always meant).
    const atTheirIndex = ourItems[theirItemIndex];
    if (atTheirIndex?.type === 'song' && atTheirIndex.songNumber === theirSongNumber) return { kind: 'exact' };

    const found = ourItems.findIndex((it) => it?.type === 'song' && it.songNumber === theirSongNumber);
    if (found >= 0) return { kind: 'resolved', itemIndex: found };
  }

  return { kind: 'stale' };
};
