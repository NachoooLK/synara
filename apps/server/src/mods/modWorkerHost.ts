// FILE: modWorkerHost.ts
// Purpose: The server's handle on one mod worker: start it, run its hooks with a
//          deadline, answer its `$` calls and notice when it dies or hangs.
// Layer: Mods runtime (plain promises; ModManager owns the lifecycle)

import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  describeModError,
  type HostToWorkerMessage,
  type ModHookRegistration,
  type ModWorkerData,
  type WorkerToHostMessage,
} from "./modProtocol.ts";

/** How long `register()` may take before the mod counts as failed. */
export const MOD_LOAD_TIMEOUT_MS = 10_000;
/** How long one hook may run, not counting the time it waits on `next`. */
export const MOD_HOOK_TIMEOUT_MS = 10_000;
/** How long a worker has to answer a ping after a hook overran. */
const MOD_PING_TIMEOUT_MS = 1_000;
/** Heap ceiling per mod worker, so one mod cannot exhaust the server's memory. */
const MOD_WORKER_MAX_OLD_GENERATION_MB = 256;

/**
 * Finds the worker entry next to this module: `modWorker.mjs` in the bundled
 * server, `modWorker.ts` when running from source (Bun in development, Node in
 * tests). The name is built at runtime so the bundler leaves the URL alone.
 */
export async function resolveModWorkerUrl(): Promise<URL> {
  for (const extension of ["mjs", "ts"]) {
    const url = new URL(`./modWorker.${extension}`, import.meta.url);
    const found = await access(fileURLToPath(url)).then(
      () => true,
      () => false,
    );
    if (found) return url;
  }
  throw new Error("This Synara build is missing the mod worker entry.");
}

export type ModHookOutcome =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "error"; readonly error: string };

export interface ModWorkerHostOptions {
  readonly data: ModWorkerData;
  readonly workerUrl: URL;
  readonly loadTimeoutMs?: number;
  readonly hookTimeoutMs?: number;
  /** Answers one `$` call; a rejection reaches the mod as a thrown error. */
  readonly handleApi: (method: string, args: ReadonlyArray<unknown>) => Promise<unknown>;
  /** A stray error inside the mod that no hook caught. */
  readonly onUncaught: (error: string) => void;
  /** The worker stopped on its own (crash, out of memory, a hung hook). */
  readonly onExit: (reason: string) => void;
}

interface Invocation {
  readonly resolve: (outcome: ModHookOutcome) => void;
  readonly next: (input: unknown) => Promise<unknown>;
  timer: ReturnType<typeof setTimeout> | null;
  nextInFlight: number;
}

export class ModWorkerHost {
  private readonly worker: Worker;
  private readonly options: ModWorkerHostOptions;
  private readonly hookTimeoutMs: number;
  private readonly invocations = new Map<number, Invocation>();
  private readonly pings = new Map<number, () => void>();
  private registrations: ReadonlyArray<ModHookRegistration> = [];
  private nextCallId = 1;
  private nextPingId = 1;
  private stopping = false;
  private exited = false;

  private constructor(options: ModWorkerHostOptions) {
    this.options = options;
    this.hookTimeoutMs = options.hookTimeoutMs ?? MOD_HOOK_TIMEOUT_MS;
    this.worker = new Worker(options.workerUrl, {
      workerData: options.data,
      name: `synara-mod:${options.data.modId}`,
      resourceLimits: { maxOldGenerationSizeMb: MOD_WORKER_MAX_OLD_GENERATION_MB },
    });
  }

  /** Starts a worker and resolves once `register()` has run; rejects (and stops it) otherwise. */
  static start(options: ModWorkerHostOptions): Promise<ModWorkerHost> {
    const host = new ModWorkerHost(options);
    return host.waitUntilReady(options.loadTimeoutMs ?? MOD_LOAD_TIMEOUT_MS).then(
      () => host,
      async (error: unknown) => {
        await host.stop();
        throw error;
      },
    );
  }

  get hooks(): ReadonlyArray<ModHookRegistration> {
    return this.registrations;
  }

  get isAlive(): boolean {
    return !this.exited && !this.stopping;
  }

