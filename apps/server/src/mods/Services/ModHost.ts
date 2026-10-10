import type {
  ModsDispatchUiInput,
  ModsDispatchUiResult,
  ModsExportInput,
  ModsExportResult,
  ModsImportInput,
  ModsImportResult,
  ModsMcpSignInInput,
  ModsMcpSignInResult,
  ModsMcpSignOutInput,
  ModsReadLogsInput,
  ModsReadLogsResult,
  ModsReloadInput,
  ModsRenderViewInput,
  ModsRenderViewResult,
  ModsRunCommandInput,
  ModsRunCommandResult,
  ModsSetEnabledInput,
  ModsSnapshot,
  ModsStreamEvent,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ModHostError } from "../Errors.ts";
import type { ModAgentTool, ModPromptInput, ModPromptOutcome } from "../modManager.ts";

export interface ModHostShape {
  /** False on Stable, where mods are Beta-only and every method refuses. */
  readonly available: boolean;
  readonly list: () => Effect.Effect<ModsSnapshot, ModHostError>;
  readonly setEnabled: (input: ModsSetEnabledInput) => Effect.Effect<ModsSnapshot, ModHostError>;
  readonly reload: (input: ModsReloadInput) => Effect.Effect<ModsSnapshot, ModHostError>;
  readonly readLogs: (input: ModsReadLogsInput) => Effect.Effect<ModsReadLogsResult, ModHostError>;
  readonly runCommand: (
    input: ModsRunCommandInput,
  ) => Effect.Effect<ModsRunCommandResult, ModHostError>;
  readonly renderView: (
    input: ModsRenderViewInput,
  ) => Effect.Effect<ModsRenderViewResult, ModHostError>;
  readonly dispatchUi: (
    input: ModsDispatchUiInput,
  ) => Effect.Effect<ModsDispatchUiResult, ModHostError>;
  readonly export: (input: ModsExportInput) => Effect.Effect<ModsExportResult, ModHostError>;
  readonly import: (input: ModsImportInput) => Effect.Effect<ModsImportResult, ModHostError>;
  /** Starts the person's sign-in to one of a mod's MCP servers; the page to open comes back. */
  readonly mcpSignIn: (
    input: ModsMcpSignInInput,
  ) => Effect.Effect<ModsMcpSignInResult, ModHostError>;
  readonly mcpSignOut: (input: ModsMcpSignOutInput) => Effect.Effect<ModsSnapshot, ModHostError>;
  /** A snapshot of every mod, then each snapshot change, toast and redraw request after it. */
  readonly streamEvents: Stream.Stream<ModsStreamEvent, ModHostError>;
  /** Whether a running mod hooks `event` and may; false where mods are off. Cheap, for hot paths. */
  readonly hasHooks: (event: string) => boolean;
  /**
   * Runs a message a person is sending through the `prompt.submit` hooks. Never
   * fails: a mod's mistake leaves the message as written.
   */
  readonly submitPrompt: (
    input: ModPromptInput,
    maxChars: number,
  ) => Effect.Effect<ModPromptOutcome>;
  /** The tools running mods give to agents, read on every listing. */
  readonly agentTools: () => ReadonlyArray<ModAgentTool>;
  readonly callAgentTool: (input: {
    readonly servedName: string;
    readonly arguments: Record<string, unknown>;
    readonly threadId: string | null;
  }) => Effect.Effect<unknown, ModHostError>;
}

export class ModHost extends ServiceMap.Service<ModHost, ModHostShape>()(
  "synara/mods/Services/ModHost",
) {}
