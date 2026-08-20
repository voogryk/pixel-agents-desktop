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
/** Interior floor size of every room (excludes the 1-tile wall border). Big
 *  enough to hold a row (or two) of desk workstations plus a lounge and still
 *  leave open floor for characters to wander. */
export const ROOM_INNER_W = 16;
export const ROOM_INNER_H = 13;
/** Never place more than this many workstations (desk + PC + seat) in one room,
 *  however many panes the window has; extra occupants take the lounge sofas or
 *  wander the room seatless (still confined). */
export const MAX_SEATS_PER_ROOM = 6;
/** A workstation block is 3 tiles wide, 3 tall (desk 3x2 + seat below), and
 *  tiled on a 4x4 grid so neighbours don't touch. */
const WORKSTATION_STRIDE_X = 4;
const WORKSTATION_STRIDE_Y = 4;

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

/** Rows at the bottom of a room reserved for decor (lounge / plants / bin). */
const DECOR_BAND_H = 5;

/** 32-bit FNV-1a hash of a string — a stable seed per room key. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). Seeded per room so decor is varied between
 *  rooms but STABLE for a given room across regenerations — a room keeps its
 *  couches and plants when another window opens, rather than reshuffling. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A desk workstation: DESK_FRONT (3x2) with a PC on top and a bench seat below
 * it, facing up into the desk. Geometry copied from the bundled default layout
 * so the seat is valid and PC-facing (drives the "typing at the PC" auto-on).
 * Origin (dx,dy) is the desk's top-left. Occupies cols dx..dx+2, rows dy..dy+2.
 */
function workstation(dx: number, dy: number, uid: string): PlacedFurniture[] {
  return [
    { type: 'DESK_FRONT', uid: `${uid}-desk`, col: dx, row: dy },
    { type: 'PC_FRONT_OFF', uid: `${uid}-pc`, col: dx + 1, row: dy },
    { type: 'CUSHIONED_BENCH', uid: `${uid}-seat`, col: dx + 1, row: dy + 2 },
  ];
}

/**
 * A lounge whose table top-left is (tx,ty). `full` rings the COFFEE_TABLE with
 * four sofas; otherwise just north + south. The block spans cols tx-1..tx+2,
 * rows ty-1..ty+2. Sofas are seats too — lower-priority than PC desks, so agents
 * fill desks first and only spill onto the couches.
 */
function lounge(tx: number, ty: number, uid: string, full: boolean): PlacedFurniture[] {
  const pieces: PlacedFurniture[] = [
    { type: 'COFFEE_TABLE', uid: `${uid}-table`, col: tx, row: ty },
    { type: 'COFFEE', uid: `${uid}-cup`, col: tx, row: ty + 1 },
    { type: 'SOFA_FRONT', uid: `${uid}-sofa-n`, col: tx, row: ty - 1 },
    { type: 'SOFA_BACK', uid: `${uid}-sofa-s`, col: tx, row: ty + 2 },
  ];
  if (full) {
    pieces.push(
      { type: 'SOFA_SIDE', uid: `${uid}-sofa-w`, col: tx - 1, row: ty },
      { type: 'SOFA_SIDE:left', uid: `${uid}-sofa-e`, col: tx + 2, row: ty },
    );
  }
  return pieces;
}

/**
 * Decorate a room's bottom band, varied per room but deterministic for a given
 * room (seeded on its label): a lounge — full, half, or absent — placed left /
 * center / right, then a seeded scatter of plants and maybe a bin. An occupancy
 * grid keeps pieces from overlapping. `ix,iy,iw,ih` is the interior; decor stays
 * inside the reserved band so it never touches the workstations above.
 */
