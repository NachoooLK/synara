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
  renderView: "mods.renderView",
  dispatchUi: "mods.dispatchUi",
  export: "mods.export",
  import: "mods.import",
  mcpSignIn: "mods.mcpSignIn",
  mcpSignOut: "mods.mcpSignOut",
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

/** A name a mod gives one of its MCP servers: `$.mcp.call("<name>", …)`. */
export const ModMcpServerName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/));
export type ModMcpServerName = typeof ModMcpServerName.Type;

const ModMcpText = Schema.String.check(Schema.isMaxLength(4_096));

/** The port Synara listens on for the browser's return from a sign-in, unless it is taken. */
export const MOD_MCP_SIGN_IN_PORT = 47_823;
/** The path of that return address: `http://127.0.0.1:<port>/callback`. */
export const MOD_MCP_SIGN_IN_PATH = "/callback";

/**
 * How the person signs in to a remote server that asks for it (OAuth). A mod
 * need not declare it: Synara finds out when the server refuses a call. It is
 * needed for a server that does not register apps by itself (`clientId`), and
 * it lets Synara say that a sign-in is coming before the mod runs.
 */
export const ModMcpOAuthConfig = Schema.Struct({
  /** The client id registered for Synara with the server's authorization server. */
  clientId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  /** The scopes to ask for. By default, the ones the server lists. */
  scopes: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/))).check(
      Schema.isMaxLength(32),
    ),
  ),
  /** The port of the return address, for a client id registered with a fixed one. */
  callbackPort: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_024), Schema.isLessThanOrEqualTo(65_535)),
  ),
});
export type ModMcpOAuthConfig = typeof ModMcpOAuthConfig.Type;

/**
 * An MCP server a mod uses. Values may say `${env:NAME}` to take a variable
 * from Synara's environment, so tokens stay out of the mod's files.
 */
export const ModMcpServerConfig = Schema.Union([
  Schema.Struct({
    /** A local server Synara starts on first use and stops with the mod. */
    command: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
    args: Schema.optional(Schema.Array(ModMcpText).check(Schema.isMaxLength(64))),
    env: Schema.optional(Schema.Record(Schema.String, ModMcpText)),
    cwd: Schema.optional(ModMcpText),
  }),
  Schema.Struct({
    /** A remote server reached over streamable HTTP. */
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
    headers: Schema.optional(Schema.Record(Schema.String, ModMcpText)),
    oauth: Schema.optional(ModMcpOAuthConfig),
  }),
]);
export type ModMcpServerConfig = typeof ModMcpServerConfig.Type;

/**
 * What a mod may do to agents, beyond drawing views and reading lists. A mod
 * asks for these in its manifest and the person sees them before enabling it:
 * - `prompts`: change the messages the person sends to agents (`prompt.submit`).
 * - `approvals`: deny tool calls that wait for the person's approval (`approval.requested`).
 * - `tools`: give agents new tools (`$.tool.register`).
 */
export const ModPermission = Schema.Literals(["prompts", "approvals", "tools"]);
export type ModPermission = typeof ModPermission.Type;

export const ModManifest = Schema.Struct({
  name: ModId,
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(MOD_TEXT_MAX_LENGTH))),
  /** The `$` interface version the mod was written against; absent means 1. */
  apiVersion: Schema.optional(Schema.Literal(MOD_API_VERSION)),
  /** MCP servers the mod calls through `$.mcp`, by the name it uses for them. */
  mcpServers: Schema.optional(Schema.Record(ModMcpServerName, ModMcpServerConfig)),
  /** What the mod asks to do to agents; without an entry the matching hooks never run. */
  permissions: Schema.optional(Schema.Array(ModPermission).check(Schema.isMaxLength(8))),
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

/**
 * `changed`: the mod is enabled, but its files are not the ones the person
 * trusted, so it is stopped until they trust the change.
 */
export const ModStatus = Schema.Literals(["disabled", "starting", "running", "error", "changed"]);
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

// ── Views ────────────────────────────────────────────────────────────
// A mod draws into a site by registering a view and answering `ui.render` for
// it with an element tree: plain data that the web app draws with Synara's own
// components. Handlers stay in the mod; the tree carries `{ $handler }` ids.

/** Where a view is drawn. */
export const ModViewSite = Schema.Literals(["sidebar", "dock", "band", "header"]);
export type ModViewSite = typeof ModViewSite.Type;

/** What makes Synara redraw a view without the mod asking. */
export const ModViewRefreshSource = Schema.Literals(["threads", "projects"]);
export type ModViewRefreshSource = typeof ModViewRefreshSource.Type;

