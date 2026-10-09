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
  type ModLogEntry,
  type ModLogLevel,
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
import { packModFolder, readModBundle, writeModFiles } from "./modBundle.ts";
import { listModFolders, readModDefinition, type ModDefinition } from "./modDiscovery.ts";
import { ModWorkerHost, resolveModWorkerUrl } from "./modWorkerHost.ts";
import { normalizeModUiTree } from "./modUiTree.ts";
import { ModMcpClient } from "./modMcpClient.ts";

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
const MOD_TOAST_RATE_LIMIT = 5;
const MOD_LOG_RATE_LIMIT = 200;
const MOD_URL_LIMIT = 2_048;
const REGISTRY_VERSION = 1;
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
}

export type ModViewSource = ModView["refreshOn"][number];

export class ModManagerError extends Error {
  override readonly name = "ModManagerError";
}

interface ModRecord {
  definition: ModDefinition;
  enabled: boolean;
  status: ModStatus;
  runtimeError: string | null;
  host: ModWorkerHost | null;
  /** Bumped on every start and stop, so late answers from an old worker are ignored. */
  generation: number;
  readonly commands: Map<string, ModCommand>;
  readonly views: Map<string, ModView>;
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
  private enabledIds = new Set<string>();
  private registryWrite: Promise<void> = Promise.resolve();
  /** Imports run one after another, so two cannot install the same name at once. */
  private imports: Promise<unknown> = Promise.resolve();
  private watcher: FSWatcher | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private workerUrl: URL | null;
  private started = false;
  private stopped = false;

  constructor(options: ModManagerOptions) {
    this.options = options;
    this.workerUrl = options.workerUrl ?? null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Reads the mods folder and starts the enabled mods without waiting for them to load. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await fs.mkdir(this.options.modsDir, { recursive: true });
    await fs.mkdir(this.storeDir(), { recursive: true });
    this.enabledIds = await this.readRegistry();
    const folders = await listModFolders(this.options.modsDir);
    // Trust belongs to a mod that exists; a later folder with that name is new code.
    const present = new Set(folders.map((folder) => path.basename(folder)));
    const kept = new Set([...this.enabledIds].filter((id) => present.has(id)));
    if (kept.size !== this.enabledIds.size) await this.writeRegistry(kept);
    this.enabledIds = kept;
    for (const folder of folders) {
      await this.refreshMod(path.basename(folder), { restart: false });
    }
    if (this.options.watch !== false) this.startWatching();
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
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    for (const timer of this.invalidateTimers.values()) clearTimeout(timer);
    this.invalidateTimers.clear();
    // Deleting the entry being visited is safe while iterating a Map.
    for (const modId of this.storeFlushTimers.keys()) this.flushStore(modId);
    if (this.snapshotTimer !== null) clearTimeout(this.snapshotTimer);
    await Promise.all(
      [...this.records.values()].map((record) =>
        this.transition(record, () => this.stopRecord(record)),
      ),
    );
    await Promise.all([this.registryWrite, ...this.storeWrites.values()]);
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

  async setEnabled(id: string, enabled: boolean): Promise<ModsSnapshot> {
    const record = this.requireRecord(id);
    if (record.enabled !== enabled) {
      // Save first: if the disk refuses, nothing changed and the toggle can be tried again.
      const next = new Set(this.enabledIds);
      if (enabled) next.add(id);
      else next.delete(id);
      await this.writeRegistry(next);
      this.enabledIds = next;
      record.enabled = enabled;
      await this.transition(record, () =>
        enabled ? this.startRecord(record) : this.stopRecord(record),
      );
    }
    return this.snapshot();
  }

  /** Reads the mod's files again and, when it is enabled, restarts it. */
  async reload(id: string): Promise<ModsSnapshot> {
    this.requireRecord(id);
    await this.refreshMod(id, { restart: true });
    await this.records.get(id)?.transition;
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

      // New code is never trusted on the old code's behalf.
      if (this.records.get(id)?.enabled) await this.setEnabled(id, false);
      else if (this.enabledIds.has(id)) {
        const next = new Set(this.enabledIds);
        next.delete(id);
        await this.writeRegistry(next);
        this.enabledIds = next;
      }

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

  private mcpClient(record: ModRecord, server: unknown): ModMcpClient {
    const servers = record.definition.manifest?.mcpServers ?? {};
    if (typeof server !== "string" || !Object.hasOwn(servers, server)) {
      const declared = Object.keys(servers);
      throw new ModManagerError(
        `$.mcp: "${String(server)}" is not one of this mod's MCP servers (${
          declared.length > 0 ? declared.join(", ") : "it declares none in mod.json"
        }).`,
      );
    }
    let client = record.mcp.get(server);
    if (!client) {
      client = new ModMcpClient(server, servers[server]!);
      record.mcp.set(server, client);
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

  private async refreshMod(id: string, options: { readonly restart: boolean }): Promise<void> {
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
      // A folder that comes back under this name is new code; it starts off.
      if (this.enabledIds.has(id)) {
        const next = new Set(this.enabledIds);
        next.delete(id);
        await this.writeRegistry(next);
        this.enabledIds = next;
      }
      return;
    }
    if (!existing) {
      const record: ModRecord = {
        definition,
        enabled: this.enabledIds.has(id),
        status: "disabled",
        runtimeError: null,
        host: null,
        generation: 0,
        commands: new Map(),
        views: new Map(),
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
    existing.definition = definition;
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
    record.unknownIcons.clear();
    await this.closeMcp(record);
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
    return host.hooks
      .filter((hook) => hook.event === event && matchesModEvent(hook.matcher, input))
      .map((hook) => ({ record, host, hookId: hook.hookId }));
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

  private async readRegistry(): Promise<Set<string>> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.registryFile(), "utf8")) as {
        readonly enabled?: unknown;
      };
      return new Set(
        Array.isArray(parsed.enabled)
          ? parsed.enabled.filter((id): id is string => typeof id === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  }

  private writeRegistry(enabledIds: ReadonlySet<string>): Promise<void> {
    const contents = JSON.stringify(
      { version: REGISTRY_VERSION, enabled: [...enabledIds].toSorted() },
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

  private scheduleRefresh(id: string): void {
    const pending = this.refreshTimers.get(id);
    if (pending !== undefined) clearTimeout(pending);
    this.refreshTimers.set(
      id,
      setTimeout(() => {
        this.refreshTimers.delete(id);
        void this.refreshMod(id, { restart: true });
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
      views: [...record.views.values()],
      mcpServers: Object.keys(definition.manifest?.mcpServers ?? {}),
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