function furnishDecor(
  ix: number,
  iy: number,
  iw: number,
  ih: number,
  label: string,
): PlacedFurniture[] {
  const out: PlacedFurniture[] = [];
  const bandTop = iy + ih - DECOR_BAND_H;
  const rng = mulberry32(hashString(label));
  const occ = new Set<string>();

  const fits = (c: number, r: number, w: number, h: number): boolean => {
    if (c < ix || r < bandTop || c + w - 1 > ix + iw - 1 || r + h - 1 > iy + ih - 1) return false;
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        if (occ.has(`${c + dc},${r + dr}`)) return false;
      }
    }
    return true;
  };
  const mark = (c: number, r: number, w: number, h: number): void => {
    for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) occ.add(`${c + dc},${r + dr}`);
  };
  const place = (
    type: string,
    uid: string,
    c: number,
    r: number,
    w: number,
    h: number,
  ): boolean => {
    if (!fits(c, r, w, h)) return false;
    mark(c, r, w, h);
    out.push({ type, uid, col: c, row: r });
    return true;
  };

  // Lounge: full / half / none, at a seeded horizontal position.
  const style = rng();
  const full = style < 0.55;
  const hasLounge = style < 0.8; // 20% of rooms get no lounge
  if (hasLounge) {
    const ty = bandTop + 1;
    const slots = [ix + 2, ix + Math.floor(iw / 2) - 1, ix + iw - 3];
    const tx = slots[Math.floor(rng() * slots.length)];
    // Reserve the lounge's whole 4x4 bbox before committing so a side sofa
    // never lands on a plant placed later (and vice-versa).
    if (fits(tx - 1, ty - 1, 4, 4)) {
      for (const piece of lounge(tx, ty, `${label}-lounge`, full)) {
        const w = piece.type.startsWith('SOFA_SIDE') ? 1 : piece.type === 'COFFEE_TABLE' ? 2 : 2;
        const h = piece.type.startsWith('SOFA_SIDE') ? 2 : 1;
        place(piece.type, piece.uid, piece.col, piece.row, w, h);
      }
    }
  }

  // Plants (1x2): 1–3, seeded columns along the band's bottom row.
  const plantTypes = ['PLANT', 'PLANT_2'];
  const nPlants = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < nPlants; i++) {
    const c = ix + Math.floor(rng() * iw);
    const type = plantTypes[Math.floor(rng() * plantTypes.length)];
    place(type, `${label}-plant-${i}`, c, iy + ih - 2, 1, 2);
  }

  // A bin, half the time.
  if (rng() < 0.5) {
    const c = ix + Math.floor(rng() * iw);
    place('BIN', `${label}-bin`, c, iy + ih - 1, 1, 1);
  }

  return out;
}

/**
 * Furnish a room's interior: a grid of workstations (one per occupant, capped),
 * then a seeded decor band (lounge + plants + bin) that varies per room. `ix,iy`
 * is the interior top-left; `iw,ih` its size. Every piece is bounds-checked so
 * nothing lands on a wall. Returns the placed furniture.
 */
function furnishRoom(
  ix: number,
  iy: number,
  iw: number,
  ih: number,
  capacity: number,
  label: string,
): PlacedFurniture[] {
  const out: PlacedFurniture[] = [];
  const within = (c: number, r: number, w: number, h: number) =>
    c >= ix && r >= iy && c + w - 1 <= ix + iw - 1 && r + h - 1 <= iy + ih - 1;

  // Reserve the bottom DECOR_BAND_H rows for decor; workstations fill above.
  const wsZoneH = ih - DECOR_BAND_H;
  const perRow = Math.max(1, Math.floor(iw / WORKSTATION_STRIDE_X));
  const wsRows = Math.max(1, Math.floor(wsZoneH / WORKSTATION_STRIDE_Y));
  const wsCapacity = perRow * wsRows;
  const wsCount = Math.max(1, Math.min(capacity, MAX_SEATS_PER_ROOM, wsCapacity));

  let placed = 0;
  for (let gr = 0; gr < wsRows && placed < wsCount; gr++) {
    for (let gc = 0; gc < perRow && placed < wsCount; gc++) {
      const dx = ix + 1 + gc * WORKSTATION_STRIDE_X;
      const dy = iy + 1 + gr * WORKSTATION_STRIDE_Y;
      if (!within(dx, dy, 3, 3)) continue;
      out.push(...workstation(dx, dy, `${label}-ws${placed}`));
      placed++;
    }
  }

  out.push(...furnishDecor(ix, iy, iw, ih, label));
  return out;
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

    // Prefab furniture: desks (one per occupant, capped) + a lounge + plants.
    furniture.push(
      ...furnishRoom(
        originCol + 1,
        originRow + 1,
        ROOM_INNER_W,
        ROOM_INNER_H,
        room.capacity,
        room.label,
      ),
    );

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
