/**
 * Procedural "one room per iTerm2 window" office layout.
 *
 * Given an ordered list of rooms (slot order is stable — see roomRegistry), this
 * builds a full OfficeLayout the webview renders as-is: a grid of fully-walled
 * rooms, each a distinct floor color, its interior tiles labeled with the room's
 * area label, and a chair per expected occupant.
 *
 * Why fully walled with no doors: the character wander loop pathfinds with BFS
 * that never crosses a WALL tile and returns [] for an unreachable target
 * (webview-ui/.../tileMap.ts). A character spawns on its assigned seat inside a
 * room, so every reachable wander target is inside that same room — confinement
 * falls out of the walls, with no change to the movement code. Seats sit on
 * tiles carrying the room's area label, so the webview seats each agent in the
 * right room by matching its roomLabel against seatZone().
 *
 * Slots are stable: room i is always at grid cell (i % ROOM_COLS, i / ROOM_COLS)
 * with fixed tile coordinates, so opening another window appends a room (and, on
 * a new grid row, extends the office downward) without moving any existing room.
 */

// Tile ids mirror webview-ui/src/office/types.ts TileType. Duplicated as local
// consts so the server bundle doesn't import the webview package.
const WALL = 0;
const FLOOR = 1; // TileType.FLOOR_1
const VOID = 255;

/** Rooms per grid row. Fixed so existing rooms never shift when a new one is
 *  appended (stable slots). */
export const ROOM_COLS = 3;
/** Interior floor size of every room (excludes the 1-tile wall border). */
export const ROOM_INNER_W = 7;
export const ROOM_INNER_H = 6;
/** Never place more than this many chairs in one room, however many panes the
 *  window has; extra occupants wander the room seatless (still confined). */
export const MAX_SEATS_PER_ROOM = 6;

/** HSBC color, matching the webview's ColorValue (h,s,b,c). */
export interface RoomColor {
  h: number;
  s: number;
  b: number;
  c: number;
}

/** Per-room floor tints, cycled by slot. Warm, distinct, muted. */
const ROOM_FLOOR_COLORS: RoomColor[] = [
  { h: 35, s: 30, b: 15, c: 0 },
  { h: 25, s: 45, b: 5, c: 10 },
  { h: 210, s: 30, b: 10, c: 0 },
  { h: 145, s: 30, b: 8, c: 0 },
  { h: 280, s: 25, b: 10, c: 0 },
  { h: 0, s: 30, b: 8, c: 0 },
  { h: 190, s: 30, b: 10, c: 0 },
  { h: 55, s: 30, b: 12, c: 0 },
];

/* eslint-disable pixel-agents/no-inline-colors --
   These are AreaDefinition overlay tints sent to the client as layout DATA
   (one per room), not UI-chrome colors — the token rule doesn't apply. */
/** Overlay tints (hex) for the optional Areas overlay, parallel to the floors. */
const ROOM_AREA_HEX = [
  '#c9a26b',
  '#b5793f',
  '#6b8fc9',
  '#5fae7a',
  '#9b7ac9',
  '#c96b6b',
  '#5fb0c9',
  '#c9b45f',
];
/* eslint-enable pixel-agents/no-inline-colors */

/** What the generator is told about one room. */
export interface RoomSpec {
  /** Stable room key (e.g. "win-79299"). Used as the areaTiles label. */
  label: string;
  /** Expected occupants (panes in the window); clamps the chair count. */
  capacity: number;
}

/** Where a room sits, for the server to place name labels / debug. */
export interface RoomBox {
  label: string;
  /** Top-left wall corner (inclusive). */
  originCol: number;
  originRow: number;
  /** Interior extent. */
  innerW: number;
  innerH: number;
  /** Center of the interior — anchor for the room-name overlay. */
  centerCol: number;
  centerRow: number;
}

interface PlacedFurniture {
  type: string;
  uid: string;
  col: number;
  row: number;
}

/** The subset of the webview OfficeLayout the generator produces. Defined here
 *  (not imported from webview-ui) to keep the server package standalone. */
export interface GeneratedLayout {
  version: 1;
  cols: number;
  rows: number;
  tiles: number[];
  tileColors: Array<RoomColor | null>;
  areaTiles: Array<string | null>;
  areas: Array<{ label: string; color: string }>;
  furniture: PlacedFurniture[];
  pets: [];
}

