import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ExecRunner,
  focusAgentTerminal,
  focusITerm2ByTty,
  ITERM2_FOCUS_SCRIPT,
  listLiveSessions,
  parseClaudeAgents,
  readSessionRegistry,
  resolvePidForSession,
  transcriptPathForSession,
  ttyDevicePath,
} from '../src/terminalFocus.js';

const AGENTS_JSON = JSON.stringify([
  { pid: 101, cwd: '/a', kind: 'interactive', sessionId: 'sess-a', name: 'a-1', status: 'idle' },
  { pid: 202, cwd: '/b', kind: 'interactive', sessionId: 'sess-b', name: 'b-2', status: 'busy' },
]);

/** Build an exec stub that answers by command name and records every call. */
function fakeExec(answers: Record<string, (args: string[]) => string | Error>): {
  exec: ExecRunner;
  calls: Array<[string, string[]]>;
} {
  const calls: Array<[string, string[]]> = [];
  const exec: ExecRunner = async (cmd, args) => {
    calls.push([cmd, args]);
    const answer = answers[cmd];
    if (!answer) throw new Error(`spawn ${cmd} ENOENT`);
    const out = answer(args);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { exec, calls };
}

describe('parseClaudeAgents', () => {
  it('keeps pid, sessionId, cwd, name, status and ignores unknown fields', () => {
    expect(parseClaudeAgents(AGENTS_JSON)).toEqual([
      { pid: 101, sessionId: 'sess-a', cwd: '/a', name: 'a-1', status: 'idle' },
      { pid: 202, sessionId: 'sess-b', cwd: '/b', name: 'b-2', status: 'busy' },
    ]);
  });

  it('leaves optional fields undefined when absent or wrong-typed', () => {
    expect(parseClaudeAgents('[{"pid":1,"sessionId":"s","cwd":5}]')).toEqual([
      { pid: 1, sessionId: 's', cwd: undefined, name: undefined, status: undefined },
    ]);
  });

  it('drops malformed entries and survives non-JSON / non-array input', () => {
    expect(parseClaudeAgents('[{"pid":"x","sessionId":"s"},{"pid":5},null,7]')).toEqual([]);
    expect(parseClaudeAgents('not json')).toEqual([]);
    expect(parseClaudeAgents('{"pid":1,"sessionId":"s"}')).toEqual([]);
  });
});

describe('listLiveSessions', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-live-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns registry entries whose pid is alive and filters out the dead', () => {
    fs.writeFileSync(
      path.join(dir, '101.json'),
      JSON.stringify({ pid: 101, sessionId: 'sess-a', cwd: '/a', name: 'a-1' }),
    );
    fs.writeFileSync(
      path.join(dir, '202.json'),
      JSON.stringify({ pid: 202, sessionId: 'sess-b', cwd: '/b', name: 'b-2' }),
    );
    const live = listLiveSessions({ sessionRegistryDir: dir, isAlive: (pid) => pid === 101 });
    expect(live).toEqual([
      { pid: 101, sessionId: 'sess-a', cwd: '/a', name: 'a-1', status: undefined },
    ]);
  });
});

describe('transcriptPathForSession', () => {
  it('follows Claude’s dashed-cwd convention under ~/.claude/projects', () => {
    expect(transcriptPathForSession('/Users/x/Proj', 'sess-a', '/home/x')).toBe(
      '/home/x/.claude/projects/-Users-x-Proj/sess-a.jsonl',
    );
  });
});

