// FILE: modWorker.ts
// Purpose: Worker entry that loads one mod's hooks module and runs its hooks on request.
// Layer: Mods runtime. Runs inside a worker thread under Bun (development) and
//        Node (tests, packaged app), so it uses only erasable TypeScript syntax
//        and imports nothing from the server but the protocol.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

import { transform, type Transform } from "sucrase";

import {
  MOD_API_METHODS,
  MOD_SDK_SPECIFIERS,
  describeModError,
  type HostToWorkerMessage,
  type ModCallOutcome,
  type ModHookRegistration,
  type ModWorkerData,
  type WorkerToHostMessage,
} from "./modProtocol.ts";

const data = workerData as ModWorkerData;
const port = parentPort;
if (!port) {
  throw new Error("modWorker.ts must run inside a worker thread.");
}

const post = (message: WorkerToHostMessage): void => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not window.postMessage
  port.postMessage(message);
};

// ── Elements ─────────────────────────────────────────────────────────
// JSX compiles against `h`; a tree is plain data the host can clone.

interface ModElement {
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: ReadonlyArray<unknown>;
}

function h(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): ModElement {
  return {
    type,
    props: props ?? {},
    children: children
      .flat(Number.POSITIVE_INFINITY)
      .filter((child) => child !== null && child !== undefined && typeof child !== "boolean"),
  };
}
const Fragment = "Fragment";
Object.assign(globalThis, { h, Fragment });

const sdk = Object.freeze({ h, Fragment });

// ── Module loading ───────────────────────────────────────────────────
// A mod imports its own files and the SDK, nothing else, so everything it does
// outside itself goes through `$`. Files are compiled to CommonJS with sucrase
// and evaluated here; `.js` specifiers also find the `.ts` file they name.

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SPECIFIER_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

interface LoadedModule {
  exports: Record<string, unknown>;
}

const moduleCache = new Map<string, LoadedModule>();
const modRoot = fs.realpathSync(data.root);
const modRootUrl = pathToFileURL(modRoot).href;

/** An error as the mod's author needs it: the message and the stack frames in the mod's own files. */
function describeForMod(error: unknown): string {
  if (!(error instanceof Error)) return describeModError(error);
  const frames = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .filter((line) => line.includes(modRootUrl) || line.includes(modRoot));
  return [`${error.name}: ${error.message}`, ...frames].join("\n");
}

function isInsideRoot(file: string): boolean {
  const relative = path.relative(modRoot, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function existingFile(candidate: string): string | null {
  try {
    return fs.statSync(candidate).isFile() ? fs.realpathSync(candidate) : null;
  } catch {
    return null;
  }
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const extension = path.extname(base);
  const candidates = [base];
  for (const alias of SPECIFIER_ALIASES[extension] ?? []) {
    candidates.push(base.slice(0, -extension.length) + alias);
  }
  for (const sourceExtension of [...SOURCE_EXTENSIONS, ".json"]) {
    candidates.push(base + sourceExtension);
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    candidates.push(path.join(base, `index${sourceExtension}`));
  }
  for (const candidate of candidates) {
    const file = existingFile(candidate);
    if (file === null) continue;
    if (!isInsideRoot(file)) {
      throw new Error(`"${specifier}" resolves outside the mod's folder.`);
    }
    return file;
  }
  throw new Error(`Cannot find "${specifier}" imported from ${path.relative(modRoot, fromFile)}.`);
}

function requireFrom(fromFile: string, specifier: string): unknown {
  if (MOD_SDK_SPECIFIERS.has(specifier)) return sdk;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return loadModule(resolveRelative(fromFile, specifier));
  }
  throw new Error(
    `Mods can import only their own files and "synara"; "${specifier}" is not allowed. Reach Synara through $.`,
  );
}

function compile(file: string, source: string): string {
  const transforms: Transform[] = ["imports"];
  if (/\.[cm]?tsx?$/u.test(file)) transforms.push("typescript");
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) transforms.push("jsx");
  try {
    return transform(source, {
      transforms,
      filePath: file,
      jsxPragma: "h",
      jsxFragmentPragma: "Fragment",
      production: true,
      disableESTransforms: true,
    }).code;
  } catch (error) {
    // Sucrase reports "Error transforming <path>: <problem> (line:column)"; keep the problem.
    const problem = (error instanceof Error ? error.message : String(error)).replace(
      /^Error transforming [^:]*: /u,
      "",
    );
    const syntaxError = new SyntaxError(`${path.relative(modRoot, file)}: ${problem}`);
    syntaxError.stack = `SyntaxError: ${syntaxError.message}`;
    throw syntaxError;
  }
}

