/**
 * AgentRuntime: shared agent lifecycle core for VS Code and standalone modes.
 *
 * Owns all infrastructure that both PixelAgentsViewProvider (VS Code) and the
 * standalone CLI need: timer Maps, file watchers, HookEventHandler, DismissalTracker,
 * session scanning, and agent removal. Adapters (VS Code, CLI) create an instance
 * and register platform-specific lifecycle callbacks.
 *
 * This is the single source of truth for agent lifecycle wiring. No duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { RoomInfoEntry } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { getRoomRegistry, setRoomRegistry } from './configPersistence.js';
import { DEFAULT_MAX_CONTEXT_TOKENS, REGISTRY_SCAN_INTERVAL_MS } from './constants.js';
import { DismissalTracker } from './dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  ensureProjectScan,
  isTrackedProjectDir,
  reassignAgentToFile,
  scanForBackgroundAgentFiles,
  scanForTeammateFiles,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
  setSubagentWatch,
  setTeammateRegisterCallback,
  setTeammateRemovalCallback,
  setTeamProvider,
  startExternalSessionScanning,
  startFileWatching,
  startStaleExternalAgentCheck,
} from './fileWatcher.js';
import type { HookEvent } from './hookEventHandler.js';
import { HookEventHandler } from './hookEventHandler.js';
import { placeSessions, type SessionPlacement, type TopologyDeps } from './iterm2Topology.js';
import { type GeneratedLayout, generateOfficeLayout } from './officeRoomLayout.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { PathSet, pathsMatch } from './pathKey.js';
import { reconcileRooms, type RoomRegistry, roomsInSlotOrder } from './roomRegistry.js';
import { SessionRouter } from './sessionRouter.js';
import { SubagentWatch } from './subagentWatch.js';
import {
  listLiveSessions,
  type LiveSessionsDeps,
  transcriptPathForSession,
} from './terminalFocus.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import {
  setBackgroundAgentCompletedCallback,
  setBackgroundAgentDetectedCallback,
  setHookProvider,
  setTeamSwitchCallback,
} from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Callbacks that adapters register for platform-specific behavior. */
export interface RuntimeLifecycleCallbacks {
  /** Called after an agent is removed. Adapters use this to dismiss JSONL files, etc. */
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
  /** Called when a teammate is removed. */
  onTeammateRemoved?: (teammateId: number, agent: AgentState, source: string) => void;
}

export class AgentRuntime {
  // Per-agent timer Maps (shared by all fileWatcher/hookEventHandler operations)
  readonly fileWatchers = new Map<number, fs.FSWatcher>();
  readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  // Scanning state. PathSet (not Set) so a transcript adopted via hooks is still
  // recognized as known when a scanner rebuilds the path from the workspace folder
  // -- the two spellings differ by drive-letter case on Windows.
  readonly knownJsonlFiles = new PathSet();
  readonly projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  readonly activeAgentId = { current: null as number | null };
  private externalScanTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private registryScanTimer: ReturnType<typeof setInterval> | null = null;
  /** sessionId → agentId for agents this runtime adopted from the live-process
   *  registry. Only these are removed when their pid leaves the registry; agents
   *  adopted by hooks or the workspace scanner are left to their own lifecycles. */
  private readonly registrySessions = new Map<string, number>();

  // ── Room-per-window state (standalone) ──
  private roomScanTimer: ReturnType<typeof setInterval> | null = null;
  private roomScanInFlight = false;
  private topologyDeps: TopologyDeps = {};
  /** Window-key → {slot, name}. Loaded from config on start, persisted on change. */
  private roomRegistry: RoomRegistry = {};
  /** sessionId → its room's area label, recomputed each topology scan. Read by
   *  scanRegistryOnce so a freshly-adopted agent gets its room on first render. */
  private readonly sessionRoom = new Map<string, string>();
  /** The office layout generated from the current rooms; null until first scan. */
  private roomLayout: GeneratedLayout | null = null;
  private roomsInfo: RoomInfoEntry[] = [];

