import type {
  ModsReadLogsInput,
  ModsReadLogsResult,
  ModsReloadInput,
  ModsRunCommandInput,
  ModsRunCommandResult,
  ModsSetEnabledInput,
  ModsSnapshot,
  ModsStreamEvent,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ModHostError } from "../Errors.ts";

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
  /** A snapshot of every mod, then each snapshot change and toast after it. */
  readonly streamEvents: Stream.Stream<ModsStreamEvent, ModHostError>;
}

export class ModHost extends ServiceMap.Service<ModHost, ModHostShape>()(
  "synara/mods/Services/ModHost",
) {}