function loadModule(file: string): Record<string, unknown> {
  const cached = moduleCache.get(file);
  if (cached) return cached.exports;
  const source = fs.readFileSync(file, "utf8");
  const loaded: LoadedModule = { exports: {} };
  moduleCache.set(file, loaded);
  if (file.endsWith(".json")) {
    loaded.exports = JSON.parse(source) as Record<string, unknown>;
    return loaded.exports;
  }
  const code = compile(file, source);
  const evaluate = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    `${code}\n//# sourceURL=${pathToFileURL(file).href}`,
  ) as (
    exports: Record<string, unknown>,
    require: (specifier: string) => unknown,
    module: LoadedModule,
    filename: string,
    dirname: string,
  ) => void;
  evaluate(
    loaded.exports,
    (specifier) => requireFrom(file, specifier),
    loaded,
    file,
    path.dirname(file),
  );
  return loaded.exports;
}

// ── The `$` interface ────────────────────────────────────────────────

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const pendingApi = new Map<number, Pending>();
let nextRequestId = 1;

function callApi(method: string, args: ReadonlyArray<unknown>): Promise<unknown> {
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    pendingApi.set(requestId, { resolve, reject });
    try {
      post({ type: "api", requestId, method, args });
    } catch {
      pendingApi.delete(requestId);
      reject(
        new Error(`$.${method}: arguments must be plain data (no functions or class instances).`),
      );
    }
  });
}

function buildApi(): unknown {
  const namespaces: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const method of MOD_API_METHODS) {
    const [namespace, name] = method.split(".") as [string, string];
    const target = (namespaces[namespace] ??= {});
    target[name] = (...args: unknown[]) => callApi(method, args);
  }
  const logNamespace = namespaces.log ?? {};
  const log = Object.assign((message: unknown) => logNamespace.info?.(message), logNamespace);
  return Object.freeze({
    mod: Object.freeze({ id: data.modId, version: data.version }),
    ...Object.fromEntries(
      Object.entries(namespaces).map(([namespace, methods]) => [namespace, Object.freeze(methods)]),
    ),
    log: Object.freeze(log),
  });
}

const api = buildApi();

// Console output from the mod lands in its log instead of the server's terminal.
const forwardConsole =
  (method: "log.info" | "log.warn" | "log.error") =>
  (...args: unknown[]): void => {
    const message = args
      .map((arg) => (typeof arg === "string" ? arg : describeModError(arg)))
      .join(" ");
    void callApi(method, [message]).catch(() => undefined);
  };
globalThis.console.log = forwardConsole("log.info");
globalThis.console.info = forwardConsole("log.info");
globalThis.console.debug = forwardConsole("log.info");
globalThis.console.warn = forwardConsole("log.warn");
globalThis.console.error = forwardConsole("log.error");

// ── Hooks ────────────────────────────────────────────────────────────

type HookFunction = ($: unknown, e: unknown, next: (e?: unknown) => Promise<unknown>) => unknown;

interface RegisteredHook extends ModHookRegistration {
  readonly fn: HookFunction;
}

const hooks = new Map<number, RegisteredHook>();
let nextHookId = 1;
let registering = true;

