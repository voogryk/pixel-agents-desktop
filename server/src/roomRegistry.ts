/**
 * Stable room-slot allocation for "one room per iTerm2 window".
 *
 * A room is keyed by a stable string (an iTerm2 window id — "win-79299" — or the
 * catch-all "other"). Each key holds a slot (its fixed cell in the office grid)
 * and a display name. The invariant the user asked for is "stable slots": a live
 * window never changes slot, so opening another window appends a room without
 * moving any existing one. A key's slot is only freed when its window closes,
 * and freed slots are reused lowest-first by the next new window.
 *
 * Pure and synchronous; the runtime owns persistence and the topology read.
 */

export interface RoomEntry {
  /** Fixed grid cell for this room (0-based). Never changes while the key lives. */
  slot: number;
  /** Display name shown over the room. Auto-seeded, then user-renamable. */
  name: string;
}

export type RoomRegistry = Record<string, RoomEntry>;

export interface ReconcileResult {
  registry: RoomRegistry;
  /** True when the set of live rooms or their slots changed — the caller must
   *  regenerate the office layout. Renames alone do NOT set this. */
  changed: boolean;
}

/** Lowest non-negative integer not in `used`. */
function lowestFreeSlot(used: Set<number>): number {
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

/**
 * Reconcile the registry against the currently-live room keys.
 *
 * - Keys gone from `activeKeys` are dropped (their window closed), freeing slots.
 * - Surviving keys keep their slot and name.
 * - New keys get the lowest free slot and a name from `nameFor`.
 *
 * `changed` reports whether the live-room topology moved (added/removed/re-slotted),
 * so the caller only regenerates the layout when it must.
 */
export function reconcileRooms(
  prev: RoomRegistry,
  activeKeys: string[],
  nameFor: (key: string) => string,
): ReconcileResult {
  const active = new Set(activeKeys);
  const next: RoomRegistry = {};
  const usedSlots = new Set<number>();

  // Survivors keep their slot + name.
  for (const key of activeKeys) {
    const existing = prev[key];
    if (existing && !usedSlots.has(existing.slot)) {
      next[key] = { slot: existing.slot, name: existing.name };
      usedSlots.add(existing.slot);
    }
  }

  // New keys (and any survivor whose stored slot collided) get the lowest free slot.
  for (const key of activeKeys) {
    if (next[key]) continue;
    const slot = lowestFreeSlot(usedSlots);
    usedSlots.add(slot);
    next[key] = { slot, name: nameFor(key) };
  }

  const prevKeys = Object.keys(prev).filter((k) => active.has(k));
  let changed = prevKeys.length !== activeKeys.length;
  if (!changed) {
    for (const key of activeKeys) {
      if (!prev[key] || prev[key].slot !== next[key].slot) {
        changed = true;
        break;
      }
    }
  }

  return { registry: next, changed };
}

/** Rooms in slot order — the shape the layout generator consumes. */
export function roomsInSlotOrder(registry: RoomRegistry): Array<{ key: string; entry: RoomEntry }> {
  return Object.entries(registry)
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => a.entry.slot - b.entry.slot);
}
