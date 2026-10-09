import { Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

// Mods are user-installed hook modules that the server loads from
// `<baseDir>/mods/<name>/`. Each one runs in its own worker and reaches Synara
// only through the `$` interface its hooks receive. Mods are Beta-only: the
// server refuses every method below on Stable.

// ── WebSocket surface ────────────────────────────────────────────────

export const MODS_WS_METHODS = {
  list: "mods.list",
  setEnabled: "mods.setEnabled",
  reload: "mods.reload",
  readLogs: "mods.readLogs",
  runCommand: "mods.runCommand",
  subscribeEvents: "mods.subscribeEvents",
} as const;

// One channel carries every mod push (snapshots and toasts) so the feature costs
// a single stream lease per client.
export const MODS_WS_CHANNELS = {
  event: "mods.event",
} as const;

/** WsRpcError code the server uses to refuse mods where they are not enabled. */
export const MODS_UNAVAILABLE_ERROR_CODE = "MODS_UNAVAILABLE";

/** The `$` interface version this build implements. */
export const MOD_API_VERSION = 1;

/** Folder under the Synara home that holds one folder per mod. */
export const MODS_DIRECTORY_NAME = "mods";
/** The manifest of a mod, relative to its folder. */
export const MOD_MANIFEST_PATH = ".synara-mod/mod.json";
/** The file naming the mod's hooks module, relative to its folder. */
export const MOD_HOOKS_PATH = "hooks/hooks.json";

// ── Identity and manifest ────────────────────────────────────────────

const MOD_TEXT_MAX_LENGTH = 1_024;
const MOD_COMMAND_NAME_MAX_LENGTH = 64;

/** A mod's id is its folder name and its manifest name: lowercase words joined by dashes. */
export const ModId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
export type ModId = typeof ModId.Type;

export const ModManifest = Schema.Struct({
  name: ModId,
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(MOD_TEXT_MAX_LENGTH))),
  /** The `$` interface version the mod was written against; absent means 1. */
  apiVersion: Schema.optional(Schema.Literal(MOD_API_VERSION)),
});
export type ModManifest = typeof ModManifest.Type;

/** `hooks/hooks.json`: one hooks module, relative to that file. */
export const ModHooksFile = Schema.Struct({
  modules: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1),
  ),
});
export type ModHooksFile = typeof ModHooksFile.Type;

// ── Runtime state ────────────────────────────────────────────────────

export const ModStatus = Schema.Literals(["disabled", "starting", "running", "error"]);
export type ModStatus = typeof ModStatus.Type;

export const ModCommandName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  Schema.isMaxLength(MOD_COMMAND_NAME_MAX_LENGTH),
);
export type ModCommandName = typeof ModCommandName.Type;

export const ModCommand = Schema.Struct({
  name: ModCommandName,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(MOD_TEXT_MAX_LENGTH))),
});
export type ModCommand = typeof ModCommand.Type;

export const ModSummary = Schema.Struct({
  id: ModId,
  version: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Absolute path of the mod's folder on the server host. */
  path: Schema.String,
  enabled: Schema.Boolean,
  status: ModStatus,
  /** Why the mod is not running (bad manifest, load failure, crash). */
  error: Schema.NullOr(Schema.String),
  /** The events the loaded module hooks, in registration order, without duplicates. */
  hooks: Schema.Array(Schema.String),
  commands: Schema.Array(ModCommand),
  /** The mod's status line entry, set with `$.ui.status`. */
  statusText: Schema.NullOr(Schema.String),
  loadedAt: Schema.NullOr(IsoDateTime),
});
export type ModSummary = typeof ModSummary.Type;

export const ModsSnapshot = Schema.Struct({
  /** Absolute path of the folder the server scans for mods. */
  modsDir: Schema.String,
  mods: Schema.Array(ModSummary),
});
export type ModsSnapshot = typeof ModsSnapshot.Type;

export const ModToastTone = Schema.Literals(["info", "success", "warning", "error"]);
export type ModToastTone = typeof ModToastTone.Type;

export const ModToast = Schema.Struct({
  id: Schema.String,
  modId: ModId,
  text: Schema.String,
  tone: ModToastTone,
});
export type ModToast = typeof ModToast.Type;

export const ModLogLevel = Schema.Literals(["info", "warn", "error"]);
export type ModLogLevel = typeof ModLogLevel.Type;

export const ModLogEntry = Schema.Struct({
  at: IsoDateTime,
  level: ModLogLevel,
  message: Schema.String,
});
export type ModLogEntry = typeof ModLogEntry.Type;

export const ModsStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: ModsSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("toast"),
    toast: ModToast,
  }),
]);
export type ModsStreamEvent = typeof ModsStreamEvent.Type;

// ── Inputs and results ───────────────────────────────────────────────

export const ModsSetEnabledInput = Schema.Struct({
  id: ModId,
  enabled: Schema.Boolean,
});
export type ModsSetEnabledInput = typeof ModsSetEnabledInput.Type;

export const ModsReloadInput = Schema.Struct({
  id: ModId,
});
export type ModsReloadInput = typeof ModsReloadInput.Type;

export const ModsReadLogsInput = Schema.Struct({
  id: ModId,
});
export type ModsReadLogsInput = typeof ModsReadLogsInput.Type;

export const ModsReadLogsResult = Schema.Struct({
  logs: Schema.Array(ModLogEntry),
});
export type ModsReadLogsResult = typeof ModsReadLogsResult.Type;

export const ModsRunCommandInput = Schema.Struct({
  modId: ModId,
  command: ModCommandName,
  /** The thread open in the window that ran the command, when there is one. */
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type ModsRunCommandInput = typeof ModsRunCommandInput.Type;

export const ModsRunCommandResult = Schema.Struct({
  /** What the mod answered, shown to the person as a toast; null when it said nothing. */
  text: Schema.NullOr(Schema.String),
});
export type ModsRunCommandResult = typeof ModsRunCommandResult.Type;
