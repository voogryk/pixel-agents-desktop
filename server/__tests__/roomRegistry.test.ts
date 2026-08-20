import { describe, expect, it } from 'vitest';

import { reconcileRooms, type RoomRegistry, roomsInSlotOrder } from '../src/roomRegistry.js';

const nameFor = (key: string) => `name-of-${key}`;

describe('reconcileRooms', () => {
  it('assigns slot 0,1,2… to new keys and reports changed', () => {
    const { registry, changed } = reconcileRooms({}, ['win-a', 'win-b'], nameFor);
    expect(registry['win-a'].slot).toBe(0);
    expect(registry['win-b'].slot).toBe(1);
    expect(registry['win-a'].name).toBe('name-of-win-a');
    expect(changed).toBe(true);
  });

  it('keeps a surviving window at its slot and name when another appears (stable slots)', () => {
    const prev: RoomRegistry = { 'win-a': { slot: 0, name: 'Backend' } };
    const { registry, changed } = reconcileRooms(prev, ['win-a', 'win-b'], nameFor);
    expect(registry['win-a']).toEqual({ slot: 0, name: 'Backend' }); // untouched
    expect(registry['win-b'].slot).toBe(1);
    expect(changed).toBe(true);
  });

  it('frees a closed window’s slot and reuses it lowest-first', () => {
    const prev: RoomRegistry = {
      'win-a': { slot: 0, name: 'A' },
      'win-b': { slot: 1, name: 'B' },
    };
    // win-a closes, win-c opens — win-c takes the freed slot 0, win-b stays at 1.
    const { registry } = reconcileRooms(prev, ['win-b', 'win-c'], nameFor);
    expect(registry['win-b']).toEqual({ slot: 1, name: 'B' });
    expect(registry['win-c'].slot).toBe(0);
    expect(registry['win-a']).toBeUndefined();
  });

  it('reports unchanged when the same keys map to the same slots', () => {
    const prev: RoomRegistry = { 'win-a': { slot: 0, name: 'A' } };
    const { changed } = reconcileRooms(prev, ['win-a'], nameFor);
    expect(changed).toBe(false);
  });

  it('roomsInSlotOrder returns rooms sorted by slot', () => {
    const reg: RoomRegistry = {
      'win-b': { slot: 1, name: 'B' },
      'win-a': { slot: 0, name: 'A' },
      'win-c': { slot: 2, name: 'C' },
    };
    expect(roomsInSlotOrder(reg).map((r) => r.key)).toEqual(['win-a', 'win-b', 'win-c']);
  });
});