export interface GeneratedOffice {
  layout: GeneratedLayout;
  rooms: RoomBox[];
}

/** Grid cell (gx, gy) for a room slot. */
function cellOf(slot: number): { gx: number; gy: number } {
  return { gx: slot % ROOM_COLS, gy: Math.floor(slot / ROOM_COLS) };
}

/**
 * Build the office. Rooms are consumed in order; index i is the stable slot.
 * An empty list yields a single empty walled room so the office is never a
 * zero-size grid the renderer can't center.
 */
export function generateOfficeLayout(specs: RoomSpec[]): GeneratedOffice {
  const rooms = specs.length > 0 ? specs : [{ label: 'win-none', capacity: 1 }];

  const cellW = ROOM_INNER_W + 1; // interior + shared left/top wall
  const cellH = ROOM_INNER_H + 1;
  const colsCount = Math.min(rooms.length, ROOM_COLS);
  const rowCount = Math.ceil(rooms.length / ROOM_COLS);
  const cols = colsCount * cellW + 1;
  const rowsTotal = rowCount * cellH + 1;

  const tileCount = cols * rowsTotal;
  const tiles = new Array<number>(tileCount).fill(VOID);
  const tileColors = new Array<RoomColor | null>(tileCount).fill(null);
  const areaTiles = new Array<string | null>(tileCount).fill(null);
  const furniture: PlacedFurniture[] = [];
  const areas: Array<{ label: string; color: string }> = [];
  const boxes: RoomBox[] = [];

  const idx = (col: number, row: number) => row * cols + col;

  rooms.forEach((room, slot) => {
    const { gx, gy } = cellOf(slot);
    const originCol = gx * cellW;
    const originRow = gy * cellH;
    const rightWall = originCol + ROOM_INNER_W + 1;
    const bottomWall = originRow + ROOM_INNER_H + 1;
    const color = ROOM_FLOOR_COLORS[slot % ROOM_FLOOR_COLORS.length];
    const hex = ROOM_AREA_HEX[slot % ROOM_AREA_HEX.length];

    // Perimeter walls (shared edges are simply painted twice — idempotent).
    for (let c = originCol; c <= rightWall; c++) {
      tiles[idx(c, originRow)] = WALL;
      tiles[idx(c, bottomWall)] = WALL;
    }
    for (let r = originRow; r <= bottomWall; r++) {
      tiles[idx(originCol, r)] = WALL;
      tiles[idx(rightWall, r)] = WALL;
    }

    // Interior floor: colored + labeled with the room's area key.
    for (let r = originRow + 1; r <= originRow + ROOM_INNER_H; r++) {
      for (let c = originCol + 1; c <= originCol + ROOM_INNER_W; c++) {
        const i = idx(c, r);
        tiles[i] = FLOOR;
        tileColors[i] = color;
        areaTiles[i] = room.label;
      }
    }

    areas.push({ label: room.label, color: hex });

    // Chairs: one per occupant, capped. Laid left-to-right on interior rows,
    // inset one tile from the walls, wrapping to the next row, leaving ample
    // walkable floor between them.
    const seatCount = Math.max(1, Math.min(room.capacity, MAX_SEATS_PER_ROOM));
    let placed = 0;
    for (let sr = 0; sr < ROOM_INNER_H && placed < seatCount; sr += 2) {
      for (let sc = 0; sc < ROOM_INNER_W && placed < seatCount; sc += 2) {
        furniture.push({
          type: 'CUSHIONED_CHAIR_FRONT',
          uid: `${room.label}-seat-${placed}`,
          col: originCol + 1 + sc,
          row: originRow + 1 + sr,
        });
        placed++;
      }
    }

    boxes.push({
      label: room.label,
      originCol,
      originRow,
      innerW: ROOM_INNER_W,
      innerH: ROOM_INNER_H,
      centerCol: originCol + 1 + Math.floor((ROOM_INNER_W - 1) / 2),
      centerRow: originRow + 1 + Math.floor((ROOM_INNER_H - 1) / 2),
    });
  });

  return {
    layout: {
      version: 1,
      cols,
      rows: rowsTotal,
      tiles,
      tileColors,
      areaTiles,
      areas,
      furniture,
      pets: [],
    },
    rooms: boxes,
  };
}