describe('readSessionRegistry', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-sessions-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads every <pid>.json file and skips unparseable ones and non-json files', () => {
    fs.writeFileSync(path.join(dir, '101.json'), JSON.stringify({ pid: 101, sessionId: 'sess-a' }));
    fs.writeFileSync(path.join(dir, '202.json'), '{ half-written');
    fs.writeFileSync(path.join(dir, '101.deadbeef.key'), 'secret');
    expect(readSessionRegistry(dir)).toEqual([{ pid: 101, sessionId: 'sess-a' }]);
  });

  it('returns [] for a missing directory', () => {
    expect(readSessionRegistry(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('resolvePidForSession', () => {
  it('asks `claude agents --json` first', async () => {
    const { exec, calls } = fakeExec({ claude: () => AGENTS_JSON });
    await expect(resolvePidForSession('sess-b', { exec })).resolves.toBe(202);
    expect(calls).toEqual([['claude', ['agents', '--json']]]);
  });

  it('falls back to the registry dir when `claude` is not on PATH', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-sessions-'));
    try {
      fs.writeFileSync(
        path.join(dir, '303.json'),
        JSON.stringify({ pid: 303, sessionId: 'sess-c' }),
      );
      const { exec } = fakeExec({});
      await expect(resolvePidForSession('sess-c', { exec, sessionRegistryDir: dir })).resolves.toBe(
        303,
      );
      await expect(
        resolvePidForSession('sess-zzz', { exec, sessionRegistryDir: dir }),
      ).resolves.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ttyDevicePath', () => {
  it('normalises ps output into a /dev path', () => {
    expect(ttyDevicePath('ttys005\n')).toBe('/dev/ttys005');
    expect(ttyDevicePath('  ttys012  ')).toBe('/dev/ttys012');
    expect(ttyDevicePath('/dev/ttys001')).toBe('/dev/ttys001');
  });

  it('returns null for processes without a controlling terminal', () => {
    expect(ttyDevicePath('??\n')).toBeNull();
    expect(ttyDevicePath('-')).toBeNull();
    expect(ttyDevicePath('')).toBeNull();
  });
});

describe('focusITerm2ByTty', () => {
  it('runs the AppleScript with the tty as argv[1] and reports ok', async () => {
    const { exec, calls } = fakeExec({ osascript: () => 'ok\n' });
    await expect(focusITerm2ByTty('/dev/ttys005', { exec })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([['osascript', ['-e', ITERM2_FOCUS_SCRIPT, '/dev/ttys005']]]);
  });

  it('reports not-found when no session owns the tty', async () => {
    const { exec } = fakeExec({ osascript: () => 'notfound\n' });
    const result = await focusITerm2ByTty('/dev/ttys005', { exec });
    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('reports error when osascript itself fails (iTerm2 missing, automation denied)', async () => {
    const { exec } = fakeExec({ osascript: () => new Error('execution error: -1743') });
    const result = await focusITerm2ByTty('/dev/ttys005', { exec });
    expect(result).toMatchObject({ ok: false, reason: 'error', detail: 'execution error: -1743' });
  });
});

describe('focusAgentTerminal (full chain)', () => {
  it('session → pid → tty → osascript', async () => {
    const { exec, calls } = fakeExec({
      claude: () => AGENTS_JSON,
      ps: (args) => (args.join(' ') === '-o tty= -p 202' ? 'ttys009\n' : '??\n'),
      osascript: (args) => (args[2] === '/dev/ttys009' ? 'ok' : 'notfound'),
    });
    await expect(focusAgentTerminal('sess-b', { exec, platform: 'darwin' })).resolves.toEqual({
      ok: true,
    });
    expect(calls.map(([cmd]) => cmd)).toEqual(['claude', 'ps', 'osascript']);
  });

  it('refuses off macOS without spawning anything', async () => {
    const { exec, calls } = fakeExec({ claude: () => AGENTS_JSON });
    const result = await focusAgentTerminal('sess-a', { exec, platform: 'linux' });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported-platform' });
    expect(calls).toEqual([]);
  });

  it('reports no-pid for a session that is not live', async () => {
    const { exec } = fakeExec({ claude: () => AGENTS_JSON });
    const result = await focusAgentTerminal('sess-gone', {
      exec,
      platform: 'darwin',
      sessionRegistryDir: path.join(os.tmpdir(), 'pxl-no-such-dir'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'no-pid' });
  });

  it('reports no-tty for a headless process', async () => {
    const { exec } = fakeExec({ claude: () => AGENTS_JSON, ps: () => '??\n' });
    const result = await focusAgentTerminal('sess-a', { exec, platform: 'darwin' });
    expect(result).toMatchObject({ ok: false, reason: 'no-tty' });
  });
});