  private waitUntilReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        this.worker.off("exit", onExit);
        if (error) {
          reject(error);
          return;
        }
        this.attach();
        resolve();
      };
      const onMessage = (message: WorkerToHostMessage) => {
        if (message.type === "ready") {
          this.registrations = message.hooks;
          finish();
        } else if (message.type === "load-failed") {
          finish(new Error(message.error));
        } else {
          // A mod may log or call `$` while register() runs.
          this.handleMessage(message);
        }
      };
      const onError = (error: Error) => finish(new Error(describeModError(error)));
      const onExit = (code: number) =>
        finish(new Error(`The mod's worker exited with code ${code} while loading.`));
      const timer = setTimeout(
        () => finish(new Error(`register() did not finish within ${timeoutMs / 1000} s.`)),
        timeoutMs,
      );
      this.worker.on("message", onMessage);
      this.worker.on("error", onError);
      this.worker.on("exit", onExit);
    });
  }

  private attach(): void {
    this.worker.on("message", (message: WorkerToHostMessage) => this.handleMessage(message));
    this.worker.on("error", (error: Error) => this.handleExit(describeModError(error)));
    this.worker.on("exit", (code: number) =>
      this.handleExit(`The mod's worker exited with code ${code}.`),
    );
  }

  private post(message: HostToWorkerMessage): void {
    if (this.exited) return;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port, not window.postMessage
    this.worker.postMessage(message);
  }

  private handleMessage(message: WorkerToHostMessage): void {
    switch (message.type) {
      case "invoke-result": {
        const invocation = this.invocations.get(message.callId);
        if (!invocation) return;
        this.invocations.delete(message.callId);
        this.disarm(invocation);
        invocation.resolve(
          message.ok
            ? { kind: "result", value: message.value }
            : { kind: "error", error: message.error },
        );
        return;
      }
      case "next": {
        const invocation = this.invocations.get(message.callId);
        if (!invocation) {
          this.post({
            type: "next-result",
            callId: message.callId,
            nextId: message.nextId,
            ok: false,
            error: "next() was called after the hook timed out.",
          });
          return;
        }
        this.disarm(invocation);
        invocation.nextInFlight += 1;
        void invocation.next(message.input).then(
          (value) => this.afterNext(message.callId, message.nextId, { ok: true, value }),
          (error: unknown) =>
            this.afterNext(message.callId, message.nextId, {
              ok: false,
              error: describeModError(error),
            }),
        );
        return;
      }
      case "api": {
        void this.options.handleApi(message.method, message.args).then(
          (value) =>
            this.post({ type: "api-result", requestId: message.requestId, ok: true, value }),
          (error: unknown) =>
            this.post({
              type: "api-result",
              requestId: message.requestId,
              ok: false,
              error: error instanceof Error ? error.message : describeModError(error),
            }),
        );
        return;
      }
      case "pong": {
        const resolve = this.pings.get(message.pingId);
        this.pings.delete(message.pingId);
        resolve?.();
        return;
      }
      case "uncaught":
        this.options.onUncaught(message.error);
        return;
      case "ready":
      case "load-failed":
        return;
    }
  }

  private afterNext(
    callId: number,
    nextId: number,
    outcome:
      | { readonly ok: true; readonly value: unknown }
      | { readonly ok: false; readonly error: string },
  ): void {
    const invocation = this.invocations.get(callId);
    if (invocation) {
      invocation.nextInFlight -= 1;
      if (invocation.nextInFlight === 0) this.arm(callId, invocation);
    }
    this.post({ type: "next-result", callId, nextId, ...outcome });
  }

  private arm(callId: number, invocation: Invocation): void {
    this.disarm(invocation);
    invocation.timer = setTimeout(() => this.timeOut(callId), this.hookTimeoutMs);
  }

  private disarm(invocation: Invocation): void {
    if (invocation.timer !== null) {
      clearTimeout(invocation.timer);
      invocation.timer = null;
    }
  }

  private timeOut(callId: number): void {
    const invocation = this.invocations.get(callId);
    if (!invocation) return;
    this.invocations.delete(callId);
    invocation.resolve({
      kind: "error",
      error: `The hook did not finish within ${this.hookTimeoutMs / 1000} s.`,
    });
    // A hook still awaiting something is slow; a worker that cannot answer a
    // ping is stuck in synchronous code and has to go.
    void this.ping(MOD_PING_TIMEOUT_MS).then((alive) => {
      if (alive || this.exited || this.stopping) return;
      this.handleExit(
        `A hook ran synchronously for more than ${this.hookTimeoutMs / 1000} s, so the mod was stopped.`,
      );
      void this.worker.terminate();
    });
  }

  private ping(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(false);
    const pingId = this.nextPingId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pings.delete(pingId);
        resolve(false);
      }, timeoutMs);
      this.pings.set(pingId, () => {
        clearTimeout(timer);
        resolve(true);
      });
      this.post({ type: "ping", pingId });
    });
  }

  /**
   * Runs one hook. `next` continues the chain on the server. Never rejects: a
   * failure, timeout or dead worker comes back as an `error` outcome.
   */
  invoke(
    hookId: number,
    input: unknown,
    next: (input: unknown) => Promise<unknown>,
  ): Promise<ModHookOutcome> {
    if (!this.isAlive) {
      return Promise.resolve({ kind: "error", error: "The mod is not running." });
    }
    const callId = this.nextCallId++;
    return new Promise((resolve) => {
      const invocation: Invocation = { resolve, next, timer: null, nextInFlight: 0 };
      this.invocations.set(callId, invocation);
      this.arm(callId, invocation);
      try {
        this.post({ type: "invoke", callId, hookId, input });
      } catch (error) {
        this.invocations.delete(callId);
        this.disarm(invocation);
        resolve({ kind: "error", error: describeModError(error) });
      }
    });
  }

  private handleExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    this.failInFlight("The mod stopped before the hook finished.");
    if (!this.stopping) this.options.onExit(reason);
  }

  private failInFlight(error: string): void {
    for (const invocation of this.invocations.values()) {
      this.disarm(invocation);
      invocation.resolve({ kind: "error", error });
    }
    this.invocations.clear();
    for (const resolve of this.pings.values()) resolve();
    this.pings.clear();
  }

  /** Terminates the worker. Hooks still running resolve as errors. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.failInFlight("The mod was stopped.");
    if (this.exited) return;
    this.exited = true;
    await this.worker.terminate().catch(() => undefined);
  }
}
