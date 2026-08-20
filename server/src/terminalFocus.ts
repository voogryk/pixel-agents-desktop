/**
 * Standalone "click a character → jump to its terminal".
 *
 * The VS Code adapter holds a `vscode.Terminal` per agent and simply calls
 * `.show()`. Standalone has no terminal handle at all: the agent was adopted
 * from a transcript or a hook event, and all we know is its Claude session id.
 * The chain that gets us from there to a focused tab is:
 *
 *   session id ──► pid  (`claude agents --json`, falling back to the registry
 *                        files Claude Code keeps under ~/.claude/sessions/)
 *            pid ──► tty  (`ps -o tty= -p <pid>`)
 *            tty ──► tab  (iTerm2's AppleScript dictionary exposes `tty` on
 *                        every session, so one pass over windows/tabs/sessions
 *                        finds the match and `select` + `activate` raise it)
 *
 * macOS + iTerm2 only for now. Every step is local; nothing leaves the machine.
 * Each helper is exported and takes its process runner as a parameter so the
 * tests can drive the chain without spawning anything.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';

const execFileAsync = promisify(execFile);

/** Subprocess runner shape; the default wraps child_process.execFile. */
export type ExecRunner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: ExecRunner = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return { stdout };
};

/** One live Claude Code process, as reported by `claude agents --json` and by
 *  the per-pid registry files under ~/.claude/sessions/. `cwd`/`name`/`status`
 *  are present in the registry files (and the CLI output) but optional here so a
 *  caller that only needs pid→session mapping still type-checks. */
export interface ClaudeAgentEntry {
  pid: number;
  sessionId: string;
  /** Working directory the session was started in. Maps to its transcript dir. */
  cwd?: string;
  /** User/derived session name (e.g. "medivet-c6", "kt-pr-review"). */
  name?: string;
  /** Coarse activity as of the last registry write ("busy" | "idle" | …). */
  status?: string;
}

export type FocusFailure = 'unsupported-platform' | 'no-pid' | 'no-tty' | 'not-found' | 'error';

export type FocusResult = { ok: true } | { ok: false; reason: FocusFailure; detail?: string };

export interface TerminalFocusDeps {
  exec?: ExecRunner;
  platform?: NodeJS.Platform;
  /** Override for ~/.claude/sessions (tests). */
  sessionRegistryDir?: string;
}

// ── session id → pid ──────────────────────────────────────────

/** Parse `claude agents --json` output. Unknown fields are ignored; entries
 *  missing a numeric pid or string sessionId are dropped rather than thrown on,
 *  since the CLI's schema is not ours to pin. */
export function parseClaudeAgents(json: string): ClaudeAgentEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ClaudeAgentEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { pid, sessionId, cwd, name, status } = item as {
      pid?: unknown;
      sessionId?: unknown;
      cwd?: unknown;
      name?: unknown;
      status?: unknown;
    };
    if (typeof pid === 'number' && Number.isInteger(pid) && typeof sessionId === 'string') {
      out.push({
        pid,
        sessionId,
        cwd: typeof cwd === 'string' ? cwd : undefined,
        name: typeof name === 'string' ? name : undefined,
        status: typeof status === 'string' ? status : undefined,
      });
    }
  }
  return out;
}

/** Default location of Claude Code's live-session registry (`<pid>.json` files). */
export function defaultSessionRegistryDir(): string {
  return path.join(os.homedir(), '.claude', 'sessions');
}

/** Fallback when the `claude` binary is not on PATH (typical when the server was
 *  launched from a GUI/launchd environment): read the same data straight from
 *  the per-pid registry files. Files that fail to parse are skipped. */
export function readSessionRegistry(dir = defaultSessionRegistryDir()): ClaudeAgentEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ClaudeAgentEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      out.push(...parseClaudeAgents(`[${raw}]`));
    } catch {
      // unreadable / mid-write file: not our session, move on
    }
  }
  return out;
}

/** True if a process with this pid is alive. `kill(pid, 0)` sends no signal, it
 *  only probes: it throws ESRCH when the pid is gone and EPERM when the pid
 *  exists but we may not signal it — EPERM still means "alive", so only ESRCH
 *  counts as dead. Lets the scanner drop a stale `<pid>.json` a crashed session
 *  never cleaned up. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LiveSessionsDeps {
  /** Override for ~/.claude/sessions (tests). */
  sessionRegistryDir?: string;
  /** Liveness probe; defaults to isPidAlive. Injected in tests. */
  isAlive?: (pid: number) => boolean;
}

