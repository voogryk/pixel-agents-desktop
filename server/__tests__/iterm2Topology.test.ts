import { describe, expect, it } from 'vitest';

import {
  ITERM2_TOPOLOGY_SCRIPT,
  parsePsTtys,
  parseTopology,
  placementsFrom,
  placeSessions,
  readTopology,
} from '../src/iterm2Topology.js';
import type { ExecRunner } from '../src/terminalFocus.js';

const TOPO_JSON = JSON.stringify([
  { tty: '/dev/ttys008', windowId: 77320, tabIndex: 1, paneIndex: 1 },
  { tty: '/dev/ttys002', windowId: 77320, tabIndex: 1, paneIndex: 2 },
  { tty: '/dev/ttys013', windowId: 79299, tabIndex: 1, paneIndex: 1 },
]);

function fakeExec(answers: Record<string, (args: string[]) => string | Error>): {
  exec: ExecRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const exec: ExecRunner = async (cmd, args) => {
    calls.push(cmd);
    const answer = answers[cmd];
    if (!answer) throw new Error(`spawn ${cmd} ENOENT`);
    const out = answer(args);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { exec, calls };
}

describe('parseTopology', () => {
  it('maps tty → {windowId, tabIndex, paneIndex}', () => {
    const map = parseTopology(TOPO_JSON);
    expect(map.get('/dev/ttys002')).toEqual({
      tty: '/dev/ttys002',
      windowId: 77320,
      tabIndex: 1,
      paneIndex: 2,
    });
    expect(map.size).toBe(3);
  });

  it('drops malformed entries and survives non-JSON', () => {
    expect(parseTopology('[{"tty":"x"},{"windowId":1}]').size).toBe(0);
    expect(parseTopology('not json').size).toBe(0);
  });
});

describe('parsePsTtys', () => {
  it('parses pid → tty-device and drops processes without a tty', () => {
    const map = parsePsTtys('25427 ttys002\n  10077 ttys001 \n99999 ??\n');
    expect(map.get(25427)).toBe('/dev/ttys002');
    expect(map.get(10077)).toBe('/dev/ttys001');
    expect(map.has(99999)).toBe(false);
  });
});

describe('placementsFrom', () => {
  const sessions = [
    { pid: 101, sessionId: 'sess-a', cwd: '/a', name: 'a' },
    { pid: 202, sessionId: 'sess-b', cwd: '/b', name: 'b' },
    { pid: 303, sessionId: 'sess-c', cwd: '/c', name: 'c' },
  ];

  it('joins session → pid → tty → pane; null window when tty is not an iTerm2 pane', () => {
    const pidTty = new Map([
      [101, '/dev/ttys008'],
      [202, '/dev/ttys999'], // alive tty, but not in iTerm2 (e.g. VS Code terminal)
      // 303 has no tty at all (headless)
    ]);
    const topo = parseTopology(TOPO_JSON);
    const placed = placementsFrom(sessions, pidTty, topo);

    expect(placed[0]).toMatchObject({ sessionId: 'sess-a', windowId: 77320, paneIndex: 1 });
    expect(placed[1]).toMatchObject({ sessionId: 'sess-b', windowId: null, paneIndex: null });
    expect(placed[2]).toMatchObject({ sessionId: 'sess-c', windowId: null, tabIndex: null });
  });
});

describe('readTopology', () => {
  it('returns empty off macOS without spawning osascript', async () => {
    const { exec, calls } = fakeExec({ osascript: () => TOPO_JSON });
    const map = await readTopology({ exec, platform: 'linux' });
    expect(map.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('runs the topology AppleScript on macOS', async () => {
    const { exec, calls } = fakeExec({
      osascript: (args) => (args[1] === ITERM2_TOPOLOGY_SCRIPT ? TOPO_JSON : '[]'),
    });
    const map = await readTopology({ exec, platform: 'darwin' });
    expect(map.size).toBe(3);
    expect(calls).toEqual(['osascript']);
  });
});

describe('placeSessions (full chain)', () => {
  it('batches one ps call for all pids, then joins against the topology', async () => {
    const { exec, calls } = fakeExec({
      ps: (args) => {
        expect(args).toEqual(['-o', 'pid=,tty=', '-p', '101,202']);
        return '101 ttys008\n202 ttys013\n';
      },
      osascript: () => TOPO_JSON,
    });
    const placed = await placeSessions(
      [
        { pid: 101, sessionId: 'sess-a', cwd: '/a', name: 'a' },
        { pid: 202, sessionId: 'sess-b', cwd: '/b', name: 'b' },
      ],
      { exec, platform: 'darwin' },
    );
    expect(placed).toEqual([
      { sessionId: 'sess-a', name: 'a', cwd: '/a', windowId: 77320, tabIndex: 1, paneIndex: 1 },
      { sessionId: 'sess-b', name: 'b', cwd: '/b', windowId: 79299, tabIndex: 1, paneIndex: 1 },
    ]);
    expect(calls).toEqual(['ps', 'osascript']);
  });
});
