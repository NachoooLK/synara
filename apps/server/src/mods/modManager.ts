import { ModPullRequestPins } from "./modPullRequestPins";
import { ModPullRequestSources } from "./modPullRequestSources";
// FILE: modManager.ts
// Purpose: Owns every mod: finds them, starts the enabled ones, reloads them when
//          their files change, runs hook chains and answers their `$` calls.
// Layer: Mods runtime (plain promises; the ModHost layer adapts it to Effect and RPC)

import { randomUUID } from "node:crypto";
import { type FSWatcher, promises as fs, watch } from "node:fs";
import * as path from "node:path";

import {
  MOD_BUNDLE_FILE_SUFFIX,
  MOD_UI_ELEMENTS,
  ModCommandName,
  ModId,
  ModToastTone,
  ModViewId,
  ModViewRefreshSource,
  ModViewSite,
  ThreadId,
  type ModCommand,
  type ModAgentToolSummary,
  type ModLogEntry,
  type ModLogLevel,
  type ModMcpServerConfig,
  type ModPermission,
  type ModsDispatchUiResult,
  type ModsExportResult,
  type ModsImportResult,
  type ModsReadLogsResult,
  type ModsRenderViewResult,
  type ModsRunCommandResult,
  type ModsSnapshot,
  type ModsStreamEvent,
  type ModStatus,
  type ModSummary,
  type ModUiEffect,
  type ModView,
  type ModViewContext,
} from "@synara/contracts";
import { Schema } from "effect";

import type { ModProject, ModThread } from "./modApi.ts";
import { hashModFolder, packModFolder, readModBundle, writeModFiles } from "./modBundle.ts";
import { listModFolders, readModDefinition, type ModDefinition } from "./modDiscovery.ts";
import { ModWorkerHost, resolveModWorkerUrl } from "./modWorkerHost.ts";
import { normalizeModUiTree } from "./modUiTree.ts";
import { ModMcpClient } from "./modMcpClient.ts";
import { makeMemoryModSecretVault, ModMcpSignIns, type ModSecretVault } from "./modMcpSignIn.ts";

const MOD_LOG_LIMIT = 200;
const MOD_LOG_TEXT_LIMIT = 4_000;
const MOD_TOAST_TEXT_LIMIT = 2_000;
const MOD_STATUS_TEXT_LIMIT = 200;
const MOD_COMMAND_LIMIT = 50;
const MOD_KEY_LIMIT = 256;
const MOD_STATE_ENTRY_LIMIT = 1_000;
const MOD_STORE_BYTES_LIMIT = 1_000_000;
const MOD_THREAD_LIST_DEFAULT = 200;
const MOD_THREAD_LIST_MAX = 1_000;
const MOD_RELOAD_DEBOUNCE_MS = 250;
const MOD_STOP_HOOK_TIMEOUT_MS = 2_000;
const MOD_SNAPSHOT_COALESCE_MS = 25;
const MOD_VIEW_LIMIT = 20;
/** `$.state` lives in the server's memory, so its size is capped like the store's. */
const MOD_STATE_BYTES_LIMIT = 4_000_000;
/** A burst of redraw requests for one mod becomes one. */
const MOD_INVALIDATE_COALESCE_MS = 50;
/** Store writes in a burst reach the disk once. */
const MOD_STORE_FLUSH_MS = 250;
/** Toasts and log lines a mod may emit per window before the rest are dropped. */
const MOD_RATE_WINDOW_MS = 10_000;
/** Tools one mod may give to agents; each costs tokens in every session. */
const MOD_TOOL_LIMIT = 10;
const MOD_TOOL_DESCRIPTION_LIMIT = 1_024;
const MOD_TOOL_SCHEMA_BYTES_LIMIT = 8_000;
/** Providers cap tool names at 64 characters; this leaves room for the MCP server prefix. */
const MOD_TOOL_SERVED_NAME_LIMIT = 48;
/** How long `prompt.submit` hooks may hold a message before it is sent as written. */
const MOD_PROMPT_HOOKS_TIMEOUT_MS = 10_000;
/** How long `approval.requested` hooks have to deny a request before it is left to the person. */
const MOD_APPROVAL_HOOKS_TIMEOUT_MS = 5_000;
/** Observed events one mod may be handling at once; more are dropped, not queued. */
const MOD_OBSERVE_IN_FLIGHT_LIMIT = 8;

/** The permission a mod's manifest must list for its hooks on an event to run. */
const EVENT_PERMISSIONS: Readonly<Record<string, ModPermission>> = {
  "prompt.submit": "prompts",
  "approval.requested": "approvals",
  "tool.call": "tools",
};

const isToolName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,31}$/u.test(value);
const MOD_TOAST_RATE_LIMIT = 5;
const MOD_LOG_RATE_LIMIT = 200;
const MOD_URL_LIMIT = 2_048;
const REGISTRY_VERSION = 2;
/** Hidden folder in the mods folder that keeps versions an import replaced. */
const MOD_REPLACED_DIRECTORY = ".replaced";

const isCommandName = Schema.is(ModCommandName);
const isToastTone = Schema.is(ModToastTone);
const isViewId = Schema.is(ModViewId);
const isViewSite = Schema.is(ModViewSite);
const isRefreshSource = Schema.is(ModViewRefreshSource);
const isThreadId = Schema.is(ThreadId);
const isModId = Schema.is(ModId);

/** What a handler call collects while it runs: the effects it asks of the window. */
interface ModUiCallContext {
  readonly effects: ModUiEffect[];
}

/** What a `ui.render` call carries, so redraw requests it makes do not redraw it again. */
interface ModRenderCallContext {
  readonly rendering: string;
}

function isRenderContext(context: unknown): context is ModRenderCallContext {
  return (
    context !== null &&
    typeof context === "object" &&
    typeof (context as ModRenderCallContext).rendering === "string"
  );
}

function isUiCallContext(context: unknown): context is ModUiCallContext {
  return (
    context !== null &&
    typeof context === "object" &&
    Array.isArray((context as ModUiCallContext).effects)
  );
}

export interface ModManagerBackend {
  /** Every thread that has not been deleted. */
  readonly listThreads: () => Promise<ReadonlyArray<ModThread>>;
  readonly listProjects: () => Promise<ReadonlyArray<ModProject>>;
  /** Mirrors a mod's log line into the server log. */
  readonly log: (modId: string, level: ModLogLevel, message: string) => void;
}

export interface ModManagerOptions {
  /** The folder scanned for mods, one folder per mod. */
  readonly modsDir: string;
  /** Where the manager records which mods are enabled and keeps each mod's store. */
  readonly dataDir: string;
  readonly backend: ModManagerBackend;
  readonly workerUrl?: URL;
  readonly loadTimeoutMs?: number;
  readonly hookTimeoutMs?: number;
  readonly hookDeadlineMs?: number;
  /** Reload a mod when its files change. Defaults to true. */
  readonly watch?: boolean;
  /** The icon names Synara ships; views and trees naming another icon draw without it. */
  readonly iconNames?: ReadonlySet<string> | null;
  /** Where sign-ins to MCP servers are kept. Without one they last until Synara stops. */
  readonly secrets?: ModSecretVault;
  /** The port sign-ins return to. Tests pass 0 for any free port. */
  readonly signInPort?: number;
}

export type ModViewSource = ModView["refreshOn"][number];

/** A message a person is sending to an agent, as `prompt.submit` hooks see it. */
export interface ModPromptInput {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly text: string;
}

export type ModPromptOutcome =
  /** The text to send, and the mods that changed it (empty when none did). */
  | { readonly kind: "send"; readonly text: string; readonly changedBy: ReadonlyArray<string> }
  /** A mod stopped the message. */
  | { readonly kind: "block"; readonly modId: string; readonly reason: string };

/** A tool call waiting for the person's approval, as `approval.requested` hooks see it. */
export interface ModApprovalInput {
  readonly threadId: string;
  readonly requestId: string;
  readonly provider: string;
  /** What kind of thing wants approval: "command", "file-read", "file-change", "permissions", "tool". */
  readonly kind: string;
  /** The tool's name, when the provider names it. */
  readonly toolName: string | null;
  /** The card's title, when the provider gives one. */
  readonly title: string | null;
  /** What the person is shown: the command line or the path. Providers may shorten it. */
  readonly detail: string | null;
}

/** A tool a mod gives to agents. */
export interface ModAgentTool extends ModAgentToolSummary {
  readonly modId: string;
  readonly inputSchema: Record<string, unknown>;
}

export class ModManagerError extends Error {
  override readonly name = "ModManagerError";
}