/**
 * All live Claude Code sessions on this machine, read straight from the per-pid
 * registry under ~/.claude/sessions/. Deliberately does NOT shell out to
 * `claude` — the registry files already carry pid/sessionId/cwd/name/status, so
 * discovery has no PATH dependency and spawns nothing. Entries whose pid is no
 * longer alive are dropped (a crashed session can leave its file behind).
 */
export function listLiveSessions(deps: LiveSessionsDeps = {}): ClaudeAgentEntry[] {
  const isAlive = deps.isAlive ?? isPidAlive;
  return readSessionRegistry(deps.sessionRegistryDir).filter((e) => isAlive(e.pid));
}

/** Absolute path of a session's transcript, following Claude's convention
 *  ~/.claude/projects/<cwd-with-non-alnum-dashed>/<sessionId>.jsonl. */
export function transcriptPathForSession(
  cwd: string,
  sessionId: string,
  homeDir = os.homedir(),
): string {
  return path.join(homeDir, '.claude', 'projects', normalizeProjectPath(cwd), `${sessionId}.jsonl`);
}

/** Resolve the OS pid of the Claude Code process that owns `sessionId`, or null. */
export async function resolvePidForSession(
  sessionId: string,
  deps: TerminalFocusDeps = {},
): Promise<number | null> {
  const exec = deps.exec ?? defaultExec;
  let entries: ClaudeAgentEntry[] = [];
  try {
    const { stdout } = await exec('claude', ['agents', '--json']);
    entries = parseClaudeAgents(stdout);
  } catch {
    // `claude` not on PATH or the command failed — fall through to the registry
  }
  let hit = entries.find((e) => e.sessionId === sessionId);
  if (!hit) {
    hit = readSessionRegistry(deps.sessionRegistryDir).find((e) => e.sessionId === sessionId);
  }
  return hit ? hit.pid : null;
}

// ── pid → tty ─────────────────────────────────────────────────

/** Turn `ps -o tty=` output ("ttys005", "  ttys005\n", "??") into a device path
 *  ("/dev/ttys005") or null when the process has no controlling terminal. */
export function ttyDevicePath(psOutput: string): string | null {
  const name = psOutput.trim();
  if (!name || name === '??' || name === '-') return null;
  return name.startsWith('/dev/') ? name : `/dev/${name}`;
}

export async function resolveTtyForPid(
  pid: number,
  deps: TerminalFocusDeps = {},
): Promise<string | null> {
  const exec = deps.exec ?? defaultExec;
  try {
    const { stdout } = await exec('ps', ['-o', 'tty=', '-p', String(pid)]);
    return ttyDevicePath(stdout);
  } catch {
    return null;
  }
}

// ── tty → iTerm2 tab ──────────────────────────────────────────

/** AppleScript that walks every iTerm2 window/tab/session, selects the one whose
 *  tty matches argv[1], raises its window and brings iTerm2 to the front.
 *  Prints "ok" on success and "notfound" when no session owns that tty. */
export const ITERM2_FOCUS_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is target then
            tell s to select
            tell t to select
            tell w to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

export async function focusITerm2ByTty(
  tty: string,
  deps: TerminalFocusDeps = {},
): Promise<FocusResult> {
  const exec = deps.exec ?? defaultExec;
  try {
    const { stdout } = await exec('osascript', ['-e', ITERM2_FOCUS_SCRIPT, tty]);
    return stdout.trim() === 'ok'
      ? { ok: true }
      : { ok: false, reason: 'not-found', detail: `no iTerm2 session on ${tty}` };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── the whole chain ───────────────────────────────────────────

/** Bring the terminal tab hosting Claude session `sessionId` to the front. */
export async function focusAgentTerminal(
  sessionId: string,
  deps: TerminalFocusDeps = {},
): Promise<FocusResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') {
    return { ok: false, reason: 'unsupported-platform', detail: platform };
  }
  const pid = await resolvePidForSession(sessionId, deps);
  if (pid === null) {
    return { ok: false, reason: 'no-pid', detail: `session ${sessionId.slice(0, 8)}… not live` };
  }
  const tty = await resolveTtyForPid(pid, deps);
  if (tty === null) {
    return { ok: false, reason: 'no-tty', detail: `pid ${pid} has no controlling tty` };
  }
  return focusITerm2ByTty(tty, deps);
}
