import { describe, expect, it } from 'vitest';

import {
  type GeneratedLayout,
  generateOfficeLayout,
  MAX_SEATS_PER_ROOM,
  ROOM_INNER_H,
  ROOM_INNER_W,
} from '../src/officeRoomLayout.js';

const WALL = 0;
const VOID = 255;

/** Interior floor tiles carrying a given room's area label. */
function interiorTiles(layout: GeneratedLayout, label: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      if (layout.areaTiles[r * layout.cols + c] === label) out.push([c, r]);
    }
  }
  return out;
}

/** Every tile reachable from (startC,startR) by 4-connected steps that never
 *  cross a WALL or VOID — the same reachability the character BFS uses. */
function floodFrom(layout: GeneratedLayout, startC: number, startR: number): Set<string> {
  const seen = new Set<string>();
  const walkable = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= layout.cols || r >= layout.rows) return false;
    const t = layout.tiles[r * layout.cols + c];
    return t !== WALL && t !== VOID;
  };
  if (!walkable(startC, startR)) return seen;
  const stack: Array<[number, number]> = [[startC, startR]];
  seen.add(`${startC},${startR}`);
  while (stack.length) {
    const [c, r] = stack.pop()!;
    for (const [dc, dr] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const) {
      const nc = c + dc;
      const nr = r + dr;
      const key = `${nc},${nr}`;
      if (!seen.has(key) && walkable(nc, nr)) {
        seen.add(key);
        stack.push([nc, nr]);
      }
    }
  }
  return seen;
}

describe('generateOfficeLayout', () => {
  it('walls the whole interior of a single room and seats one occupant', () => {
    const { layout, rooms } = generateOfficeLayout([{ label: 'win-a', capacity: 1 }]);
    expect(rooms).toHaveLength(1);

    const interior = interiorTiles(layout, 'win-a');
    expect(interior).toHaveLength(ROOM_INNER_W * ROOM_INNER_H);

    // The border around the interior is all walls.
    const box = rooms[0];
    for (let c = box.originCol; c <= box.originCol + ROOM_INNER_W + 1; c++) {
      expect(layout.tiles[box.originRow * layout.cols + c]).toBe(WALL);
      expect(layout.tiles[(box.originRow + ROOM_INNER_H + 1) * layout.cols + c]).toBe(WALL);
    }

    const chairs = layout.furniture.filter((f) => f.type === 'CUSHIONED_CHAIR_FRONT');
    expect(chairs).toHaveLength(1);
  });

  it('caps chairs at MAX_SEATS_PER_ROOM and keeps every chair on a labeled interior tile', () => {
    const { layout } = generateOfficeLayout([{ label: 'win-a', capacity: 99 }]);
    const chairs = layout.furniture;
    expect(chairs).toHaveLength(MAX_SEATS_PER_ROOM);
    for (const chair of chairs) {
      expect(layout.areaTiles[chair.row * layout.cols + chair.col]).toBe('win-a');
    }
  });

  it('seals each room: no walkable path crosses between two rooms', () => {
    const { layout } = generateOfficeLayout([
      { label: 'win-a', capacity: 2 },
      { label: 'win-b', capacity: 2 },
    ]);
    const a = interiorTiles(layout, 'win-a')[0];
    const reachable = floodFrom(layout, a[0], a[1]);

    // Every tile reachable from room A is labeled A (or unlabeled walkable inside
    // A) — never a tile belonging to room B.
    for (const key of reachable) {
      const [c, r] = key.split(',').map(Number);
      const label = layout.areaTiles[r * layout.cols + c];
      expect(label === 'win-a' || label === null).toBe(true);
    }
    // And B's interior is genuinely unreachable from A.
    for (const [c, r] of interiorTiles(layout, 'win-b')) {
      expect(reachable.has(`${c},${r}`)).toBe(false);
    }
  });

  it('keeps existing room slots at identical coordinates when a room is appended (stable slots)', () => {
    const three = generateOfficeLayout([
      { label: 'a', capacity: 1 },
      { label: 'b', capacity: 1 },
      { label: 'c', capacity: 1 },
    ]);
    const four = generateOfficeLayout([
      { label: 'a', capacity: 1 },
      { label: 'b', capacity: 1 },
      { label: 'c', capacity: 1 },
      { label: 'd', capacity: 1 },
    ]);
    for (const label of ['a', 'b', 'c']) {
      const before = three.rooms.find((r) => r.label === label)!;
      const after = four.rooms.find((r) => r.label === label)!;
      expect({ oc: after.originCol, or: after.originRow }).toEqual({
        oc: before.originCol,
        or: before.originRow,
      });
    }
    // The office grew downward (new row), width unchanged (both fill 3 columns).
    expect(four.layout.cols).toBe(three.layout.cols);
    expect(four.layout.rows).toBeGreaterThan(three.layout.rows);
  });

  it('never returns a zero-size grid for an empty room list', () => {
    const { layout, rooms } = generateOfficeLayout([]);
    expect(layout.cols).toBeGreaterThan(2);
    expect(layout.rows).toBeGreaterThan(2);
    expect(rooms).toHaveLength(1);
  });
});