interface ModRecord {
  definition: ModDefinition;
  /** The fingerprint of the mod's files as last read; null when they could not be read. */
  contentHash: string | null;
  enabled: boolean;
  status: ModStatus;
  runtimeError: string | null;
  host: ModWorkerHost | null;
  /** Bumped on every start and stop, so late answers from an old worker are ignored. */
  generation: number;
  readonly commands: Map<string, ModCommand>;
  readonly views: Map<string, ModView>;
  readonly tools: Map<string, ModAgentTool>;
  /** Observed events this mod is handling right now. */
  observing: number;
  /** Connections to the MCP servers the manifest declares, opened on first use. */
  readonly mcp: Map<string, ModMcpClient>;
  statusText: string | null;
  loadedAt: string | null;
  readonly logs: ModLogEntry[];
  /** Icon names already reported as missing since the mod started, so each is said once. */
  readonly unknownIcons: Set<string>;
  /** Toasts and log lines in the current rate window, and how many were dropped. */
  rate: { windowStart: number; toasts: number; logs: number; droppedLogs: number };
  /** Starts and stops of one mod run one after another. */
  transition: Promise<void>;
}

interface ModStore {
  readonly values: Record<string, unknown>;
  /** Serialized size of each key's entry, so a write need not serialize the whole store. */
  readonly sizes: Map<string, number>;
  bytes: number;
}

function entryBytes(key: string, serialized: string): number {
  return key.length + serialized.length + 4;
}

interface HookEntry {
  readonly record: ModRecord;
  readonly host: ModWorkerHost;
  readonly hookId: number;
}

/** Whether an event input matches a hook's matcher: every listed field equal, a list meaning any of. */
export function matchesModEvent(matcher: unknown, input: unknown): boolean {
  if (matcher === null || matcher === undefined) return true;
  if (typeof matcher !== "object" || Array.isArray(matcher)) return false;
  if (input === null || typeof input !== "object") return false;
  for (const [key, expected] of Object.entries(matcher)) {
    const actual = (input as Record<string, unknown>)[key];
    const candidates = Array.isArray(expected) ? expected : [expected];
    if (!candidates.some((candidate) => matchesValue(candidate, actual))) return false;
  }
  return true;
}

function matchesValue(expected: unknown, actual: unknown): boolean {
  if (expected !== null && typeof expected === "object") return matchesModEvent(expected, actual);
  return Object.is(expected, actual);
}

function clampText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function requireText(value: unknown, call: string, limit: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ModManagerError(`${call}: text must be a non-empty string.`);
  }
  return clampText(value, limit);
}

