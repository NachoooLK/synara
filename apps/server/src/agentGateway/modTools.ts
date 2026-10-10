// FILE: modTools.ts
// Purpose: Lets an agent that writes a mod check it from the thread: list the
//          mods and their load errors, read a mod's log, draw a view as JSON and
//          reload a mod. Enabling a mod stays with the person (Settings → Mods).
// Layer: Agent gateway tools (Beta-only, like mods)

import { Effect } from "effect";

import type { ModHostShape } from "../mods/Services/ModHost.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import { errorText, readStringArg } from "./toolInput.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

const MOD_ID_SCHEMA = {
  type: "string",
  description: "The mod's id: its folder name in the mods folder.",
} as const;

/** Runs a mods call and turns its failure into a tool error the agent can read. */
function respond<A>(
  run: () => Effect.Effect<A, { readonly message: string }>,
  toResult: (value: A) => unknown,
): Effect.Effect<McpToolCallResult> {
  return Effect.suspend(run).pipe(
    Effect.map((value) => mcpToolResultJson(toResult(value))),
    Effect.catch((error) => Effect.succeed(mcpToolResultError(error.message))),
    Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
  );
}

function inputError(error: unknown): Effect.Effect<McpToolCallResult> {
  return Effect.succeed(mcpToolResultError(errorText(error)));
}

/** What an agent should do about a mod that stopped because it was edited. */
const MOD_CHANGED_NOTE =
  'The files are not the ones the person enabled, so the mod is stopped, and reloading again will not start it. Ask the person to press Trust changes in Settings → Mods, ticking "Keep reloading it when its files change" if you will keep editing it.';

/** The most text one mod tool may hand an agent; more would cost the turn its context. */
const MOD_TOOL_RESULT_CHARS_LIMIT = 100_000;
const MOD_TOOL_NAME_PREFIX = "mod_";

/**
 * The tools running mods give to agents, as the gateway serves them. They are
 * read on every listing, so a mod's tools appear and go with the mod; a session
 * that lists tools only when it starts sees the ones registered by then.
 */
export function makeAgentGatewayModToolSource(modHost: ModHostShape): {
  readonly tools: () => ReadonlyArray<ToolEntry>;
  readonly missingTool: (toolName: string) => string | null;
} {
  return {
    tools: () =>
      modHost.agentTools().map(
        (tool): ToolEntry => ({
          // The same bar as reloading a mod: the session may act on this thread.
          requiredCapability: "thread:write",
          requiresActiveTurn: true,
          definition: {
            name: tool.servedName,
            description: tool.description,
            inputSchema: tool.inputSchema,
          },
          handler: (args, context) =>
            modHost
              .callAgentTool({
                servedName: tool.servedName,
                arguments: args,
                threadId: context.callerThreadId,
              })
              .pipe(
                Effect.map((value): McpToolCallResult => {
                  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
                  return text.length > MOD_TOOL_RESULT_CHARS_LIMIT
                    ? mcpToolResultError(
                        `The ${tool.modId} mod's "${tool.name}" tool returned ${text.length} characters; the limit is ${MOD_TOOL_RESULT_CHARS_LIMIT}.`,
                      )
                    : typeof value === "string"
                      ? { content: [{ type: "text", text: value }] }
                      : mcpToolResultJson(value ?? null);
                }),
                Effect.catch((error) => Effect.succeed(mcpToolResultError(error.message))),
                Effect.catchDefect((defect) =>
                  Effect.succeed(mcpToolResultError(errorText(defect))),
                ),
              ),
        }),
      ),
    missingTool: (toolName) =>
      toolName.startsWith(MOD_TOOL_NAME_PREFIX)
        ? `No running mod has a tool named "${toolName}". Its mod may be off, reloading or failing; the person can check Settings → Mods.`
        : null,
  };
}

