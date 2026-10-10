// FILE: modProtocol.ts
// Purpose: The messages a mod's worker and the server exchange.
// Layer: Mods runtime. Imported by the worker entry, so it stays free of
//        server imports and of syntax Node's type stripping cannot erase.

/** The `$` methods a worker may call, by dotted name. */
export const MOD_API_METHODS = [
  "log.info",
  "log.warn",
  "log.error",
  "ui.toast",
  "ui.status",
  "ui.view",
  "ui.removeView",
  "ui.invalidate",
  "ui.openThread",
  "ui.openUrl",
  "ui.openDockView",
  "mcp.status",
  "mcp.tools",
  "mcp.call",
  "command.register",
  "command.unregister",
  "tool.register",
  "tool.unregister",
  "threads.list",
  "threads.get",
  "projects.list",
  "state.get",
  "state.set",
  "store.get",
  "store.set",
  "store.delete",
  "store.keys",
] as const;
export type ModApiMethod = (typeof MOD_API_METHODS)[number];

export interface ModWorkerData {
  readonly modId: string;
  readonly version: string;
  /** Absolute path of the mod's folder; imports may not leave it. */
  readonly root: string;
  /** Absolute path of the hooks module. */
  readonly entry: string;
  readonly options: Readonly<Record<string, unknown>>;
  /** The element names the SDK exports for JSX (`import { Box } from "synara"`). */
  readonly elements: ReadonlyArray<string>;
}

export interface ModHookRegistration {
  readonly hookId: number;
  readonly event: string;
  readonly matcher: unknown;
}

export type ModCallOutcome =
  | { readonly ok: true; readonly value: unknown }
  /** `code`: set on failures a mod may want to tell apart, such as a server waiting for a sign-in. */
  | { readonly ok: false; readonly error: string; readonly code?: string };

export type HostToWorkerMessage =
  | {
      readonly type: "invoke";
      readonly callId: number;
      readonly hookId: number;
      readonly input: unknown;
    }
  | {
      readonly type: "invoke-handler";
      readonly callId: number;
      readonly handlerId: string;
      readonly payload: unknown;
    }
  | ({
      readonly type: "next-result";
      readonly callId: number;
      readonly nextId: number;
    } & ModCallOutcome)
  | ({ readonly type: "api-result"; readonly requestId: number } & ModCallOutcome)
  | { readonly type: "ping"; readonly pingId: number };

export type WorkerToHostMessage =
  | { readonly type: "ready"; readonly hooks: ReadonlyArray<ModHookRegistration> }
  | { readonly type: "load-failed"; readonly error: string }
  | ({ readonly type: "invoke-result"; readonly callId: number } & ModCallOutcome)
  | {
      readonly type: "next";
      readonly callId: number;
      readonly nextId: number;
      readonly input: unknown;
    }
  | {
      readonly type: "api";
      readonly requestId: number;
      /** The hook or handler call the request came from, when there is one. */
      readonly callId: number | null;
      readonly method: string;
      readonly args: ReadonlyArray<unknown>;
    }
  | { readonly type: "pong"; readonly pingId: number }
  | { readonly type: "uncaught"; readonly error: string };

/** Specifiers that resolve to the mod SDK instead of a file. */
export const MOD_SDK_SPECIFIERS: ReadonlySet<string> = new Set(["synara", "@synara/mod"]);

/** Formats any thrown value for logs and status, keeping the stack when there is one. */
export function describeModError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack && error.stack.length > 0 ? error.stack : `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** A function in a hook's result travels as this reference; the function stays in the worker. */
export interface ModHandlerReference {
  readonly $handler: string;
}

/** The error a worker answers for a handler from a tree it no longer holds. */
export const MOD_STALE_HANDLER_ERROR = "This control is out of date; the view is being redrawn.";
