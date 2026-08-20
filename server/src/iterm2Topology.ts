/**
 * iTerm2 window/tab/pane topology → session placement.
 *
 * The office wants "one room per iTerm2 window": sessions sharing a window are
 * roommates, sessions sharing a tab are split panes side by side. iTerm2's
 * AppleScript dictionary exposes, for every session, the window it belongs to
 * (`id of w`, stable across the window's life), its tab position, and its split
 * position within the tab. We read that, map each live Claude session to its
 * window by tty, and hand the runtime a placement per session.
 *
 * Chain: session → pid (registry) → tty (`ps`) → {windowId, tabIndex, paneIndex}
 * (AppleScript). macOS + iTerm2 only; every step is local.
 */

import {
  type ClaudeAgentEntry,
  defaultExec,
  type ExecRunner,
  ttyDevicePath,
} from './terminalFocus.js';

/** One session's position in the iTerm2 tree, keyed by its tty. */
export interface PaneLocation {
  tty: string;
  /** iTerm2 window id — stable for the window's lifetime; the room key. */
  windowId: number;
  /** 1-based tab position within the window. */
  tabIndex: number;
  /** 1-based split-pane position within the tab. */
  paneIndex: number;
}

/** A live Claude session placed in the iTerm2 tree. windowId is null when the
 *  session's terminal is not an iTerm2 pane (VS Code terminal, tmux, plain
 *  Terminal.app) — those fall to the catch-all room. */
export interface SessionPlacement {
  sessionId: string;
  name?: string;
  cwd?: string;
  windowId: number | null;
  tabIndex: number | null;
  paneIndex: number | null;
}

export interface TopologyDeps {
  exec?: ExecRunner;
  platform?: NodeJS.Platform;
}

/** AppleScript that emits the whole window→tab→session tree as a JSON array of
 *  PaneLocation. Kept as a single string so it ships in the bundle verbatim. */
export const ITERM2_TOPOLOGY_SCRIPT = `tell application "iTerm2"
  set out to "["
  set firstItem to true
  repeat with w in windows
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      set si to 0
      repeat with s in sessions of t
        set si to si + 1
        if firstItem then
          set firstItem to false
        else
          set out to out & ","
        end if
        set out to out & "{\\"tty\\":\\"" & (tty of s) & "\\",\\"windowId\\":" & (id of w) & ",\\"tabIndex\\":" & ti & ",\\"paneIndex\\":" & si & "}"
      end repeat
    end repeat
  end repeat
  set out to out & "]"
  return out
end tell`;

/** Parse the topology AppleScript's JSON into a tty → PaneLocation map. Entries
 *  missing a numeric window/tab/pane or a tty are dropped; malformed JSON yields
 *  an empty map rather than throwing (the tree is not ours to pin). */
export function parseTopology(json: string): Map<string, PaneLocation> {
  const map = new Map<string, PaneLocation>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return map;
  }
  if (!Array.isArray(parsed)) return map;
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { tty, windowId, tabIndex, paneIndex } = item as Record<string, unknown>;
    if (
      typeof tty === 'string' &&
      typeof windowId === 'number' &&
      typeof tabIndex === 'number' &&
      typeof paneIndex === 'number'
    ) {
      map.set(tty, { tty, windowId, tabIndex, paneIndex });
    }
  }
  return map;
}

/** Parse `ps -o pid=,tty=` output into a pid → tty-device map. Lines look like
 *  "25427 ttys002"; a process with no controlling terminal ("??") is omitted. */
export function parsePsTtys(psOutput: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp < 0) continue;
    const pid = Number(trimmed.slice(0, sp));
    if (!Number.isInteger(pid)) continue;
    const dev = ttyDevicePath(trimmed.slice(sp + 1));
    if (dev) map.set(pid, dev);
  }
  return map;
}

/** tty for each pid, in one `ps` call. Empty map for an empty pid list. */
export async function ttysForPids(
  pids: number[],
  deps: TopologyDeps = {},
): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  const exec = deps.exec ?? defaultExec;
  try {
    const { stdout } = await exec('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')]);
    return parsePsTtys(stdout);
  } catch {
    return new Map();
  }
}

/** Read the current iTerm2 topology (tty → PaneLocation). Empty off macOS or
 *  when AppleScript fails (iTerm2 not running, automation not permitted). */
export async function readTopology(deps: TopologyDeps = {}): Promise<Map<string, PaneLocation>> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return new Map();
  const exec = deps.exec ?? defaultExec;
  try {
    const { stdout } = await exec('osascript', ['-e', ITERM2_TOPOLOGY_SCRIPT]);
    return parseTopology(stdout);
  } catch {
    return new Map();
  }
}

/**
 * Place each live session in the iTerm2 tree. Sessions whose tty is not an
 * iTerm2 pane (or when topology can't be read) get windowId null — the runtime
 * routes those to the catch-all room. Pure joining is delegated to
 * placementsFrom so the spawns can be stubbed in tests.
 */
export async function placeSessions(
  sessions: ClaudeAgentEntry[],
  deps: TopologyDeps = {},
): Promise<SessionPlacement[]> {
  const pidTty = await ttysForPids(
    sessions.map((s) => s.pid),
    deps,
  );
  const topology = await readTopology(deps);
  return placementsFrom(sessions, pidTty, topology);
}

/** Pure join of sessions + pid→tty + tty→pane into placements. */
export function placementsFrom(
  sessions: ClaudeAgentEntry[],
  pidTty: Map<number, string>,
  topology: Map<string, PaneLocation>,
): SessionPlacement[] {
  return sessions.map((s) => {
    const tty = pidTty.get(s.pid);
    const pane = tty ? topology.get(tty) : undefined;
    return {
      sessionId: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      windowId: pane?.windowId ?? null,
      tabIndex: pane?.tabIndex ?? null,
      paneIndex: pane?.paneIndex ?? null,
    };
  });
}
