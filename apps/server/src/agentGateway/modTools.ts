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

export function makeAgentGatewayModTools(modHost: ModHostShape): ReadonlyArray<ToolEntry> {
  const listMods: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_mods_list",
      description:
        "List the Synara mods in the mods folder with their status (disabled, starting, running, error), load or runtime error, registered views and commands, and the mods folder path. Use it after writing or editing a mod to see whether it loaded. A new mod is disabled until the person enables it in Settings → Mods.",
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
        "Reload an enabled Synara mod: read its files again and restart it. Synara already reloads a mod when its files change; use this after a failure or to start over with a fresh worker.",
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
          return { modId, status: mod?.status ?? "missing", error: mod?.error ?? null };
        },
      );
    },
  };

  return [listMods, readLogs, renderView, reloadMod];
}
