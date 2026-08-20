import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

/**
 * The standalone registry scanner (AgentRuntime.startRegistryScanning /
 * scanRegistryOnce) discovers every live Claude process from ~/.claude/sessions
 * regardless of transcript mtime, labels each character with the session's own
 * name, and reaps it when the pid leaves. These tests drive scanRegistryOnce by
 * hand (no timer) against a fixture home + registry dir + injected liveness.
 */
describe('AgentRuntime -- live-process registry scanning', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;
  let homeDir: string;
  let regDir: string;
  let alive: Set<number>;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-reg-home-'));
    regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-reg-sessions-'));
    alive = new Set<number>();

    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.setRegistryScanDeps({
      sessionRegistryDir: regDir,
      homeDir,
      isAlive: (pid) => alive.has(pid),
    });
  });

  afterEach(() => {
    runtime?.dispose();
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(regDir, { recursive: true, force: true });
  });

  /** A cwd guaranteed unique per test so its transcript dir can't collide with
   *  another test's fixture under the shared tmp root. */
  function uniqueCwd(): string {
    return path.join('/tmp/pxl-projects', crypto.randomUUID());
  }

  interface FixtureSession {
    pid: number;
    sessionId: string;
    cwd: string;
    name: string;
  }

  /** Write the per-pid registry file and (unless skipTranscript) a transcript. */
  function seedSession(s: FixtureSession, opts: { transcript?: boolean } = {}): void {
    fs.writeFileSync(path.join(regDir, `${s.pid}.json`), JSON.stringify({ ...s, status: 'idle' }));
    if (opts.transcript !== false) {
      const tdir = path.join(homeDir, '.claude', 'projects', normalizeProjectPath(s.cwd));
      fs.mkdirSync(tdir, { recursive: true });
      fs.writeFileSync(
        path.join(tdir, `${s.sessionId}.jsonl`),
        JSON.stringify({ type: 'summary' }) + '\n',
      );
    }
    alive.add(s.pid);
  }

  /** Map of session name → agent id currently in the store. */
  function agentsByName(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, agent] of store) {
      if (agent.folderName) out.set(agent.folderName, id);
    }
    return out;
  }

  it('adopts every live session and labels each character with its session name', () => {
    seedSession({ pid: 101, sessionId: crypto.randomUUID(), cwd: uniqueCwd(), name: 'medivet-c6' });
    seedSession({
      pid: 202,
      sessionId: crypto.randomUUID(),
      cwd: uniqueCwd(),
      name: 'kt-pr-review',
    });

    runtime.scanRegistryOnce();

    expect(store.size).toBe(2);
    expect([...agentsByName().keys()].sort()).toEqual(['kt-pr-review', 'medivet-c6']);
  });

  it('does not double-adopt across repeated scans', () => {
    seedSession({ pid: 101, sessionId: crypto.randomUUID(), cwd: uniqueCwd(), name: 'medivet-c6' });

    runtime.scanRegistryOnce();
    runtime.scanRegistryOnce();
    runtime.scanRegistryOnce();

    expect(store.size).toBe(1);
  });

  it('reaps a character when its pid leaves the registry', () => {
    const gone: FixtureSession = {
      pid: 101,
      sessionId: crypto.randomUUID(),
      cwd: uniqueCwd(),
      name: 'medivet-c6',
    };
    const stays: FixtureSession = {
      pid: 202,
      sessionId: crypto.randomUUID(),
      cwd: uniqueCwd(),
      name: 'kt-pr-review',
    };
    seedSession(gone);
    seedSession(stays);
    runtime.scanRegistryOnce();
    expect(store.size).toBe(2);

    // Process exits: registry file removed, pid no longer alive.
    fs.rmSync(path.join(regDir, `${gone.pid}.json`));
    alive.delete(gone.pid);
    runtime.scanRegistryOnce();

    expect(store.size).toBe(1);
    expect([...agentsByName().keys()]).toEqual(['kt-pr-review']);
  });

  it('drops a session whose pid is dead even while its registry file lingers', () => {
    const s: FixtureSession = {
      pid: 101,
      sessionId: crypto.randomUUID(),
      cwd: uniqueCwd(),
      name: 'crashed',
    };
    seedSession(s);
    alive.delete(s.pid); // file remains, but the process is gone

    runtime.scanRegistryOnce();

    expect(store.size).toBe(0);
  });

  it('waits for the transcript before adopting a just-started session', () => {
    const s: FixtureSession = {
      pid: 101,
      sessionId: crypto.randomUUID(),
      cwd: uniqueCwd(),
      name: 'fresh',
    };
    seedSession(s, { transcript: false });

    runtime.scanRegistryOnce();
    expect(store.size).toBe(0);

    // Transcript now exists — next scan adopts it.
    const tdir = path.join(homeDir, '.claude', 'projects', normalizeProjectPath(s.cwd));
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(
      path.join(tdir, `${s.sessionId}.jsonl`),
      JSON.stringify({ type: 'summary' }) + '\n',
    );

    runtime.scanRegistryOnce();
    expect(store.size).toBe(1);
    expect([...agentsByName().keys()]).toEqual(['fresh']);
  });
});