function on(event: unknown, matcherOrHook: unknown, maybeHook?: unknown): void {
  if (!registering) {
    throw new Error("on() works only while register() runs.");
  }
  if (typeof event !== "string" || event.length === 0) {
    throw new TypeError("on(event, …): event must be a non-empty string.");
  }
  const fn = typeof matcherOrHook === "function" ? matcherOrHook : maybeHook;
  const matcher = typeof matcherOrHook === "function" ? null : (matcherOrHook ?? null);
  if (typeof fn !== "function") {
    throw new TypeError(`on("${event}", …): the hook must be a function.`);
  }
  if (matcher !== null && (typeof matcher !== "object" || Array.isArray(matcher))) {
    throw new TypeError(`on("${event}", matcher, hook): the matcher must be an object.`);
  }
  try {
    structuredClone(matcher);
  } catch {
    throw new TypeError(`on("${event}", matcher, hook): the matcher must be plain data.`);
  }
  const hookId = nextHookId++;
  hooks.set(hookId, { hookId, event, matcher, fn: fn as HookFunction });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const pendingNext = new Map<string, Pending>();

function settle(pending: Pending | undefined, outcome: ModCallOutcome): void {
  if (!pending) return;
  if (outcome.ok) pending.resolve(outcome.value);
  else pending.reject(new Error(outcome.error));
}

async function invoke(callId: number, hookId: number, input: unknown): Promise<void> {
  const hook = hooks.get(hookId);
  if (!hook) {
    post({ type: "invoke-result", callId, ok: false, error: `Unknown hook ${hookId}.` });
    return;
  }
  let nextCount = 0;
  const next = (override?: unknown): Promise<unknown> => {
    const nextId = ++nextCount;
    const key = `${callId}:${nextId}`;
    return new Promise((resolve, reject) => {
      pendingNext.set(key, { resolve, reject });
      try {
        post({ type: "next", callId, nextId, input: override === undefined ? input : override });
      } catch {
        pendingNext.delete(key);
        reject(new Error(`next(e) in a "${hook.event}" hook: the event must be plain data.`));
      }
    });
  };
  let outcome: ModCallOutcome;
  try {
    const value = await hook.fn(api, deepFreeze(input), next);
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error: describeForMod(error) };
  }
  try {
    post({ type: "invoke-result", callId, ...outcome });
  } catch {
    post({
      type: "invoke-result",
      callId,
      ok: false,
      error: `A "${hook.event}" hook returned a value that is not plain data.`,
    });
  }
}

port.on("message", (message: HostToWorkerMessage) => {
  switch (message.type) {
    case "invoke":
      void invoke(message.callId, message.hookId, message.input);
      return;
    case "next-result": {
      const key = `${message.callId}:${message.nextId}`;
      const pending = pendingNext.get(key);
      pendingNext.delete(key);
      settle(pending, message);
      return;
    }
    case "api-result": {
      const pending = pendingApi.get(message.requestId);
      pendingApi.delete(message.requestId);
      settle(pending, message);
      return;
    }
    case "ping":
      post({ type: "pong", pingId: message.pingId });
      return;
  }
});

// A mod's stray rejection or throw is logged, not fatal: the other hooks keep working.
process.on("unhandledRejection", (reason) => {
  post({ type: "uncaught", error: describeForMod(reason) });
});
process.on("uncaughtException", (error) => {
  post({ type: "uncaught", error: describeForMod(error) });
});

// ── Start ────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    const entry = existingFile(data.entry);
    if (entry === null || !isInsideRoot(entry)) {
      throw new Error("The hooks module named in hooks/hooks.json is missing or outside the mod.");
    }
    const exports = loadModule(entry);
    const register =
      typeof exports.register === "function"
        ? exports.register
        : typeof exports.default === "function"
          ? exports.default
          : null;
    if (register === null) {
      throw new Error("The hooks module must export a register(on, options) function.");
    }
    await (register as (on: unknown, options: unknown) => unknown)(
      on,
      Object.freeze({ ...data.options }),
    );
    registering = false;
    post({
      type: "ready",
      hooks: [...hooks.values()].map(({ hookId, event, matcher }) => ({ hookId, event, matcher })),
    });
  } catch (error) {
    registering = false;
    post({ type: "load-failed", error: describeForMod(error) });
  }
}

void start();
