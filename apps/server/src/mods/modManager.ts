// FILE: modManager.ts
// Purpose: Owns every mod: finds them, starts the enabled ones, reloads them when
//          their files change, runs hook chains and answers their `$` calls.
// Layer: Mods runtime (plain promises; the ModHost layer adapts it to Effect and RPC)

import { randomUUID } from "node:crypto";
import { type FSWatcher, promises as fs, watch } from "node:fs";
import * as path from "node:path";

import {
  ModCommandName,
  ModToastTone,
  type ModCommand,
  type ModLogEntry,
  type ModLogLevel,
  type ModsReadLogsResult,
  type ModsRunCommandResult,
  type ModsSnapshot,
  type ModsStreamEvent,
  type ModStatus,
  type ModSummary,
} from "@synara/contracts";
import { Schema } from "effect";

import type { ModProject, ModThread } from "./modApi.ts";
import { listModFolders, readModDefinition, type ModDefinition } from "./modDiscovery.ts";
import { ModWorkerHost, resolveModWorkerUrl } from "./modWorkerHost.ts";

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
const REGISTRY_VERSION = 1;

const isCommandName = Schema.is(ModCommandName);
const isToastTone = Schema.is(ModToastTone);

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
  /** Reload a mod when its files change. Defaults to true. */
  readonly watch?: boolean;
}

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
  statusText: string | null;
  loadedAt: string | null;
  readonly logs: ModLogEntry[];
  /** Starts and stops of one mod run one after another. */
  transition: Promise<void>;
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
  /** `$.store`, loaded from disk on first use. */
  private readonly stores = new Map<string, Promise<Record<string, unknown>>>();
  private readonly storeWrites = new Map<string, Promise<void>>();
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private enabledIds = new Set<string>();
  private registryWrite: Promise<void> = Promise.resolve();
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
    for (const folder of await listModFolders(this.options.modsDir)) {
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
      record.enabled = enabled;
      if (enabled) this.enabledIds.add(id);
      else this.enabledIds.delete(id);
      await this.writeRegistry();
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
    const result = await this.runChain(
      "command.run",
      input,
      this.hooksOf(record, "command.run", input),
      async () => undefined,
    );
    const text =
      result !== null &&
      typeof result === "object" &&
      typeof (result as { text?: unknown }).text === "string"
        ? clampText((result as { text: string }).text, MOD_TOAST_TEXT_LIMIT)
        : null;
    return { text: text !== null && text.trim().length > 0 ? text : null };
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

  // ── Records ────────────────────────────────────────────────────────

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
    if (this.stopped) return;
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
        this.scheduleSnapshot();
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
        statusText: null,
        loadedAt: null,
        logs: [],
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
    record.generation += 1;
    const generation = record.generation;
    record.commands.clear();
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
        },
        workerUrl: await this.resolveWorkerUrl(),
        ...(this.options.loadTimeoutMs === undefined
          ? {}
          : { loadTimeoutMs: this.options.loadTimeoutMs }),
        ...(this.options.hookTimeoutMs === undefined
          ? {}
          : { hookTimeoutMs: this.options.hookTimeoutMs }),
        handleApi: (method, args) => this.handleApi(record, generation, method, args),
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
    record.statusText = null;
    this.appendLog(record, "error", reason);
    this.scheduleSnapshot();
  }

  private async resolveWorkerUrl(): Promise<URL> {
    this.workerUrl ??= await resolveModWorkerUrl();
    return this.workerUrl;
  }

  // ── Hook chains ────────────────────────────────────────────────────

  private hooksOf(record: ModRecord, event: string, input: unknown): HookEntry[] {
    const host = record.host;
    if (host === null || !host.isAlive) return [];
    return host.hooks
      .filter((hook) => hook.event === event && matchesModEvent(hook.matcher, input))
      .map((hook) => ({ record, host, hookId: hook.hookId }));
  }

  private runChain(
    event: string,
    input: unknown,
    entries: ReadonlyArray<HookEntry>,
    fallback: (input: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const step = async (index: number, current: unknown): Promise<unknown> => {
      const entry = entries[index];
      if (!entry) return fallback(current);
      const downstream: { current: Promise<unknown> | null } = { current: null };
      const outcome = await entry.host.invoke(entry.hookId, current, (nextInput) => {
        downstream.current = step(index + 1, nextInput);
        return downstream.current;
      });
      if (outcome.kind === "result") return outcome.value;
      this.appendLog(entry.record, "error", `A "${event}" hook failed: ${outcome.error}`);
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
        this.emit({ type: "toast", toast: { id: randomUUID(), modId, text, tone } });
        return undefined;
      }
      case "ui.status": {
        const value = args[0];
        record.statusText =
          value === undefined || value === null
            ? null
            : requireText(value, "$.ui.status(text)", MOD_STATUS_TEXT_LIMIT);
        this.scheduleSnapshot();
        return undefined;
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
        if (!values) {
          values = new Map();
          this.state.set(modId, values);
        }
        if (args[1] === undefined) {
          values.delete(key);
        } else {
          if (!values.has(key) && values.size >= MOD_STATE_ENTRY_LIMIT) {
            throw new ModManagerError(
              `A mod can hold at most ${MOD_STATE_ENTRY_LIMIT} state values.`,
            );
          }
          values.set(key, args[1]);
        }
        return undefined;
      }
      case "store.get": {
        const store = await this.loadStore(modId);
        return store[requireKey(args[0], "$.store.get(key)")];
      }
      case "store.keys":
        return Object.keys(await this.loadStore(modId));
      case "store.set":
      case "store.delete": {
        const call = method === "store.set" ? "$.store.set(key, value)" : "$.store.delete(key)";
        const key = requireKey(args[0], call);
        const store = { ...(await this.loadStore(modId)) };
        if (method === "store.delete" || args[1] === undefined) {
          delete store[key];
        } else {
          store[key] = args[1];
        }
        let serialized: string;
        try {
          serialized = JSON.stringify(store);
        } catch {
          throw new ModManagerError(`${call}: the value must be plain JSON.`);
        }
        if (serialized.length > MOD_STORE_BYTES_LIMIT) {
          throw new ModManagerError(
            `A mod's store is limited to ${MOD_STORE_BYTES_LIMIT / 1_000_000} MB.`,
          );
        }
        this.stores.set(modId, Promise.resolve(JSON.parse(serialized) as Record<string, unknown>));
        await this.writeStore(modId, serialized);
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

  private writeRegistry(): Promise<void> {
    const contents = JSON.stringify(
      { version: REGISTRY_VERSION, enabled: [...this.enabledIds].toSorted() },
      null,
      2,
    );
    this.registryWrite = this.registryWrite
      .catch(() => undefined)
      .then(() => writeFileAtomically(this.registryFile(), `${contents}\n`));
    return this.registryWrite;
  }

  private loadStore(modId: string): Promise<Record<string, unknown>> {
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
        .catch(() => ({}));
      this.stores.set(modId, store);
    }
    return store;
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
        if (!id || id.startsWith(".")) return;
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

  private appendLog(record: ModRecord, level: ModLogLevel, message: string): void {
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
      statusText: record.statusText,
      loadedAt: record.loadedAt,
    };
  }

  private emit(event: ModsStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer !== null || this.stopped) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.emit({ type: "snapshot", snapshot: this.snapshot() });
    }, MOD_SNAPSHOT_COALESCE_MS);
  }
}