export function makeAgentGatewayModTools(modHost: ModHostShape): ReadonlyArray<ToolEntry> {
  const listMods: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_mods_list",
      description:
        'List the Synara mods in the mods folder with their status (disabled, starting, running, error, changed), load or runtime error, registered views and commands, and the mods folder path. Use it after writing or editing a mod to see whether it loaded. A new mod is disabled until the person enables it in Settings → Mods. "changed" means its files are not the ones the person enabled: it stays stopped until they press Trust changes there. "mcpSignIns" lists the mod\'s MCP servers that ask the person to sign in: while one is "needed", calls to it fail until the person presses Sign in (in the mod\'s view or in Settings → Mods); you cannot sign in for them.',
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List Synara mods", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: () =>
      respond(
        () => modHost.list(),
        (snapshot) => ({
          modsDir: snapshot.modsDir,
          mods: snapshot.mods.map((mod) => ({
            id: mod.id,
            version: mod.version,
            enabled: mod.enabled,
            status: mod.status,
            error: mod.error,
            hooks: mod.hooks,
            views: mod.views.map((view) => ({ id: view.id, site: view.site, title: view.title })),
            commands: mod.commands.map((command) => command.name),
            permissions: mod.permissions,
            reloadsOnChange: mod.reloadsOnChange,
            agentTools: mod.tools.map((tool) => tool.servedName),
            mcpSignIns: mod.mcpSignIns,
            path: mod.path,
          })),
        }),
      ),
  };

  const readLogs: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_mod_logs",
      description:
        "Read a Synara mod's recent log: load messages, hook failures with their stack frames in the mod's files, and everything the mod wrote with $.log or console.log.",
      inputSchema: {
        type: "object",
        properties: {
          modId: MOD_ID_SCHEMA,
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Newest lines to return (50 by default).",
          },
        },
        required: ["modId"],
        additionalProperties: false,
      },
      annotations: { title: "Read a mod's log", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) => {
      let modId: string;
      try {
        modId = readStringArg(args, "modId", { required: true }) as string;
      } catch (error) {
        return inputError(error);
      }
      const limit =
        typeof args.limit === "number" && Number.isInteger(args.limit)
          ? Math.min(Math.max(args.limit, 1), 200)
          : 50;
      return respond(
        () => modHost.readLogs({ id: modId }),
        (result) => ({ modId, logs: result.logs.slice(-limit) }),
      );
    },
  };

  const renderView: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_mod_render",
      description:
        "Draw one view of a running Synara mod as the JSON tree the window would draw, without opening the window. Handlers appear as { $handler } references. Use it to check a view's output and errors while writing a mod.",
      inputSchema: {
        type: "object",
        properties: {
          modId: MOD_ID_SCHEMA,
          viewId: { type: "string", description: "The view's id, as registered with $.ui.view." },
          threadId: {
            type: "string",
            description: "The thread the view is drawn for (context.threadId); none by default.",
          },
        },
        required: ["modId", "viewId"],
        additionalProperties: false,
      },
      annotations: { title: "Draw a mod view as JSON", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) => {
      let modId: string;
      let viewId: string;
      let threadId: string | undefined;
      try {
        modId = readStringArg(args, "modId", { required: true }) as string;
        viewId = readStringArg(args, "viewId", { required: true }) as string;
        threadId = readStringArg(args, "threadId");
      } catch (error) {
        return inputError(error);
      }
      return respond(
        () =>
          modHost.renderView({
            modId,
            viewId,
            context: { threadId: (threadId ?? null) as never, projectId: null },
          }),
        (result) => ({ modId, viewId, tree: result.tree }),
      );
    },
  };

  const reloadMod: ToolEntry = {
    requiredCapability: "thread:write",
    definition: {
      name: "synara_mod_reload",
      description:
        'Reload an enabled Synara mod: read its files again and restart it. Use it after a failure or to start over with a fresh worker. A mod whose files changed since the person enabled it comes back as "changed" and does not run until they trust the change in Settings → Mods.',
      inputSchema: {
        type: "object",
        properties: { modId: MOD_ID_SCHEMA },
        required: ["modId"],
        additionalProperties: false,
      },
      annotations: {
        title: "Reload a mod",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args) => {
      let modId: string;
      try {
        modId = readStringArg(args, "modId", { required: true }) as string;
      } catch (error) {
        return inputError(error);
      }
      return respond(
        () => modHost.reload({ id: modId }),
        (snapshot) => {
          const mod = snapshot.mods.find((candidate) => candidate.id === modId);
          return {
            modId,
            status: mod?.status ?? "missing",
            error: mod?.error ?? null,
            ...(mod?.status === "changed" ? { next: MOD_CHANGED_NOTE } : {}),
          };
        },
      );
    },
  };

  return [listMods, readLogs, renderView, reloadMod];
}