function requireKey(value: unknown, call: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MOD_KEY_LIMIT) {
    throw new ModManagerError(
      `${call}: the key must be a string of 1 to ${MOD_KEY_LIMIT} characters.`,
    );
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeFileAtomically(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, "utf8");
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export class ModManager {
  readonly pullRequests: ModPullRequestSources;
  private readonly pullRequestPins: ModPullRequestPins;
  private readonly options: ModManagerOptions;
  private readonly records = new Map<string, ModRecord>();
  private readonly listeners = new Set<(event: ModsStreamEvent) => void>();
  /** `$.state`, kept per mod across reloads of that mod. */
  private readonly state = new Map<string, Map<string, unknown>>();
  /** `$.state` sizes in bytes per mod and key, to keep the memory it takes bounded. */
  private readonly stateSizes = new Map<string, Map<string, number>>();
  /** `$.store`, loaded from disk on first use and changed in memory. */
  private readonly stores = new Map<string, Promise<ModStore>>();
  private readonly storeWrites = new Map<string, Promise<void>>();
  private readonly storeFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * The enabled mods, each with the fingerprint of the files the person trusted
   * (null for a mod enabled before fingerprints: it is taken on the next start).
   */
  private trusted = new Map<string, string | null>();
  /** Mods the person let reload as their files change; forgotten when Synara restarts. */
  private readonly reloadGrants = new Set<string>();
  private registryWrite: Promise<void> = Promise.resolve();
  /** Imports run one after another, so two cannot install the same name at once. */
  private imports: Promise<unknown> = Promise.resolve();
  private watcher: FSWatcher | null = null;
  /** Watchers on the real folders of linked mods, which change outside the mods folder. */
  private readonly linkWatchers = new Map<string, { target: string; watcher: FSWatcher }>();
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private workerUrl: URL | null;
  /** The person's sign-ins to the remote MCP servers of mods. */
  private readonly signIns: ModMcpSignIns;
  private started = false;
  private stopped = false;

  constructor(options: ModManagerOptions) {
    this.options = options;
    this.workerUrl = options.workerUrl ?? null;
    this.pullRequestPins = new ModPullRequestPins(
      path.join(options.dataDir, "pull-request-pins.json"),
    );
    this.pullRequests = new ModPullRequestSources({
      pins: this.pullRequestPins,
      projects: options.backend.listProjects,
      onChange: (modId, sourceId) => {
        this.emit({ type: "pullRequestsInvalidated", modId, sourceId });
        this.scheduleSnapshot();
      },
      log: (modId, message) => {
        const record = this.records.get(modId);
        if (record) this.appendLog(record, "error", message);
      },
    });
    this.signIns = new ModMcpSignIns({
      vault: options.secrets ?? makeMemoryModSecretVault(),
      port: options.signInPort,
      onChange: (modId, redraw) => {
        if (this.stopped) return;
        this.scheduleSnapshot();
        // After a sign-in the views can draw what the server refused before.
        if (redraw && this.records.has(modId)) this.scheduleInvalidate(modId, null);
      },
      log: (modId, level, message) => {
        const record = this.records.get(modId);
        if (record) this.appendLog(record, level, message);
      },
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Reads the mods folder and starts the enabled mods without waiting for them to load. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await fs.mkdir(this.options.modsDir, { recursive: true });
    await fs.mkdir(this.storeDir(), { recursive: true });
    await this.pullRequestPins.load();
    const stored = await this.readRegistry();
    const folders = await listModFolders(this.options.modsDir);
    // Trust belongs to a mod that exists; a later folder with that name is new code.
    const present = new Set(folders.map((folder) => path.basename(folder)));
    await this.pullRequestPins.retainMods(present);
    const kept = new Map([...stored].filter(([id]) => present.has(id)));
    if (kept.size !== stored.size) await this.writeRegistry(kept);
    this.trusted = kept;
    for (const folder of folders) {
      await this.refreshMod(path.basename(folder), { restart: false });
    }
    if (this.options.watch !== false) {
      this.startWatching();
      // The mods read above were found before there was a watcher to hang their links on.
      for (const record of this.records.values()) {
        await this.watchLinkedMod(record.definition.id, record.definition.root);
      }
    }
  }

  /** Resolves once every start and stop that has been asked for has finished. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.records.values()].map((record) => record.transition));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    for (const link of this.linkWatchers.values()) link.watcher.close();
    this.linkWatchers.clear();
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    for (const timer of this.invalidateTimers.values()) clearTimeout(timer);
    this.invalidateTimers.clear();
    // Deleting the entry being visited is safe while iterating a Map.
    for (const modId of this.storeFlushTimers.keys()) this.flushStore(modId);
    if (this.snapshotTimer !== null) clearTimeout(this.snapshotTimer);
    await this.signIns.stop();
    await Promise.all(
      [...this.records.values()].map((record) =>
        this.transition(record, () => this.stopRecord(record)),
      ),
    );
    await Promise.all([this.registryWrite, ...this.storeWrites.values()]);
    await this.pullRequestPins.flush();
    this.listeners.clear();
  }

  // ── Queries and commands ───────────────────────────────────────────

  snapshot(): ModsSnapshot {
    return {
      modsDir: this.options.modsDir,
      mods: [...this.records.values()]
        .toSorted((left, right) => left.definition.id.localeCompare(right.definition.id))
        .map((record) => this.toSummary(record)),
    };
  }

  subscribe(listener: (event: ModsStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Turns a mod on or off. Turning it on trusts its files as they are now,
   * also for a mod that is already on and was stopped because they changed.
   * `reloadOnChange` lets it keep reloading as they change, for a mod being
   * written; otherwise a change stops it until it is trusted again.
   */
  async setEnabled(
    id: string,
    enabled: boolean,
    options: { readonly reloadOnChange?: boolean | undefined } = {},
  ): Promise<ModsSnapshot> {
    const record = this.requireRecord(id);
    if (!enabled) {
      this.reloadGrants.delete(id);
      if (record.enabled || this.trusted.has(id)) {
        // Save first: if the disk refuses, nothing changed and the toggle can be tried again.
        const next = new Map(this.trusted);
        next.delete(id);
        await this.writeRegistry(next);
        this.trusted = next;
        record.enabled = false;
        await this.transition(record, () => this.stopRecord(record));
      }
      return this.snapshot();
    }
    const hash = await this.readContentHash(record);
    const alreadyRunsIt =
      record.enabled &&
      (record.status === "running" || record.status === "starting") &&
      this.trusted.get(id) === hash;
    if (this.trusted.get(id) !== hash || !this.trusted.has(id)) {
      const next = new Map(this.trusted);
      next.set(id, hash);
      await this.writeRegistry(next);
      this.trusted = next;
    }
    if (options.reloadOnChange === true) this.reloadGrants.add(id);
    else if (options.reloadOnChange === false) this.reloadGrants.delete(id);
    record.enabled = true;
    if (alreadyRunsIt) this.scheduleSnapshot();
    else await this.transition(record, () => this.startRecord(record));
    return this.snapshot();
  }

  /** The fingerprint of a mod's files now; null when its folder cannot be read whole. */
  private async readContentHash(record: ModRecord): Promise<string | null> {
    record.contentHash = await hashModFolder(record.definition.root).catch(() => null);
    return record.contentHash;
  }

  /** Reads the mod's files again and, when it is enabled, restarts it. */
  async reload(id: string): Promise<ModsSnapshot> {
    this.requireRecord(id);
    await this.refreshMod(id, { restart: true });
    await this.records.get(id)?.transition;
    return this.snapshot();
  }

  /**
   * Starts the person's sign-in to one of a mod's MCP servers and returns the
   * page to open. Only for a mod they trust as it is now: the sign-in gives the
   * mod's code their account on that server.
   */
  async beginMcpSignIn(id: string, server: string): Promise<{ url: string }> {
    const record = this.requireRecord(id);
    if (record.status === "changed") {
      throw new ModManagerError(
        `The "${id}" mod changed since it was enabled. Trust its changes before signing in for it.`,
      );
    }
    if (!record.enabled) {
      throw new ModManagerError(`Turn the "${id}" mod on before signing in for it.`);
    }
    const [name, config] = this.mcpServer(record, server);
    return { url: await this.signIns.begin(id, name, config) };
  }

  async signOutMcp(id: string, server: string): Promise<ModsSnapshot> {
    const [name] = this.mcpServer(this.requireRecord(id), server);
    await this.signIns.signOut(id, name);
    return this.snapshot();
  }

  readLogs(id: string): ModsReadLogsResult {
    return { logs: [...this.requireRecord(id).logs] };
  }

  /** The mod's folder as the text of a `<name>.synara-mod.json` file. */
  async exportMod(id: string): Promise<ModsExportResult> {
    const { definition } = this.requireRecord(id);
    if (definition.manifest === null) {
      throw new ModManagerError(
        `The mod "${id}" cannot be exported until its manifest is fixed: ${definition.error ?? "it cannot be read."}`,
      );
    }
    const bundle = await packModFolder(definition.root, {
      name: id,
      version: definition.manifest.version,
    }).catch((error: unknown) => {
      throw new ModManagerError(`The mod "${id}" cannot be exported: ${errorMessage(error)}`);
    });
    return {
      filename: `${id}${MOD_BUNDLE_FILE_SUFFIX}`,
      contents: `${JSON.stringify(bundle, null, 2)}\n`,
    };
  }

  /**
   * Installs an exported mod into the mods folder, turned off: the person
   * enables it, and trusts it, as with any new mod. With `replace`, an installed
   * mod of the same name is turned off and its files are replaced; its stored
   * data stays.
   */
  importMod(value: unknown, replace: boolean): Promise<ModsImportResult> {
    const run = this.imports.then(() => this.installBundle(value, replace));
    this.imports = run.catch(() => undefined);
    return run;
  }

  async runCommand(
    modId: string,
    command: string,
    threadId: string | null,
  ): Promise<ModsRunCommandResult> {
    const record = this.requireRecord(modId);
    if (record.status !== "running" || record.host === null) {
      throw new ModManagerError(`The mod "${modId}" is not running.`);
    }
    if (!record.commands.has(command)) {
      throw new ModManagerError(`The mod "${modId}" has no "${command}" command.`);
    }
    const input = { command, threadId };
    const failures: string[] = [];
    const result = await this.runChain(
      "command.run",
      input,
      this.hooksOf(record, "command.run", input),
      async () => undefined,
      failures,
    );
    // A command whose hooks all failed did nothing; the person who ran it should know.
    if (result === undefined && failures.length > 0) {
      throw new ModManagerError(`The "${command}" command failed: ${failures[0]}`);
    }
    const text =
      result !== null &&
      typeof result === "object" &&
      typeof (result as { text?: unknown }).text === "string"
        ? clampText((result as { text: string }).text, MOD_TOAST_TEXT_LIMIT)
        : null;
    return { text: text !== null && text.trim().length > 0 ? text : null };
  }

  /** Draws one of a mod's views for a window: runs its `ui.render` hooks and checks the tree. */
  async renderView(
    modId: string,
    viewId: string,
    context: ModViewContext,
  ): Promise<ModsRenderViewResult> {
    const record = this.requireRunning(modId);
    const view = record.views.get(viewId);
    if (!view) throw new ModManagerError(`The mod "${modId}" has no view named "${viewId}".`);
    const input = { view: view.id, site: view.site, context };
    const failures: string[] = [];
    const result = await this.runChain(
      "ui.render",
      input,
      this.hooksOf(record, "ui.render", input),
      async () => null,
      failures,
      { rendering: view.id } satisfies ModRenderCallContext,
    );
    // A render hook that threw would otherwise leave the view blank with no reason.
    if (result === null && failures.length > 0) {
      throw new ModManagerError(`The "${viewId}" view could not be drawn: ${failures[0]}`);
    }
    try {
      return {
        tree: normalizeModUiTree(result, {
          iconNames: this.options.iconNames ?? null,
          onUnknownIcon: (name) => this.reportUnknownIcon(record, name),
        }),
      };
    } catch (error) {
      const message = `The "${viewId}" view returned a tree Synara cannot draw: ${errorMessage(error)}`;
      this.appendLog(record, "error", message);
      throw new ModManagerError(message);
    }
  }

  /** Runs the handler a rendered tree referenced and returns what it asked of the window. */
  async dispatchUi(
    modId: string,
    handlerId: string,
    payload: unknown,
  ): Promise<ModsDispatchUiResult> {
    const record = this.requireRunning(modId);
    const host = record.host;
    if (host === null) throw new ModManagerError(`The mod "${modId}" is not running.`);
    const context: ModUiCallContext = { effects: [] };
    const outcome = await host.invokeHandler(handlerId, payload, context);
    if (outcome.kind === "error") {
      this.appendLog(record, "error", `A handler failed: ${outcome.error}`);
      throw new ModManagerError(outcome.error);
    }
    return { effects: context.effects };
  }

  /** Synara's threads or projects changed; redraws the views that asked to follow them. */
  notifyDataChanged(source: ModViewSource): void {
    for (const record of this.records.values()) {
      if (record.status !== "running") continue;
      for (const view of record.views.values()) {
        if (view.refreshOn.includes(source)) {
          this.emit({ type: "invalidate", modId: record.definition.id, viewId: view.id });
        }
      }
    }
  }

  /**
   * Runs `event` through the matching hooks of every running mod, in mod order,
   * ending with `fallback` (Synara's own behaviour).
   */
  dispatch(
    event: string,
    input: unknown,
    fallback: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const entries = [...this.records.values()]
      .toSorted((left, right) => left.definition.id.localeCompare(right.definition.id))
      .flatMap((record) => this.hooksOf(record, event, input));
    return entries.length === 0 ? fallback(input) : this.runChain(event, input, entries, fallback);
  }

  // ── Agent hooks ────────────────────────────────────────────────────

  /** Whether a running mod hooks `event` and holds the permission it needs. */
  hasHooks(event: string): boolean {
    for (const record of this.records.values()) {
      const host = record.host;
      if (host === null || !host.isAlive) continue;
      const permission = EVENT_PERMISSIONS[event];
      if (permission !== undefined && !this.hasPermission(record, permission)) continue;
      if (host.hooks.some((hook) => hook.event === event)) return true;
    }
    return false;
  }

  /**
   * Tells running mods that something happened. Each hook runs on its own and
   * nothing it returns changes anything; a mod already busy with too many
   * events misses this one.
   */
  observe(event: string, input: unknown): void {
    for (const entry of this.allHooksOf(event, input)) {
      const { record } = entry;
      if (record.observing >= MOD_OBSERVE_IN_FLIGHT_LIMIT) continue;
      record.observing += 1;
      void entry.host
        .invoke(entry.hookId, input, async () => undefined)
        .then((outcome) => {
          if (outcome.kind === "error") {
            this.appendLog(record, "error", `A "${event}" hook failed: ${outcome.error}`);
          }
        })
        .finally(() => {
          record.observing -= 1;
        });
    }
  }

  /**
   * Passes a message a person is sending through the `prompt.submit` hooks of
   * the mods allowed to change it, one after another. A hook returns `{ text }`
   * to change the message, `{ block }` to stop it, or nothing. A hook that
   * fails, takes too long or returns text that does not fit is skipped: the
   * message is never lost to a mod's mistake.
   */
  async submitPrompt(input: ModPromptInput, maxChars: number): Promise<ModPromptOutcome> {
    let current = input;
    const changedBy: string[] = [];
    const deadline = Date.now() + MOD_PROMPT_HOOKS_TIMEOUT_MS;
    for (const entry of this.allHooksOf("prompt.submit", input)) {
      const { record } = entry;
      const modId = record.definition.id;
      const remaining = deadline - Date.now();
      const snapshot = current;
      const outcome =
        remaining <= 0
          ? undefined
          : await withTimeout(
              entry.host.invoke(entry.hookId, snapshot, async () => ({ text: snapshot.text })),
              remaining,
            );
      if (outcome === undefined) {
        this.appendLog(
          record,
          "warn",
          `A "prompt.submit" hook took longer than ${MOD_PROMPT_HOOKS_TIMEOUT_MS / 1000} s; the message was sent without it.`,
        );
        break;
      }
      if (outcome.kind === "error") {
        this.appendLog(record, "error", `A "prompt.submit" hook failed: ${outcome.error}`);
        continue;
      }
      const result = (outcome.value ?? {}) as { readonly text?: unknown; readonly block?: unknown };
      if (typeof result.block === "string" && result.block.trim().length > 0) {
        const reason = clampText(result.block.trim(), MOD_TOAST_TEXT_LIMIT);
        this.appendLog(record, "info", `Stopped a message: ${reason}`);
        return { kind: "block", modId, reason };
      }
      if (result.text === undefined || result.text === current.text) continue;
      if (typeof result.text !== "string" || result.text.trim().length === 0) {
        this.appendLog(record, "warn", 'A "prompt.submit" hook returned no text; ignored.');
        continue;
      }
      if (result.text.length > maxChars) {
        this.appendLog(
          record,
          "warn",
          `A "prompt.submit" hook returned ${result.text.length} characters, more than the ${maxChars} that fit; ignored.`,
        );
        continue;
      }
      current = { ...current, text: result.text };
      changedBy.push(modId);
    }
    return { kind: "send", text: current.text, changedBy };
  }

  /**
   * Asks the mods allowed to review approvals whether to deny a tool call that
   * waits for the person. A mod can only deny; with no denial in time the
   * request stays with the person, as if no mod were there.
   */
  async reviewApproval(
    input: ModApprovalInput,
  ): Promise<{ readonly modId: string; readonly reason: string } | null> {
    const deadline = Date.now() + MOD_APPROVAL_HOOKS_TIMEOUT_MS;
    for (const entry of this.allHooksOf("approval.requested", input)) {
      const { record } = entry;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const outcome = await withTimeout(
        entry.host.invoke(entry.hookId, input, async () => undefined),
        remaining,
      );
      if (outcome === undefined) break;
      if (outcome.kind === "error") {
        this.appendLog(record, "error", `An "approval.requested" hook failed: ${outcome.error}`);
        continue;
      }
      const deny = (outcome.value as { readonly deny?: unknown } | null | undefined)?.deny;
      if (typeof deny === "string" && deny.trim().length > 0) {
        const reason = clampText(deny.trim(), MOD_TOAST_TEXT_LIMIT);
        this.appendLog(record, "info", `Denied a ${input.kind} approval: ${reason}`);
        return { modId: record.definition.id, reason };
      }
    }
    return null;
  }

  /** The tools running mods give to agents. */
  agentTools(): ModAgentTool[] {
    return [...this.records.values()]
      .filter((record) => record.status === "running")
      .toSorted((left, right) => left.definition.id.localeCompare(right.definition.id))
      .flatMap((record) => [...record.tools.values()]);
  }

  /** Runs a mod's tool for an agent; the `tool.call` hook's answer is the result. */
  async callAgentTool(
    servedName: string,
    args: Record<string, unknown>,
    threadId: string | null,
  ): Promise<unknown> {
    for (const record of this.records.values()) {
      const tool = [...record.tools.values()].find((entry) => entry.servedName === servedName);
      if (!tool) continue;
      const input = { tool: tool.name, arguments: args, threadId };
      const entries = this.hooksOf(record, "tool.call", input);
      if (entries.length === 0) {
        throw new ModManagerError(
          `The "${record.definition.id}" mod has no "tool.call" hook for "${tool.name}".`,
        );
      }
      const failures: string[] = [];
      const result = await this.runChain(
        "tool.call",
        input,
        entries,
        async () => undefined,
        failures,
      );
      if (result === undefined && failures.length > 0) {
        throw new ModManagerError(`The "${tool.name}" tool failed: ${failures[0]}`);
      }
      return result ?? null;
    }
    throw new ModManagerError(
      `No running mod has a tool named "${servedName}". Its mod may be off or reloading.`,
    );
  }

  /** Checks a tool a mod registers; every provider must be able to take its name and schema. */
  private checkAgentTool(record: ModRecord, value: unknown): ModAgentTool {
    const definition = (value ?? {}) as Partial<
      Record<"name" | "description" | "inputSchema", unknown>
    >;
    const call = "$.tool.register({ name, description, inputSchema })";
    if (!isToolName(definition.name)) {
      throw new ModManagerError(
        `${call}: name must be lowercase letters, digits and underscores, starting with a letter, up to 32 characters.`,
      );
    }
    const modId = record.definition.id;
    const servedName = `mod_${modId.replaceAll("-", "_")}_${definition.name}`;
    if (servedName.length > MOD_TOOL_SERVED_NAME_LIMIT) {
      throw new ModManagerError(
        `${call}: "${servedName}" is longer than ${MOD_TOOL_SERVED_NAME_LIMIT} characters; shorten the tool's name.`,
      );
    }
    for (const other of this.records.values()) {
      if (other === record) continue;
      if ([...other.tools.values()].some((tool) => tool.servedName === servedName)) {
        throw new ModManagerError(
          `${call}: the "${other.definition.id}" mod already serves a tool as "${servedName}".`,
        );
      }
    }
    if (!record.tools.has(definition.name) && record.tools.size >= MOD_TOOL_LIMIT) {
      throw new ModManagerError(`A mod can give agents at most ${MOD_TOOL_LIMIT} tools.`);
    }
    const description = requireText(
      definition.description,
      `${call}: description`,
      MOD_TOOL_DESCRIPTION_LIMIT,
    ).trim();
    const schema = definition.inputSchema ?? { type: "object", properties: {} };
    let serialized: string;
    try {
      serialized = JSON.stringify(schema);
    } catch {
      throw new ModManagerError(`${call}: inputSchema must be plain JSON.`);
    }
    const root = schema as Record<string, unknown>;
    if (
      schema === null ||
      typeof schema !== "object" ||
      Array.isArray(schema) ||
      root.type !== "object" ||
      (root.properties !== undefined &&
        (root.properties === null ||
          typeof root.properties !== "object" ||
          Array.isArray(root.properties)))
    ) {
      throw new ModManagerError(
        `${call}: inputSchema must be a JSON Schema object with type "object" and a "properties" object.`,
      );
    }
    if (/"\$(?:ref|defs)"|"(?:anyOf|oneOf|allOf)"\s*:/u.test(serialized)) {
      throw new ModManagerError(
        `${call}: inputSchema may not use $ref, $defs, anyOf, oneOf or allOf; some providers refuse them.`,
      );
    }
    if (serialized.length > MOD_TOOL_SCHEMA_BYTES_LIMIT) {
      throw new ModManagerError(
        `${call}: inputSchema is larger than ${MOD_TOOL_SCHEMA_BYTES_LIMIT / 1000} KB.`,
      );
    }
    return {
      modId,
      name: definition.name,
      servedName,
      // Agents read this as an instruction; say where it comes from.
      description: `[${modId} mod] ${description}`,
      inputSchema: JSON.parse(serialized) as Record<string, unknown>,
    };
  }

  // ── Import ─────────────────────────────────────────────────────────

  private async installBundle(value: unknown, replace: boolean): Promise<ModsImportResult> {
    if (this.stopped) throw new ModManagerError("Mods are shutting down.");
    let unpacked: ReturnType<typeof readModBundle>;
    try {
      unpacked = readModBundle(value);
    } catch (error) {
      throw new ModManagerError(errorMessage(error));
    }
    const id = unpacked.bundle.name;
    const { modsDir } = this.options;
    const target = path.join(modsDir, id);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing !== null && !replace) {
      throw new ModManagerError(
        `A mod named "${id}" is already installed. Import it again and choose to replace it.`,
      );
    }
    if (existing?.isSymbolicLink()) {
      throw new ModManagerError(
        `The installed "${id}" mod is a link to another folder, so Synara will not replace it. Remove the link first.`,
      );
    }

    await fs.mkdir(modsDir, { recursive: true });
    // A hidden folder inside the mods folder: discovery and the watcher skip it,
    // and moving the mod into place is a rename on the same disk.
    const staging = await fs.mkdtemp(path.join(modsDir, ".import-"));
    try {
      const staged = path.join(staging, id);
      try {
        await writeModFiles(staged, unpacked.files);
      } catch (error) {
        throw new ModManagerError(`The mod's files cannot be written: ${errorMessage(error)}`);
      }
      const definition = await readModDefinition(staged);
      if (definition === null) {
        throw new ModManagerError("The file holds no mod: it has no manifest and no hooks file.");
      }
      if (definition.error !== null) {
        throw new ModManagerError(`The mod "${id}" cannot be imported: ${definition.error}`);
      }

      // New code is never trusted on the old code's behalf, nor signed in on it.
      if (existing !== null) await this.signIns.forget(id);
      if (this.records.get(id)?.enabled) await this.setEnabled(id, false);
      else if (this.trusted.has(id)) {
        const next = new Map(this.trusted);
        next.delete(id);
        await this.writeRegistry(next);
        this.trusted = next;
      }
      this.reloadGrants.delete(id);

      // The replaced version is kept, not deleted: it may hold a git history or notes.
      const previous =
        existing === null
          ? null
          : path.join(modsDir, MOD_REPLACED_DIRECTORY, `${id}-${Date.now()}`);
      if (previous !== null) {
        await fs.mkdir(path.dirname(previous), { recursive: true });
        await fs.rename(target, previous);
      }
      try {
        await fs.rename(staged, target);
      } catch (error) {
        const restored =
          previous === null ||
          (await fs.rename(previous, target).then(
            () => true,
            () => false,
          ));
        throw new ModManagerError(
          `The mod cannot be moved into place: ${errorMessage(error)}${
            restored ? "" : ` The installed version is in ${previous}.`
          }`,
        );
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }

    await this.refreshMod(id, { restart: false });
    await this.records.get(id)?.transition;
    return { id, replaced: existing !== null, snapshot: this.snapshot() };
  }

  // ── Records ────────────────────────────────────────────────────────

  /** One of the servers the mod's manifest declares, by the name the mod gives it. */
  private mcpServer(record: ModRecord, server: unknown): [string, ModMcpServerConfig] {
    const servers = record.definition.manifest?.mcpServers ?? {};
    if (typeof server !== "string" || !Object.hasOwn(servers, server)) {
      const declared = Object.keys(servers);
      throw new ModManagerError(
        `$.mcp: "${String(server)}" is not one of this mod's MCP servers (${
          declared.length > 0 ? declared.join(", ") : "it declares none in mod.json"
        }).`,
      );
    }
    return [server, servers[server]!];
  }

  private mcpClient(record: ModRecord, server: unknown): ModMcpClient {
    const [name, config] = this.mcpServer(record, server);
    let client = record.mcp.get(name);
    if (!client) {
      client = new ModMcpClient(
        name,
        config,
        "url" in config ? this.signIns.access(record.definition.id, name, config) : null,
      );
      record.mcp.set(name, client);
    }
    return client;
  }

  /** Stops the mod's MCP servers; resolves once their processes are gone, logging any that may not be. */
  private closeMcp(record: ModRecord): Promise<void> {
    const clients = [...record.mcp.values()];
    record.mcp.clear();
    return Promise.allSettled(clients.map((client) => client.close())).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          this.appendLog(
            record,
            "error",
            `An MCP server may still be running: ${errorMessage(result.reason)}`,
          );
        }
      }
    });
  }

  private requireRunning(id: string): ModRecord {
    const record = this.requireRecord(id);
    if (record.status !== "running" || record.host === null) {
      throw new ModManagerError(`The mod "${id}" is not running.`);
    }
    return record;
  }

  private requireRecord(id: string): ModRecord {
    const record = this.records.get(id);
    if (!record) throw new ModManagerError(`There is no mod named "${id}".`);
    return record;
  }

  private transition(record: ModRecord, step: () => Promise<void>): Promise<void> {
    record.transition = record.transition.then(step, step).catch((error: unknown) => {
      this.appendLog(record, "error", `Lifecycle error: ${errorMessage(error)}`);
    });
    return record.transition;
  }

  /**
   * Reads a mod's folder again. `restart` restarts an enabled mod;
   * `onlyIfChanged` skips that when its files are the ones already running
   * (an editor touching a file, a save without changes).
   */
  private async refreshMod(
    id: string,
    options: { readonly restart: boolean; readonly onlyIfChanged?: boolean },
  ): Promise<void> {
    if (this.stopped || !isModId(id)) return;
    const root = path.join(this.options.modsDir, id);
    const definition = await readModDefinition(root).catch(
      (error: unknown): ModDefinition => ({
        id,
        root,
        manifest: null,
        entry: null,
        error: `The mod's folder cannot be read: ${errorMessage(error)}`,
      }),
    );
    const existing = this.records.get(id);
    if (definition === null) {
      if (existing) {
        await this.transition(existing, () => this.stopRecord(existing));
        this.records.delete(id);
        this.state.delete(id);
        this.stateSizes.delete(id);
        this.scheduleSnapshot();
      }
      this.linkWatchers.get(id)?.watcher.close();
      this.linkWatchers.delete(id);
      // A folder that comes back under this name is new code; it starts off, signed out.
      await this.signIns.forget(id);
      await this.pullRequestPins.removeMod(id);
      this.reloadGrants.delete(id);
      if (this.trusted.has(id)) {
        const next = new Map(this.trusted);
        next.delete(id);
        await this.writeRegistry(next);
        this.trusted = next;
      }
      return;
    }
    await this.watchLinkedMod(id, root);
    const contentHash = await hashModFolder(root).catch(() => null);
    if (!existing) {
      // Read before the mod is listed, so its row says at once whether it is signed in.
      await this.signIns.load(id);
      const record: ModRecord = {
        definition,
        contentHash,
        enabled: this.trusted.has(id),
        status: "disabled",
        runtimeError: null,
        host: null,
        generation: 0,
        commands: new Map(),
        views: new Map(),
        tools: new Map(),
        observing: 0,
        mcp: new Map(),
        statusText: null,
        loadedAt: null,
        logs: [],
        unknownIcons: new Set(),
        rate: { windowStart: 0, toasts: 0, logs: 0, droppedLogs: 0 },
        transition: Promise.resolve(),
      };
      this.records.set(id, record);
      if (record.enabled) void this.transition(record, () => this.startRecord(record));
      this.scheduleSnapshot();
      return;
    }
    const unchanged = existing.contentHash !== null && existing.contentHash === contentHash;
    existing.definition = definition;
    existing.contentHash = contentHash;
    if (options.onlyIfChanged === true && unchanged && existing.host !== null) {
      this.scheduleSnapshot();
      return;
    }
    if (existing.enabled && (options.restart || existing.host === null)) {
      void this.transition(existing, async () => {
        await this.stopRecord(existing);
        await this.startRecord(existing);
      });
    }
    this.scheduleSnapshot();
  }

  private async startRecord(record: ModRecord): Promise<void> {
    // Never two workers for one mod: a start queued behind another stops the first.
    const running = record.host;
    if (running !== null) {
      record.host = null;
      await running.stop();
    }
    record.generation += 1;
    const generation = record.generation;
    record.commands.clear();
    record.views.clear();
    record.tools.clear();
    this.pullRequests.withdrawMod(record.definition.id);
    record.unknownIcons.clear();
    await this.closeMcp(record);
    this.signIns.restarted(record.definition.id);
    record.statusText = null;
    record.loadedAt = null;
    record.runtimeError = null;
    const { definition } = record;
    if (!record.enabled || this.stopped) {
      record.status = "disabled";
      this.scheduleSnapshot();
      return;
    }
    if (definition.error !== null || definition.entry === null || definition.manifest === null) {
      record.status = "error";
      this.scheduleSnapshot();
      return;
    }
    // Run only the code the person trusted. A mod that changed since then waits for
    // them, unless they said it may reload while it is being written.
    const id = definition.id;
    const current = await this.readContentHash(record);
    if (generation !== record.generation) return;
    if (current === null) {
      record.status = "error";
      record.runtimeError =
        "The mod's files cannot be read to check them; it may hold too many or too large files.";
      this.scheduleSnapshot();
      return;
    }
    const trustedHash = this.trusted.get(id) ?? null;
    if (trustedHash !== current) {
      if (trustedHash !== null && !this.reloadGrants.has(id)) {
        record.status = "changed";
        this.appendLog(
          record,
          "warn",
          "Its files changed since it was enabled, so it was stopped. The person can press Trust changes in Settings → Mods.",
        );
        this.scheduleSnapshot();
        return;
      }
      const next = new Map(this.trusted);
      next.set(id, current);
      await this.writeRegistry(next).catch(() => undefined);
      this.trusted = next;
      if (generation !== record.generation) return;
    }
    record.status = "starting";
    this.scheduleSnapshot();
    try {
      const host = await ModWorkerHost.start({
        data: {
          modId: definition.id,
          version: definition.manifest.version,
          root: definition.root,
          entry: definition.entry,
          options: {},
          elements: MOD_UI_ELEMENTS,
        },
        workerUrl: await this.resolveWorkerUrl(),
        ...(this.options.loadTimeoutMs === undefined
          ? {}
          : { loadTimeoutMs: this.options.loadTimeoutMs }),
        ...(this.options.hookTimeoutMs === undefined
          ? {}
          : { hookTimeoutMs: this.options.hookTimeoutMs }),
        ...(this.options.hookDeadlineMs === undefined
          ? {}
          : { hookDeadlineMs: this.options.hookDeadlineMs }),
        handleApi: (method, args, context) =>
          this.handleApi(record, generation, method, args, context),
        onUncaught: (error) => {
          if (generation === record.generation)
            this.appendLog(record, "error", `Uncaught: ${error}`);
        },
        onExit: (reason) => this.handleExit(record, generation, reason),
      });
      if (generation !== record.generation || this.stopped) {
        await host.stop();
        return;
      }
      record.host = host;
      record.status = "running";
      record.loadedAt = new Date().toISOString();
      this.appendLog(record, "info", `Loaded version ${definition.manifest.version}.`);
      for (const event of new Set(host.hooks.map((hook) => hook.event))) {
        const permission = EVENT_PERMISSIONS[event];
        if (permission !== undefined && !this.hasPermission(record, permission)) {
          this.appendLog(
            record,
            "warn",
            `The "${event}" hook will not run: add "${permission}" to "permissions" in mod.json.`,
          );
        }
      }
      this.scheduleSnapshot();
      await this.runChain(
        "mod.start",
        {},
        this.hooksOf(record, "mod.start", {}),
        async () => undefined,
      );
    } catch (error) {
      if (generation !== record.generation) return;
      record.status = "error";
      record.runtimeError = errorMessage(error);
      this.appendLog(record, "error", `Failed to load: ${record.runtimeError}`);
      this.scheduleSnapshot();
    }
  }

  private async stopRecord(record: ModRecord): Promise<void> {
    const host = record.host;
    if (host?.isAlive) {
      await withTimeout(
        this.runChain("mod.stop", {}, this.hooksOf(record, "mod.stop", {}), async () => undefined),
        MOD_STOP_HOOK_TIMEOUT_MS,
      );
    }
    record.generation += 1;
    record.host = null;
    record.commands.clear();
    record.views.clear();
    record.tools.clear();
    this.pullRequests.withdrawMod(record.definition.id);
    await this.closeMcp(record);
    record.statusText = null;
    record.loadedAt = null;
    record.runtimeError = null;
    record.status = record.enabled && record.definition.error !== null ? "error" : "disabled";
    if (host) await host.stop();
    this.scheduleSnapshot();
  }

  private handleExit(record: ModRecord, generation: number, reason: string): void {
    if (generation !== record.generation) return;
    record.host = null;
    record.status = "error";
    record.runtimeError = reason;
    record.commands.clear();
    record.views.clear();
    record.tools.clear();
    this.pullRequests.withdrawMod(record.definition.id);
    void this.closeMcp(record);
    record.statusText = null;
    this.appendLog(record, "error", reason);
    this.scheduleSnapshot();
  }

  private async resolveWorkerUrl(): Promise<URL> {
    this.workerUrl ??= await resolveModWorkerUrl();
    return this.workerUrl;
  }

  /** A view's icon as Synara will draw it: null (the default glyph) when it names no shipped icon. */
  private checkIcon(record: ModRecord, icon: unknown): string | null {
    if (typeof icon !== "string" || icon.trim().length === 0) return null;
    const name = clampText(icon.trim(), 128);
    const known = this.options.iconNames;
    if (known && !known.has(name)) {
      this.reportUnknownIcon(record, name);
      return null;
    }
    return name;
  }

  private reportUnknownIcon(record: ModRecord, name: string): void {
    if (record.unknownIcons.has(name)) return;
    record.unknownIcons.add(name);
    this.appendLog(
      record,
      "warn",
      `There is no icon named "${name}", so it is not drawn. The mods skill lists every name in reference/icons.txt.`,
    );
  }

  // ── Hook chains ────────────────────────────────────────────────────

  private hooksOf(record: ModRecord, event: string, input: unknown): HookEntry[] {
    const host = record.host;
    if (host === null || !host.isAlive) return [];
    const permission = EVENT_PERMISSIONS[event];
    if (permission !== undefined && !this.hasPermission(record, permission)) return [];
    return host.hooks
      .filter((hook) => hook.event === event && matchesModEvent(hook.matcher, input))
      .map((hook) => ({ record, host, hookId: hook.hookId }));
  }

  private hasPermission(record: ModRecord, permission: ModPermission): boolean {
    return record.definition.manifest?.permissions?.includes(permission) ?? false;
  }

  /** Every running mod's hooks for an event, in mod order. */
  private allHooksOf(event: string, input: unknown): HookEntry[] {
    return [...this.records.values()]
      .toSorted((left, right) => left.definition.id.localeCompare(right.definition.id))
      .flatMap((record) => this.hooksOf(record, event, input));
  }

  /** `failures`, when given, collects why each failed hook failed. */
  private runChain(
    event: string,
    input: unknown,
    entries: ReadonlyArray<HookEntry>,
    fallback: (input: unknown) => Promise<unknown>,
    failures?: string[],
    context: unknown = null,
  ): Promise<unknown> {
    const step = async (index: number, current: unknown): Promise<unknown> => {
      const entry = entries[index];
      if (!entry) return fallback(current);
      const downstream: { current: Promise<unknown> | null } = { current: null };
      const outcome = await entry.host.invoke(
        entry.hookId,
        current,
        (nextInput) => {
          downstream.current = step(index + 1, nextInput);
          return downstream.current;
        },
        context,
      );
      if (outcome.kind === "result") return outcome.value;
      this.appendLog(entry.record, "error", `A "${event}" hook failed: ${outcome.error}`);
      failures?.push(outcome.error);
      // A failed hook drops out of the chain; the rest still runs once.
      return downstream.current ?? step(index + 1, current);
    };
    return step(0, input);
  }

  // ── The `$` interface ──────────────────────────────────────────────

  private async handleApi(
    record: ModRecord,
    generation: number,
    method: string,
    args: ReadonlyArray<unknown>,
    context: unknown = null,
  ): Promise<unknown> {
    if (generation !== record.generation) throw new ModManagerError("The mod was stopped.");
    const modId = record.definition.id;
    switch (method) {
      case "pullRequests.registerSource": {
        this.pullRequests.register(modId, generation, args[0], async (event, input) => {
          const host = record.host;
          if (generation !== record.generation || !host?.isAlive || record.status !== "running")
            throw new ModManagerError("The source's mod was stopped.");
          const entries = this.hooksOf(record, event, input);
          if (entries.length === 0)
            throw new ModManagerError(`The mod has no matching ${event} hook for this source.`);
          const step = async (index: number, value: unknown): Promise<unknown> => {
            const entry = entries[index];
            if (!entry) throw new ModManagerError(`No ${event} hook answered this request.`);
            if (generation !== record.generation || record.host !== host)
              throw new ModManagerError("The source's mod was stopped.");
            const outcome = await host.invoke(entry.hookId, value, (nextInput) =>
              step(index + 1, nextInput),
            );
            if (outcome.kind === "error")
              throw Object.assign(new ModManagerError(outcome.error), { code: outcome.code });
            return outcome.value;
          };
          return step(0, input);
        });
        return undefined;
      }
      case "pullRequests.unregisterSource":
        this.pullRequests.unregister(modId, requireText(args[0], method, 64));
        return undefined;
      case "pullRequests.invalidate":
        this.pullRequests.invalidate(
          modId,
          args[0] === undefined ? undefined : requireText(args[0], method, 64),
        );
        return undefined;
      case "log.info":
      case "log.warn":
      case "log.error": {
        const message = typeof args[0] === "string" ? args[0] : String(args[0]);
        this.appendLog(record, method.slice("log.".length) as ModLogLevel, message);
        return undefined;
      }
      case "ui.toast": {
        const text = requireText(args[0], "$.ui.toast(text)", MOD_TOAST_TEXT_LIMIT);
        const tone = (args[1] as { readonly tone?: unknown } | undefined)?.tone ?? "info";
        if (!isToastTone(tone)) {
          throw new ModManagerError(
            '$.ui.toast(text, { tone }): tone must be "info", "success", "warning" or "error".',
          );
        }
        if (!this.withinRate(record, "toasts", MOD_TOAST_RATE_LIMIT)) {
          throw new ModManagerError(
            `$.ui.toast: a mod may show at most ${MOD_TOAST_RATE_LIMIT} toasts every ${MOD_RATE_WINDOW_MS / 1000} s.`,
          );
        }
        this.emit({ type: "toast", toast: { id: randomUUID(), modId, text, tone } });
        return undefined;
      }
      case "ui.status": {
        const value = args[0];
        const statusText =
          value === undefined || value === null
            ? null
            : requireText(value, "$.ui.status(text)", MOD_STATUS_TEXT_LIMIT);
        if (statusText !== record.statusText) {
          record.statusText = statusText;
          this.scheduleSnapshot();
        }
        return undefined;
      }
      case "ui.view": {
        const definition = (args[0] ?? {}) as Partial<
          Record<"id" | "site" | "title" | "icon" | "refreshOn", unknown>
        >;
        if (!isViewId(definition.id)) {
          throw new ModManagerError(
            "$.ui.view({ id }): id must be lowercase words joined by dashes, up to 64 characters.",
          );
        }
        if (!isViewSite(definition.site)) {
          throw new ModManagerError(
            '$.ui.view({ site }): site must be "sidebar", "dock", "band" or "header".',
          );
        }
        if (!record.views.has(definition.id) && record.views.size >= MOD_VIEW_LIMIT) {
          throw new ModManagerError(`A mod can register at most ${MOD_VIEW_LIMIT} views.`);
        }
        const refreshOn = Array.isArray(definition.refreshOn)
          ? [...new Set(definition.refreshOn.filter(isRefreshSource))]
          : [];
        const view: ModView = {
          id: definition.id,
          site: definition.site,
          title: requireText(definition.title, "$.ui.view({ title })", 256).trim(),
          icon: this.checkIcon(record, definition.icon),
          refreshOn,
        };
        const previous = record.views.get(view.id);
        if (previous && JSON.stringify(previous) === JSON.stringify(view)) return undefined;
        record.views.set(view.id, view);
        this.scheduleSnapshot();
        if (!isRenderContext(context)) this.scheduleInvalidate(modId, view.id);
        return undefined;
      }
      case "ui.removeView": {
        if (record.views.delete(String(args[0]))) this.scheduleSnapshot();
        return undefined;
      }
      case "ui.invalidate": {
        const viewId = args[0];
        if (viewId !== undefined && viewId !== null && !isViewId(viewId)) {
          throw new ModManagerError(
            "$.ui.invalidate(viewId): viewId must be a view id or nothing.",
          );
        }
        // A view asking to be drawn again while it draws would loop forever.
        if (!isRenderContext(context)) this.scheduleInvalidate(modId, viewId ?? null);
        return undefined;
      }
      case "ui.openThread":
      case "ui.openUrl":
      case "ui.openDockView": {
        if (!isUiCallContext(context)) {
          throw new ModManagerError(
            `$.${method}() works only inside a handler of a view, such as an onPress.`,
          );
        }
        if (method === "ui.openThread") {
          if (!isThreadId(args[0])) {
            throw new ModManagerError("$.ui.openThread(threadId): threadId must be a thread id.");
          }
          context.effects.push({ type: "openThread", threadId: args[0] });
        } else if (method === "ui.openUrl") {
          const url = typeof args[0] === "string" ? args[0] : "";
          if (!/^https?:\/\//iu.test(url) || url.length > MOD_URL_LIMIT) {
            throw new ModManagerError("$.ui.openUrl(url): url must be an http or https address.");
          }
          context.effects.push({ type: "openUrl", url });
        } else {
          const view = record.views.get(String(args[0]));
          if (!view || view.site !== "dock") {
            throw new ModManagerError(
              "$.ui.openDockView(viewId): viewId must name one of this mod's dock views.",
            );
          }
          context.effects.push({ type: "openDockView", modId, viewId: view.id });
        }
        return undefined;
      }
      case "mcp.status": {
        const [name, config] = this.mcpServer(record, args[0]);
        return this.signIns.needsSignIn(modId, name, config) ? "sign-in-needed" : "ready";
      }
      case "mcp.tools":
        return this.mcpClient(record, args[0]).listTools();
      case "mcp.call": {
        const tool = args[1];
        if (typeof tool !== "string" || tool.length === 0) {
          throw new ModManagerError("$.mcp.call(server, tool, args): tool must be a tool name.");
        }
        return this.mcpClient(record, args[0]).callTool(tool, args[2]);
      }
      case "command.register": {
        const definition = args[0] as
          | Partial<Record<"name" | "title" | "description", unknown>>
          | undefined;
        const name = definition?.name;
        if (!isCommandName(name)) {
          throw new ModManagerError(
            "$.command.register({ name }): name must be lowercase words joined by dashes, up to 64 characters.",
          );
        }
        if (!record.commands.has(name) && record.commands.size >= MOD_COMMAND_LIMIT) {
          throw new ModManagerError(`A mod can register at most ${MOD_COMMAND_LIMIT} commands.`);
        }
        const description = definition?.description;
        record.commands.set(name, {
          name,
          title: requireText(definition?.title, "$.command.register({ title })", 256).trim(),
          description:
            typeof description === "string" && description.trim().length > 0
              ? clampText(description.trim(), 1_024)
              : null,
        });
        this.scheduleSnapshot();
        return undefined;
      }
      case "command.unregister": {
        if (record.commands.delete(String(args[0]))) this.scheduleSnapshot();
        return undefined;
      }
      case "tool.register": {
        if (!this.hasPermission(record, "tools")) {
          throw new ModManagerError(
            '$.tool.register: add "tools" to "permissions" in mod.json; the person sees it before enabling the mod.',
          );
        }
        const tool = this.checkAgentTool(record, args[0]);
        record.tools.set(tool.name, tool);
        this.scheduleSnapshot();
        return undefined;
      }
      case "tool.unregister": {
        if (record.tools.delete(String(args[0]))) this.scheduleSnapshot();
        return undefined;
      }
      case "threads.list": {
        const options = (args[0] ?? {}) as Partial<
          Record<"projectId" | "includeArchived" | "limit", unknown>
        >;
        const limit =
          typeof options.limit === "number" && Number.isFinite(options.limit)
            ? Math.max(0, Math.min(Math.trunc(options.limit), MOD_THREAD_LIST_MAX))
            : MOD_THREAD_LIST_DEFAULT;
        const threads = await this.options.backend.listThreads();
        return threads
          .filter(
            (thread) =>
              (options.includeArchived === true || thread.archivedAt === null) &&
              (typeof options.projectId !== "string" || thread.projectId === options.projectId),
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, limit);
      }
      case "threads.get": {
        const threadId = args[0];
        const threads = await this.options.backend.listThreads();
        return threads.find((thread) => thread.id === threadId) ?? null;
      }
      case "projects.list":
        return [...(await this.options.backend.listProjects())];
      case "state.get":
        return this.state.get(modId)?.get(requireKey(args[0], "$.state.get(key)"));
      case "state.set": {
        const key = requireKey(args[0], "$.state.set(key, value)");
        let values = this.state.get(modId);
        let sizes = this.stateSizes.get(modId);
        if (!values || !sizes) {
          values = new Map();
          sizes = new Map();
          this.state.set(modId, values);
          this.stateSizes.set(modId, sizes);
        }
        const value = args[1];
        let serialized: string | undefined;
        try {
          serialized = value === undefined ? undefined : JSON.stringify(value);
        } catch {
          throw new ModManagerError("$.state.set(key, value): the value must be plain JSON.");
        }
        const previousSize = sizes.get(key);
        if (serialized === undefined) {
          if (!values.has(key)) return undefined;
          values.delete(key);
          sizes.delete(key);
        } else {
          const nextSize = entryBytes(key, serialized);
          // Setting what is already there changes nothing and draws nothing.
          if (previousSize === nextSize && JSON.stringify(values.get(key)) === serialized) {
            return undefined;
          }
          if (!values.has(key) && values.size >= MOD_STATE_ENTRY_LIMIT) {
            throw new ModManagerError(
              `A mod can hold at most ${MOD_STATE_ENTRY_LIMIT} state values.`,
            );
          }
          let total = nextSize - (previousSize ?? 0);
          for (const size of sizes.values()) total += size;
          if (total > MOD_STATE_BYTES_LIMIT) {
            throw new ModManagerError(
              `A mod's state is limited to ${MOD_STATE_BYTES_LIMIT / 1_000_000} MB.`,
            );
          }
          values.set(key, value);
          sizes.set(key, nextSize);
        }
        // Views draw from state, so a change redraws them; not the view that is drawing now.
        if (!isRenderContext(context)) this.scheduleInvalidate(modId, null);
        return undefined;
      }
      case "store.get": {
        const store = await this.loadStore(modId);
        return store.values[requireKey(args[0], "$.store.get(key)")];
      }
      case "store.keys":
        return Object.keys((await this.loadStore(modId)).values);
      case "store.set":
      case "store.delete": {
        const call = method === "store.set" ? "$.store.set(key, value)" : "$.store.delete(key)";
        const key = requireKey(args[0], call);
        const store = await this.loadStore(modId);
        // Everything below is synchronous, so writes in parallel cannot undo each other.
        let serialized: string | undefined;
        if (method === "store.set" && args[1] !== undefined) {
          try {
            serialized = JSON.stringify(args[1]);
          } catch {
            throw new ModManagerError(`${call}: the value must be plain JSON.`);
          }
        }
        const previousSize = store.sizes.get(key) ?? 0;
        if (serialized === undefined) {
          if (!(key in store.values)) return undefined;
          delete store.values[key];
          store.sizes.delete(key);
          store.bytes -= previousSize;
        } else {
          const nextSize = entryBytes(key, serialized);
          if (store.bytes - previousSize + nextSize > MOD_STORE_BYTES_LIMIT) {
            throw new ModManagerError(
              `A mod's store is limited to ${MOD_STORE_BYTES_LIMIT / 1_000_000} MB.`,
            );
          }
          store.values[key] = JSON.parse(serialized) as unknown;
          store.sizes.set(key, nextSize);
          store.bytes += nextSize - previousSize;
        }
        this.scheduleStoreFlush(modId);
        return undefined;
      }
      default:
        throw new ModManagerError(`$.${method} is not available in this version of Synara.`);
    }
  }

  // ── Persistence ────────────────────────────────────────────────────

  private registryFile(): string {
    return path.join(this.options.dataDir, "registry.json");
  }

  private storeDir(): string {
    return path.join(this.options.dataDir, "store");
  }

  /** Reads the enabled mods and what was trusted of each; older files listed only their ids. */
  private async readRegistry(): Promise<Map<string, string | null>> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.registryFile(), "utf8")) as {
        readonly enabled?: unknown;
        readonly mods?: unknown;
      };
      const registry = new Map<string, string | null>();
      if (Array.isArray(parsed.enabled)) {
        for (const id of parsed.enabled) if (typeof id === "string") registry.set(id, null);
      }
      if (parsed.mods !== null && typeof parsed.mods === "object" && !Array.isArray(parsed.mods)) {
        for (const [id, entry] of Object.entries(parsed.mods as Record<string, unknown>)) {
          const hash = (entry as { readonly hash?: unknown } | null)?.hash;
          registry.set(id, typeof hash === "string" ? hash : null);
        }
      }
      return registry;
    } catch {
      return new Map();
    }
  }

  private writeRegistry(trusted: ReadonlyMap<string, string | null>): Promise<void> {
    const contents = JSON.stringify(
      {
        version: REGISTRY_VERSION,
        mods: Object.fromEntries(
          [...trusted]
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([id, hash]) => [id, { hash }]),
        ),
      },
      null,
      2,
    );
    this.registryWrite = this.registryWrite
      .catch(() => undefined)
      .then(() => writeFileAtomically(this.registryFile(), `${contents}\n`));
    return this.registryWrite;
  }

  private loadStore(modId: string): Promise<ModStore> {
    let store = this.stores.get(modId);
    if (!store) {
      store = fs
        .readFile(path.join(this.storeDir(), `${modId}.json`), "utf8")
        .then((text) => {
          const parsed = JSON.parse(text) as unknown;
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        })
        .catch((): Record<string, unknown> => ({}))
        .then((values) => {
          const sizes = new Map<string, number>();
          let bytes = 0;
          for (const [key, value] of Object.entries(values)) {
            const size = entryBytes(key, JSON.stringify(value) ?? "null");
            sizes.set(key, size);
            bytes += size;
          }
          return { values, sizes, bytes };
        });
      this.stores.set(modId, store);
    }
    return store;
  }

  /** Writes a mod's store once a burst of changes has settled. */
  private scheduleStoreFlush(modId: string): void {
    if (this.storeFlushTimers.has(modId)) return;
    this.storeFlushTimers.set(
      modId,
      setTimeout(() => this.flushStore(modId), MOD_STORE_FLUSH_MS),
    );
  }

  private flushStore(modId: string): void {
    const timer = this.storeFlushTimers.get(modId);
    if (timer !== undefined) clearTimeout(timer);
    this.storeFlushTimers.delete(modId);
    const store = this.stores.get(modId);
    if (!store) return;
    void store.then((loaded) => this.writeStore(modId, JSON.stringify(loaded.values)));
  }

  private writeStore(modId: string, serialized: string): Promise<void> {
    const previous = this.storeWrites.get(modId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => writeFileAtomically(path.join(this.storeDir(), `${modId}.json`), serialized));
    this.storeWrites.set(modId, next);
    return next;
  }

  // ── Watching ───────────────────────────────────────────────────────

  private startWatching(): void {
    try {
      this.watcher = watch(this.options.modsDir, { recursive: true }, (_event, filename) => {
        const segments = typeof filename === "string" ? filename.split(/[\\/]/u) : [];
        const [id] = segments;
        if (!id || id.startsWith(".") || !isModId(id)) return;
        if (segments.some((segment) => segment === "node_modules" || segment === ".git")) return;
        this.scheduleRefresh(id);
      });
      this.watcher.on("error", (error) => {
        this.options.backend.log("", "warn", `Stopped watching the mods folder: ${error.message}`);
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (error) {
      this.options.backend.log(
        "",
        "warn",
        `Mods will not reload when their files change: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * A mod whose folder is a link (to a repository, while it is being written)
   * changes where the mods folder's watcher does not look; watch its real folder.
   */
  private async watchLinkedMod(id: string, root: string): Promise<void> {
    if (this.watcher === null) return;
    const target = await fs
      .lstat(root)
      .then((stat) => (stat.isSymbolicLink() ? fs.realpath(root) : null))
      .catch(() => null);
    const current = this.linkWatchers.get(id);
    if ((current?.target ?? null) === target) return;
    current?.watcher.close();
    this.linkWatchers.delete(id);
    if (target === null) return;
    try {
      const watcher = watch(target, { recursive: true }, (_event, filename) => {
        const segments = typeof filename === "string" ? filename.split(/[\\/]/u) : [];
        if (segments.some((segment) => segment === "node_modules" || segment === ".git")) return;
        this.scheduleRefresh(id);
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.linkWatchers.get(id)?.watcher === watcher) this.linkWatchers.delete(id);
      });
      this.linkWatchers.set(id, { target, watcher });
    } catch {
      // Without a watcher the mod still reloads from Settings.
    }
  }

  private scheduleRefresh(id: string): void {
    const pending = this.refreshTimers.get(id);
    if (pending !== undefined) clearTimeout(pending);
    this.refreshTimers.set(
      id,
      setTimeout(() => {
        this.refreshTimers.delete(id);
        void this.refreshMod(id, { restart: true, onlyIfChanged: true });
      }, MOD_RELOAD_DEBOUNCE_MS),
    );
  }

  // ── Events ─────────────────────────────────────────────────────────

  /** Counts one more toast or log line in the mod's current window; false past the limit. */
  private withinRate(record: ModRecord, kind: "toasts" | "logs", limit: number): boolean {
    const now = Date.now();
    if (now - record.rate.windowStart > MOD_RATE_WINDOW_MS) {
      const dropped = record.rate.droppedLogs;
      record.rate = { windowStart: now, toasts: 0, logs: 0, droppedLogs: 0 };
      if (dropped > 0) {
        this.appendLog(
          record,
          "warn",
          `${dropped} log lines were dropped: the mod logged too fast.`,
        );
      }
    }
    if (record.rate[kind] >= limit) return false;
    record.rate[kind] += 1;
    return true;
  }

  private appendLog(record: ModRecord, level: ModLogLevel, message: string): void {
    if (!this.withinRate(record, "logs", MOD_LOG_RATE_LIMIT)) {
      record.rate.droppedLogs += 1;
      return;
    }
    const text = clampText(message, MOD_LOG_TEXT_LIMIT);
    record.logs.push({ at: new Date().toISOString(), level, message: text });
    if (record.logs.length > MOD_LOG_LIMIT)
      record.logs.splice(0, record.logs.length - MOD_LOG_LIMIT);
    this.options.backend.log(record.definition.id, level, text);
  }

  private toSummary(record: ModRecord): ModSummary {
    const { definition } = record;
    return {
      id: definition.id,
      version: definition.manifest?.version ?? "",
      description: definition.manifest?.description ?? null,
      path: definition.root,
      enabled: record.enabled,
      status: record.status,
      error: definition.error ?? record.runtimeError,
      hooks: [...new Set((record.host?.hooks ?? []).map((hook) => hook.event))],
      commands: [...record.commands.values()],
      tools: [...record.tools.values()].map((tool) => ({
        name: tool.name,
        servedName: tool.servedName,
        description: tool.description,
      })),
      views: [...record.views.values()],
      pullRequestSources: this.pullRequests.summaries(definition.id),
      mcpServers: Object.keys(definition.manifest?.mcpServers ?? {}),
      mcpSignIns: this.signIns.summary(definition.id, definition.manifest?.mcpServers),
      permissions: [...new Set(definition.manifest?.permissions ?? [])],
      reloadsOnChange: this.reloadGrants.has(definition.id),
      statusText: record.statusText,
      loadedAt: record.loadedAt,
    };
  }

  private emit(event: ModsStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Asks the windows to draw a view again (all of the mod's views for null),
   * once per burst: each `$` call arrives as its own message, so a microtask
   * would not join them.
   */
  private scheduleInvalidate(modId: string, viewId: string | null): void {
    const allKey = `${modId}\u0000`;
    if (this.invalidateTimers.has(allKey)) return;
    const key = viewId === null ? allKey : `${modId}\u0000${viewId}`;
    if (this.invalidateTimers.has(key)) return;
    if (viewId === null) {
      // One redraw of every view covers the single-view requests already waiting.
      for (const [pending, timer] of this.invalidateTimers) {
        if (pending.startsWith(allKey)) {
          clearTimeout(timer);
          this.invalidateTimers.delete(pending);
        }
      }
    }
    this.invalidateTimers.set(
      key,
      setTimeout(() => {
        this.invalidateTimers.delete(key);
        if (!this.stopped) this.emit({ type: "invalidate", modId, viewId });
      }, MOD_INVALIDATE_COALESCE_MS),
    );
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer !== null || this.stopped) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.emit({ type: "snapshot", snapshot: this.snapshot() });
    }, MOD_SNAPSHOT_COALESCE_MS);
  }
}