export const ModViewId = ModCommandName;
export type ModViewId = typeof ModViewId.Type;

export const ModView = Schema.Struct({
  id: ModViewId,
  site: ModViewSite,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /** A Central icon name; null draws the mod's default glyph. */
  icon: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  refreshOn: Schema.Array(ModViewRefreshSource),
});
export type ModView = typeof ModView.Type;

/** What the window drawing a view knows: the open thread and its project. */
export const ModViewContext = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
});
export type ModViewContext = typeof ModViewContext.Type;

/** The elements a tree may use; the web app draws each with Synara's own components. */
export const MOD_UI_ELEMENTS = [
  "Fragment",
  "Box",
  "Text",
  "Heading",
  "Section",
  "List",
  "Row",
  "Button",
  "Icon",
  "Badge",
  "Markdown",
  "Code",
  "Link",
  "Divider",
  "Spinner",
  "Empty",
  "Input",
  "Switch",
] as const;
export type ModUiElementName = (typeof MOD_UI_ELEMENTS)[number];

/** Size limits of one rendered tree. */
export const MOD_UI_TREE_LIMITS = {
  depth: 40,
  nodes: 5_000,
  bytes: 512_000,
} as const;

/**
 * A rendered tree, checked for shape by the server and drawn defensively by the
 * web app: `{ type, props, children }` nodes, strings and numbers.
 */
export const ModUiTree = Schema.Json;
export type ModUiTree = typeof ModUiTree.Type;

/** What a handler may ask of the window that triggered it. */
export const ModUiEffect = Schema.Union([
  Schema.Struct({ type: Schema.Literal("openThread"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("openUrl"),
    url: Schema.String.check(Schema.isMaxLength(2_048)),
  }),
  Schema.Struct({
    type: Schema.Literal("openDockView"),
    modId: Schema.String,
    viewId: ModViewId,
  }),
]);
export type ModUiEffect = typeof ModUiEffect.Type;

/** A tool a mod gives to agents, as Settings lists it. */
export const ModAgentToolSummary = Schema.Struct({
  /** The name the mod registered. */
  name: Schema.String,
  /** The name agents call: `mod_<mod>_<name>`. */
  servedName: Schema.String,
  description: Schema.String,
});
export type ModAgentToolSummary = typeof ModAgentToolSummary.Type;

/**
 * A server of a mod that asks the person to sign in. `needed`: calls to it fail
 * until they do. The token stays in Synara; the mod never sees it.
 */
export const ModMcpSignIn = Schema.Struct({
  /** The name the mod gives the server. */
  server: ModMcpServerName,
  /** The server's host, which receives the token: what the person agrees to sign in to. */
  host: Schema.String,
  state: Schema.Literals(["needed", "signed-in"]),
  /** Why a sign-in is needed again or did not complete, when there is something to say. */
  detail: Schema.NullOr(Schema.String),
});
export type ModMcpSignIn = typeof ModMcpSignIn.Type;

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
  views: Schema.Array(ModView),
  /** The names of the MCP servers the manifest declares. */
  mcpServers: Schema.Array(Schema.String),
  /** The servers among them that ask the person to sign in, as far as Synara knows. */
  mcpSignIns: Schema.Array(ModMcpSignIn),
  /** What the manifest asks to do to agents. */
  permissions: Schema.Array(ModPermission),
  /** The tools the mod gives to agents (needs the `tools` permission). */
  tools: Schema.Array(ModAgentToolSummary),
  /** The person let this mod reload as its files change, without asking again (until restart). */
  reloadsOnChange: Schema.Boolean,
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
  /** A mod's view should be drawn again; `viewId` null means every view of the mod. */
  Schema.Struct({
    type: Schema.Literal("invalidate"),
    modId: ModId,
    viewId: Schema.NullOr(ModViewId),
  }),
]);
export type ModsStreamEvent = typeof ModsStreamEvent.Type;

// ── Inputs and results ───────────────────────────────────────────────