  // Configuration refs (mutable, shared with scanners)
  readonly watchAllSessions = { current: false };
  readonly hooksEnabled = { current: true };

  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  /** Shadow-store watcher for unnamed background spawns (sub-agents). */
  readonly subagentWatch: SubagentWatch;
  private hookEventHandler: HookEventHandler;
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};

  constructor(
    private readonly store: AgentStateStore,
    provider: HookProvider,
  ) {
    // Wire module-level dependencies
    setDismissalTracker(this.dismissalTracker);
    setHookProvider(provider);
    setFileWatcherHookProvider(provider);
    this.subagentWatch = new SubagentWatch(store);
    setSubagentWatch(this.subagentWatch);
    if (provider.team) {
      setTeamProvider(provider.team);
    }
    setAgentRemovalCallback((id) => this.removeAgent(id));
    setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));
    // New-style teammates run their own sessions; registering routes their hook
    // events (PreToolUse, Stop, SessionEnd) directly to the teammate agent.
    setTeammateRegisterCallback((sessionId, agentId) => this.registerAgent(sessionId, agentId));
    // Background spawns (teams OFF): classify by sidecar name on spawn (named
    // -> teammate character, unnamed -> shadow-watched sub-agent), remove when
    // the completion queue-operation lands on the lead.
    setBackgroundAgentDetectedCallback((leadId) => {
      scanForBackgroundAgentFiles(
        leadId,
        this.store,
        this.store.nextAgentId,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        () => this.store.persist(),
        undefined,
      );
    });
    setBackgroundAgentCompletedCallback((leadId, toolUseId) => {
      for (const [id, agent] of this.store) {
        if (agent.leadAgentId === leadId && agent.spawnToolUseId === toolUseId) {
          this.removeTeammate(id, 'background-complete');
          break;
        }
      }
      // Unnamed spawns live in the shadow store; the webview sub-character is
      // cleared by the lead-side queue-op subagentClear, not by this call.
      this.subagentWatch.removeBySpawn(leadId, toolUseId);
    });
    // A resumed lead that spawns again belongs to a freshly minted implicit
    // team; its previous team's teammates are defunct. Promoted anonymous
    // background agents (leadAgentId but no teamName) are left untouched.
    setTeamSwitchCallback((leadId, previousTeamName) => {
      const stale = [...this.store].filter(
        ([, a]) => a.leadAgentId === leadId && a.teamName === previousTeamName,
      );
      for (const [id] of stale) {
        this.removeTeammate(id, 'team-switch');
      }
    });

    this.hookEventHandler = new HookEventHandler(
      store,
      this.waitingTimers,
      this.permissionTimers,
      provider,
      new SessionRouter(),
      this.watchAllSessions,
    );

    // Wire hook lifecycle callbacks to shared agent operations
    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd) => {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        // Teammate session of a tracked lead? Attach it as a teammate character
        // instead of adopting a generic external agent -- and regardless of the
        // Watch All Sessions setting: tracking the lead is the opt-in for its
        // team. (Newer harnesses run every spawned agent as an independent
        // top-level session that fires its own hooks.)
        if (transcriptPath) {
          const teamMeta = provider.team?.getTeamMetadataForSession(transcriptPath);
          if (teamMeta?.teamName && teamMeta.agentName) {
            for (const [leadId, lead] of this.store) {
              if (lead.teamName !== teamMeta.teamName || lead.leadAgentId !== undefined) continue;
              console.log(
                `[Pixel Agents] Hook: session ${sessionId.slice(0, 8)}... is teammate "${teamMeta.agentName}" of Agent ${leadId}, attaching`,
              );
              scanForTeammateFiles(
                lead.projectDir,
                lead.sessionId,
                leadId,
                this.store.nextAgentId,
                this.store,
                this.fileWatchers,
                this.pollingTimers,
                this.waitingTimers,
                this.permissionTimers,
                () => this.store.persist(),
                undefined,
              );
              break;
            }
            // Done only if discovery actually adopted this transcript. Old-style
            // tmux teammates (non-UUID transcript names outside discovery's scan)
            // fall through to normal external adoption and self-identify from
            // their record tags.
            for (const a of this.store.values()) {
              if (pathsMatch(a.jsonlFile, transcriptPath)) return;
            }
          }
        }
        if (!isTrackedProjectDir(projectDir) && !this.watchAllSessions.current) {
          console.log(
            `[Pixel Agents] Hook: external session ${sessionId.slice(0, 8)}... not adopted ` +
              `(project untracked, Watch All Sessions off)`,
          );
          return;
        }
        adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          this.knownJsonlFiles,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          (agent) => this.registerAgent(agent.sessionId, agent.id),
        );
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        if (newTranscriptPath) {
          this.knownJsonlFiles.add(newTranscriptPath);
          reassignAgentToFile(
            agentId,
            newTranscriptPath,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.unregisterAgent(agent.sessionId);
          agent.sessionId = newSessionId;
          this.registerAgent(agent.sessionId, agent.id);
        }
      },
      onSessionResume: (transcriptPath) => {
        this.dismissalTracker.clearDismissal(transcriptPath);
        this.dismissalTracker.clearSeededMtime(transcriptPath);
        this.knownJsonlFiles.delete(transcriptPath);
      },
      onTeammateDetected: (parentAgentId, sessionId, _agentType) => {
        const parentAgent = this.store.get(parentAgentId);
        if (!parentAgent) return;
        scanForTeammateFiles(
          parentAgent.projectDir,
          sessionId,
          parentAgentId,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          // Don't register inline teammates: they share the lead's sessionId
          // and registering them would overwrite the lead in the session router.
          undefined,
        );
      },
      onTeammateRemoved: (teammateAgentId) => {
        this.removeTeammate(teammateAgentId, 'hooks');
      },
      onSessionEnd: (agentId) => {
        const agent = this.store.get(agentId);
        if (!agent) return;
        this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        // Covers real team leads AND leads of background teammates (which
        // have children but no teamName). No-op when childless.
        this.removeTeammates(agentId);
        // Unnamed background spawns die with their lead's session too.
        this.subagentWatch.removeByLead(agentId);
        if (agent.isExternal) {
          this.unregisterAgent(agent.sessionId);
          this.removeAgent(agentId);
        }
      },
    });
  }

  /** Register adapter-specific lifecycle callbacks. */
  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  // ── Hook event routing ──

  /** Route an incoming hook event to the appropriate agent. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    this.hookEventHandler.handleEvent(providerId, event as HookEvent);
  }

  /** Register an agent with the hook event handler for session->agent mapping. */
  registerAgent(sessionId: string, agentId: number): void {
    this.hookEventHandler.registerAgent(sessionId, agentId);
  }

  /** Unregister an agent from the hook event handler. */
  unregisterAgent(sessionId: string): void {
    this.hookEventHandler.unregisterAgent(sessionId);
  }

  // ── Agent removal (shared cleanup) ──

  /** Remove an agent: stop watchers, cancel timers, delete from store. */
  removeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;

    // Stop JSONL poll timer
    const jpTimer = this.jsonlPollTimers.get(id);
    if (jpTimer) {
      clearInterval(jpTimer);
    }
    this.jsonlPollTimers.delete(id);

    // Stop file watching
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) {
      clearInterval(pt);
    }
    this.pollingTimers.delete(id);

    // Cancel timers
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);

    // Notify adapter before deleting from store
    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    // Remove from store (fires agentRemoved event) and persist
    this.store.delete(id);
    this.store.persist();
  }

  /** Remove a single teammate agent. */
  removeTeammate(teammateId: number, source: string): void {
    const agent = this.store.get(teammateId);
    if (!agent) return;
    console.log(`[Pixel Agents] Removing teammate ${teammateId} (source: ${source})`);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    // Background teammates (spawnToolUseId set) share the LEAD's session id;
    // unregistering it would knock the lead itself out of the session router.
    if (!agent.spawnToolUseId) {
      this.unregisterAgent(agent.sessionId);
    }
    this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
    this.removeAgent(teammateId);
    if (agent.leadAgentId !== undefined) {
      this.demoteLeadIfTeamEmpty(agent.leadAgentId);
    }
  }

  /** Drop the LEAD badge when the last teammate leaves. teamName is kept: it
   *  still routes discovery of late-arriving teammates of the same generation
   *  (and linkTeammates / the derived-team path re-badge on the next spawn). */
  private demoteLeadIfTeamEmpty(leadId: number): void {
    const lead = this.store.get(leadId);
    if (!lead || !lead.isTeamLead) return;
    for (const a of this.store.values()) {
      if (a.leadAgentId === leadId) return;
    }
    lead.isTeamLead = undefined;
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: leadId,
      teamName: lead.teamName,
      agentName: lead.agentName,
      isTeamLead: undefined,
      leadAgentId: lead.leadAgentId,
    });
    this.store.persist();
  }

  /** Remove all teammates of a lead agent. */
  removeTeammates(leadId: number): void {
    const teammates: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId === leadId) {
        teammates.push(id);
      }
    }
    for (const id of teammates) {
      const agent = this.store.get(id);
      if (agent) {
        console.log(`[Pixel Agents] Removing teammate ${id} (lead ${leadId} closed)`);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        if (!agent.spawnToolUseId) {
          this.unregisterAgent(agent.sessionId);
        }
        this.removeAgent(id);
      }
    }
  }

  // ── Scanning ──

  /** Start project-level scanning for a directory. */
  startProjectScan(projectDir: string, onAgentCreated?: (agent: AgentState) => void): void {
    ensureProjectScan(
      projectDir,
      this.knownJsonlFiles,
      this.projectScanTimer,
      this.activeAgentId,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      onAgentCreated ?? ((agent) => this.registerAgent(agent.sessionId, agent.id)),
      this.hooksEnabled,
    );
  }

  /** Start external session scanning (detects sessions from other terminals). */
  startExternalScanning(projectDir: string): void {
    if (this.externalScanTimer) return;

    this.externalScanTimer = startExternalSessionScanning(
      projectDir,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => this.store.persist(),
      this.watchAllSessions,
      this.hooksEnabled,
    );
  }

  /** Start stale external agent check (removes agents whose JSONL files are deleted). */
  startStaleCheck(): void {
    if (this.staleCheckTimer) return;

    this.staleCheckTimer = startStaleExternalAgentCheck(
      this.store,
      this.knownJsonlFiles,
      this.hooksEnabled,
    );
  }

  // ── Live-process registry scanning (standalone) ──
  //
  // The workspace + global scanners adopt a session only while its transcript
  // is recently modified (GLOBAL_SCAN_ACTIVE_MAX_AGE_MS), so an idle Claude
  // sitting untouched for 20 minutes has no character. This scanner instead
  // treats "the OS process is alive" as the liveness signal: it reads the
  // per-pid registry (~/.claude/sessions/), adopts every live session across
  // every project regardless of transcript mtime, labels each character with the
  // session's own name, and removes the character when the pid leaves.

  /** Deps for the registry read (test injection: fixture dir + fake liveness +
   *  fixture home for transcript paths). */
  private registryScanDeps: LiveSessionsDeps & { homeDir?: string } = {};

  setRegistryScanDeps(deps: LiveSessionsDeps & { homeDir?: string }): void {
    this.registryScanDeps = deps;
  }

  /** Start periodic discovery of every live Claude process on the machine. */
  startRegistryScanning(): void {
    if (this.registryScanTimer) return;
    // Prime immediately so the office is populated on connect, not one tick late.
    this.scanRegistryOnce();
    this.registryScanTimer = setInterval(() => this.scanRegistryOnce(), REGISTRY_SCAN_INTERVAL_MS);
  }

  /** One registry pass: adopt appeared sessions, drop vanished ones. Exposed for
   *  tests so a pass can be driven deterministically without the timer. */
  scanRegistryOnce(): void {
    const live = listLiveSessions(this.registryScanDeps);
    const liveIds = new Set(live.map((s) => s.sessionId));

    for (const session of live) {
      if (this.findAgentIdBySession(session.sessionId) !== null) continue;
      if (!session.cwd) continue;
      const transcript = transcriptPathForSession(
        session.cwd,
        session.sessionId,
        this.registryScanDeps.homeDir,
      );
      // A just-started session may have no transcript yet — adopt it next tick.
      if (!fs.existsSync(transcript)) continue;

      adoptExternalSessionFromHook(
        session.sessionId,
        transcript,
        session.cwd,
        this.knownJsonlFiles,
        this.store.nextAgentId,
        this.store,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        () => this.store.persist(),
        undefined,
        session.name,
        this.sessionRoom.get(session.sessionId),
      );

      const adoptedId = this.findAgentIdBySession(session.sessionId);
      if (adoptedId !== null) this.registrySessions.set(session.sessionId, adoptedId);
    }

    // Reap: a tracked session whose pid is gone (or whose agent was already
    // removed elsewhere) leaves the office and our map.
    for (const [sessionId, agentId] of [...this.registrySessions]) {
      const alive = liveIds.has(sessionId) && this.store.get(agentId) !== undefined;
      if (alive) continue;
      if (this.store.get(agentId) !== undefined) this.removeAgent(agentId);
      this.registrySessions.delete(sessionId);
    }
  }

  /** Agent id whose session matches, or null. */
  private findAgentIdBySession(sessionId: string): number | null {
    for (const [id, agent] of this.store) {
      if (agent.sessionId === sessionId) return id;
    }
    return null;
  }

  // ── Room-per-window orchestration (standalone) ──

  /** The generated office layout (null until the first room scan). */
  getRoomLayout(): GeneratedLayout | null {
    return this.roomLayout;
  }

  /** Current rooms + names, for the roomsInfo message. */
  getRoomsInfo(): RoomInfoEntry[] {
    return this.roomsInfo;
  }

  /** Inject topology/liveness deps (tests). */
  setTopologyDeps(deps: TopologyDeps): void {
    this.topologyDeps = deps;
  }

  /**
   * Start room-per-window scanning. Each tick reads the live sessions + iTerm2
   * topology, (re)generates the office layout, and adopts/labels agents into
   * their window's room. Loads the persisted room registry first so names
   * survive restarts.
   */
  startRoomScanning(): void {
    if (this.roomScanTimer) return;
    this.roomRegistry = getRoomRegistry();
    void this.syncStandalone();
    this.roomScanTimer = setInterval(() => void this.syncStandalone(), REGISTRY_SCAN_INTERVAL_MS);
  }

  /** The room area label for a placement: its iTerm2 window, or the catch-all. */
  private static roomKeyFor(p: SessionPlacement): string {
    return p.windowId !== null ? `win-${p.windowId}` : 'other';
  }

  /**
   * One standalone pass: topology → rooms → layout → agents. Reentrancy-guarded
   * because the topology read is async and ticks could otherwise overlap.
   */
  async syncStandalone(): Promise<void> {
    if (this.roomScanInFlight) return;
    this.roomScanInFlight = true;
    try {
      const live = listLiveSessions(this.registryScanDeps);
      const placements = await placeSessions(live, this.topologyDeps);

      // Group sessions by room key, preserving first-seen order for naming.
      const byRoom = new Map<string, SessionPlacement[]>();
      for (const p of placements) {
        const key = AgentRuntime.roomKeyFor(p);
        const list = byRoom.get(key) ?? [];
        list.push(p);
        byRoom.set(key, list);
      }

      // Reconcile stable slots; a new room is named after its first session
      // (or "Other" for the catch-all), then renamable.
      const activeKeys = [...byRoom.keys()];
      const nameFor = (key: string): string => {
        if (key === 'other') return 'Other';
        const first = byRoom.get(key)?.[0];
        return first?.name || key;
      };
      const { registry, changed } = reconcileRooms(this.roomRegistry, activeKeys, nameFor);
      this.roomRegistry = registry;
      setRoomRegistry(registry);

      // sessionId → room label, for scanRegistryOnce's adopt-time labeling.
      this.sessionRoom.clear();
      for (const p of placements) {
        this.sessionRoom.set(p.sessionId, AgentRuntime.roomKeyFor(p));
      }

      // Regenerate + broadcast the layout only when the room set/slots moved.
      const ordered = roomsInSlotOrder(registry);
      if (changed || !this.roomLayout) {
        const specs = ordered.map(({ key }) => ({
          label: key,
          capacity: byRoom.get(key)?.length ?? 1,
        }));
        const generated = generateOfficeLayout(specs);
        this.roomLayout = generated.layout;
        this.roomsInfo = generated.rooms.map((box) => ({
          label: box.label,
          name: registry[box.label]?.name ?? box.label,
          centerCol: box.centerCol,
          centerRow: box.centerRow,
        }));
        this.store.broadcast({ type: 'layoutLoaded', layout: this.roomLayout });
        this.broadcastRoomsInfo();
      }

      // Adopt appeared sessions / reap gone ones (uses sessionRoom for labels).
      this.scanRegistryOnce();

      // Reconcile room labels of already-adopted agents (e.g. a pane dragged to
      // another window) and broadcast the move.
      for (const p of placements) {
        const id = this.findAgentIdBySession(p.sessionId);
        if (id === null) continue;
        const agent = this.store.get(id);
        const desired = AgentRuntime.roomKeyFor(p);
        if (agent && agent.roomLabel !== desired) {
          agent.roomLabel = desired;
          this.store.broadcast({ type: 'agentRoom', id, roomLabel: desired });
        }
      }
    } finally {
      this.roomScanInFlight = false;
    }
  }

  /** Rename a room by its area label; persists and re-broadcasts roomsInfo. */
  renameRoom(label: string, name: string): void {
    const entry = this.roomRegistry[label];
    if (!entry) return;
    entry.name = name;
    setRoomRegistry(this.roomRegistry);
    this.roomsInfo = this.roomsInfo.map((r) => (r.label === label ? { ...r, name } : r));
    this.broadcastRoomsInfo();
  }

  private broadcastRoomsInfo(): void {
    this.store.broadcast({ type: 'roomsInfo', rooms: this.roomsInfo });
  }

  // ── Restore persisted external agents (standalone) ──

  /**
   * Re-create external agents from the adapter's persistence on startup.
   * Only external agents are restorable here (no terminal to rebind).
   * VS Code uses its own restoreAgents() in agentManager.ts to also handle
   * terminal agents via vscode.window.terminals.
   */
  restoreExternalAgents(): void {
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents();
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      // Background-spawn children (a leadAgentId but no teamName) are derived
      // state: the 1s scan re-materializes them from sidecars while their spawn
      // is live. Restoring them directly would resurrect immortal characters
      // (also skips stale entries written by older builds that persisted them).
      if (p.leadAgentId !== undefined && !p.teamName) continue;
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
      if (this.store.has(p.id)) {
        this.knownJsonlFiles.add(p.jsonlFile);
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      const agent: AgentState = {
        id: p.id,
        sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
        terminalRef: undefined,
        isExternal: true,
        projectDir: p.projectDir,
        jsonlFile: p.jsonlFile,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        // Live spawn ids survive the restart so the 1s scan can re-adopt the
        // spawns' transcripts and the completion queue-op still matches.
        backgroundAgentToolIds: new Set(p.backgroundAgentToolIds ?? []),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        lastDataAt: 0,
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        folderName: p.folderName,
        hookDelivered: false,
        contextTokens: 0,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        teamName: p.teamName,
        agentName: p.agentName,
        isTeamLead: p.isTeamLead,
        leadAgentId: p.leadAgentId,
        teamUsesTmux: p.teamUsesTmux,
        palette: p.palette,
        hueShift: p.hueShift,
      };

      assignPaletteIfNeeded(agent, this.store);
      this.store.set(p.id, agent);
      this.knownJsonlFiles.add(p.jsonlFile);

      try {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
        );
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[Pixel Agents] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  // ── Cleanup ──

  /** Clean up all scanners, timers, and agents. Called on shutdown. */
  dispose(): void {
    this.hookEventHandler.dispose();
    this.subagentWatch.dispose();

    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
    if (this.externalScanTimer) {
      clearInterval(this.externalScanTimer);
      this.externalScanTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    if (this.registryScanTimer) {
      clearInterval(this.registryScanTimer);
      this.registryScanTimer = null;
    }
    if (this.roomScanTimer) {
      clearInterval(this.roomScanTimer);
      this.roomScanTimer = null;
    }
    this.registrySessions.clear();
    this.sessionRoom.clear();

    for (const id of [...this.store.keys()]) {
      this.removeAgent(id);
    }
  }
}