export const ModsSetEnabledInput = Schema.Struct({
  id: ModId,
  /** Enabling trusts the mod's files as they are now, also for a mod that is already enabled. */
  enabled: Schema.Boolean,
  /**
   * With `enabled`: keep reloading the mod as its files change, for a mod that
   * is being written. Without it a change stops the mod until it is trusted again.
   */
  reloadOnChange: Schema.optional(Schema.Boolean),
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

export const ModsRenderViewInput = Schema.Struct({
  modId: ModId,
  viewId: ModViewId,
  context: ModViewContext,
});
export type ModsRenderViewInput = typeof ModsRenderViewInput.Type;

export const ModsRenderViewResult = Schema.Struct({
  /** Null when the mod drew nothing for this view. */
  tree: Schema.NullOr(ModUiTree),
});
export type ModsRenderViewResult = typeof ModsRenderViewResult.Type;

export const ModsDispatchUiInput = Schema.Struct({
  modId: ModId,
  /** The `$handler` id the tree carried. */
  handlerId: Schema.String.check(Schema.isMaxLength(64)),
  /** What happened: an input's value, a select's choice; null for a press. */
  payload: Schema.NullOr(Schema.Json),
});
export type ModsDispatchUiInput = typeof ModsDispatchUiInput.Type;

export const ModsDispatchUiResult = Schema.Struct({
  effects: Schema.Array(ModUiEffect),
});
export type ModsDispatchUiResult = typeof ModsDispatchUiResult.Type;

// ── Export and import ────────────────────────────────────────────────
// An exported mod is one JSON file holding every file of its folder, so it can
// be shared like any document and imported into another Synara.

export const MOD_BUNDLE_FORMAT = "synara-mod";
export const MOD_BUNDLE_FORMAT_VERSION = 1;
/** An exported mod is saved as `<name>.synara-mod.json`. */
export const MOD_BUNDLE_FILE_SUFFIX = ".synara-mod.json";

/** Limits of one exported mod; `bytes` is its compact JSON, which must fit one WebSocket message. */
export const MOD_BUNDLE_LIMITS = {
  files: 200,
  bytes: 1_500_000,
  pathLength: 256,
} as const;

export const ModBundleFile = Schema.Struct({
  /** Relative to the mod's folder, with `/` between segments. */
  path: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MOD_BUNDLE_LIMITS.pathLength),
  ),
  /** Text files travel as they are; anything else as base64. */
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
});
export type ModBundleFile = typeof ModBundleFile.Type;

export const ModBundle = Schema.Struct({
  format: Schema.Literal(MOD_BUNDLE_FORMAT),
  formatVersion: Schema.Literal(MOD_BUNDLE_FORMAT_VERSION),
  name: ModId,
  version: Schema.String.check(Schema.isMaxLength(64)),
  exportedAt: IsoDateTime,
  files: Schema.Array(ModBundleFile).check(Schema.isMaxLength(MOD_BUNDLE_LIMITS.files)),
});
export type ModBundle = typeof ModBundle.Type;

export const ModsExportInput = Schema.Struct({
  id: ModId,
});
export type ModsExportInput = typeof ModsExportInput.Type;

export const ModsExportResult = Schema.Struct({
  /** The name to save the file under: `<name>.synara-mod.json`. */
  filename: Schema.String,
  /** The file's text. */
  contents: Schema.String,
});
export type ModsExportResult = typeof ModsExportResult.Type;

export const ModsImportInput = Schema.Struct({
  /** The parsed file; the server checks it against `ModBundle` and explains what is wrong. */
  bundle: Schema.Json,
  /** Replace an installed mod with the same name. Without it, the server refuses. */
  replace: Schema.Boolean,
});
export type ModsImportInput = typeof ModsImportInput.Type;

export const ModsImportResult = Schema.Struct({
  id: ModId,
  /** Whether an installed mod was replaced. An imported mod always starts turned off. */
  replaced: Schema.Boolean,
  snapshot: ModsSnapshot,
});
export type ModsImportResult = typeof ModsImportResult.Type;

// ── Signing in to a mod's MCP server ─────────────────────────────────
// Each sign-in belongs to one mod and one server address. Synara keeps the
// token and sends it only to that address.

export const ModsMcpSignInInput = Schema.Struct({
  id: ModId,
  server: ModMcpServerName,
});
export type ModsMcpSignInInput = typeof ModsMcpSignInInput.Type;

export const ModsMcpSignInResult = Schema.Struct({
  /**
   * The sign-in page, to open in a browser on the computer that runs Synara:
   * the browser returns to an address on that computer.
   */
  url: Schema.String.check(Schema.isMaxLength(8_192)),
});
export type ModsMcpSignInResult = typeof ModsMcpSignInResult.Type;

export const ModsMcpSignOutInput = Schema.Struct({
  id: ModId,
  server: ModMcpServerName,
});
export type ModsMcpSignOutInput = typeof ModsMcpSignOutInput.Type;
