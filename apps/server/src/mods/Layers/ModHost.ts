// FILE: ModHost.ts
// Purpose: Builds the ModManager for this server and exposes it as an Effect service.
// Layer: Mods service (Beta-only; on Stable nothing starts and every method refuses)

import * as path from "node:path";

import {
  MODS_DIRECTORY_NAME,
  type ModLogLevel,
  type ModsStreamEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { MODS_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { Effect, Layer, Queue, Stream } from "effect";

import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { shouldPublishThreadShellForEvent } from "../../orchestration/threadShellEvents.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ModHostError } from "../Errors.ts";
import type { ModProject, ModThread } from "../modApi.ts";
import { ModManager, type ModViewSource } from "../modManager.ts";
import { installModSkill, readModIconNames, resolveModSkillSourceDir } from "../modSkill.ts";
import { synaraBuiltinSkillsDir } from "../../provider/skillsCatalog.ts";
import { ModHost, type ModHostShape } from "../Services/ModHost.ts";

export function toModThread(thread: OrchestrationThreadShell): ModThread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    provider: thread.modelSelection.provider,
    model: thread.modelSelection.model,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    parentThreadId: thread.parentThreadId ?? null,
    isPinned: thread.isPinned ?? false,
    latestTurnState: thread.latestTurn?.state ?? null,
    hasPendingApprovals: thread.hasPendingApprovals ?? false,
    hasPendingUserInput: thread.hasPendingUserInput ?? false,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt ?? null,
  };
}

export function toModProject(project: OrchestrationProjectShell): ModProject {
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    kind: project.kind ?? "project",
    isPinned: project.isPinned ?? false,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

const VIEW_REFRESH_DEBOUNCE_MS = 400;

const unavailable = () =>
  new ModHostError({ message: "Mods are not available in this version of Synara." });

const toModHostError = (cause: unknown) =>
  new ModHostError({ message: cause instanceof Error ? cause.message : String(cause), cause });

export const ModHostLive = Layer.effect(
  ModHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const services = yield* Effect.services<never>();
    const runPromise = Effect.runPromiseWith(services);
    const runFork = Effect.runForkWith(services);
    const available = isServerBetaFeatureEnabled(MODS_BETA_FEATURE);

    const logModLine = (modId: string, level: ModLogLevel, message: string) => {
      const log =
        level === "error"
          ? Effect.logWarning(message)
          : level === "warn"
            ? Effect.logInfo(message)
            : Effect.logDebug(message);
      runFork(log.pipe(Effect.annotateLogs({ component: "mods", modId })));
    };

    // Mods read thread and project lists often (every redraw of a view that shows
    // them). One shared copy serves them until a change that mods can see.
    let shellCache: Promise<{
      readonly threads: ReadonlyArray<ModThread>;
      readonly projects: ReadonlyArray<ModProject>;
    }> | null = null;
    const readShell = () => {
      shellCache ??= runPromise(
        snapshotQuery.getShellSnapshot().pipe(
          Effect.map((snapshot) => ({
            threads: snapshot.threads.map(toModThread),
            projects: snapshot.projects.map(toModProject),
          })),
        ),
      ).catch((error: unknown) => {
        shellCache = null;
        throw error;
      });
      return shellCache;
    };

    const modsDir = path.join(config.baseDir, MODS_DIRECTORY_NAME);
    const skillSourceDir = available
      ? yield* Effect.promise(() => resolveModSkillSourceDir().catch(() => null))
      : null;
    // Without the list (a build missing the skill files) icon names go unchecked.
    const iconNames =
      skillSourceDir === null
        ? null
        : yield* Effect.promise(() => readModIconNames(skillSourceDir).catch(() => null));
    const manager = new ModManager({
      iconNames,
      modsDir,
      dataDir: path.join(config.stateDir, "mods"),
      backend: {
        listThreads: () => readShell().then((shell) => shell.threads),
        listProjects: () => readShell().then((shell) => shell.projects),
        log: logModLine,
      },
    });

    if (available) {
      yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => manager.start(), catch: toModHostError }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Mods could not start", error.message).pipe(
              Effect.annotateLogs({ component: "mods" }),
            ),
          ),
        ),
        () => Effect.promise(() => manager.stop()),
      );
      // The authoring skill lets any provider's agent write mods for this install.
      // It installs in the background so it does not hold up the server's start;
      // closing waits for it, so no write lands after the server is gone.
      const skillInstall = (async () => {
        if (skillSourceDir === null) throw new Error("this build has no mod skill files");
        await installModSkill({
          sourceDir: skillSourceDir,
          targetRoot: synaraBuiltinSkillsDir(config.baseDir),
          modsDir,
        });
      })().catch((error: unknown) => {
        runFork(
          Effect.logWarning(
            "The mod authoring skill could not be installed",
            error instanceof Error ? error.message : String(error),
          ).pipe(Effect.annotateLogs({ component: "mods" })),
        );
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => skillInstall));
      // Views that follow threads or projects redraw shortly after a change, once
      // per burst: a running turn emits many thread events.
      const pendingSources = new Map<ModViewSource, ReturnType<typeof setTimeout>>();
      const noteChange = (source: ModViewSource) => {
        if (pendingSources.has(source)) return;
        pendingSources.set(
          source,
          setTimeout(() => {
            pendingSources.delete(source);
            manager.notifyDataChanged(source);
          }, VIEW_REFRESH_DEBOUNCE_MS),
        );
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const timer of pendingSources.values()) clearTimeout(timer);
        }),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
          Effect.sync(() => {
            // Only changes to what mods see count: a streamed reply emits many thread
            // events that leave every listed field as it was.
            if (event.type.startsWith("thread.")) {
              if (!shouldPublishThreadShellForEvent(event)) return;
              shellCache = null;
              noteChange("threads");
            } else if (event.type.startsWith("project.")) {
              shellCache = null;
              noteChange("projects");
            }
          }),
        ),
      );
    }

    const guarded = <A>(run: () => Promise<A> | A): Effect.Effect<A, ModHostError> =>
      available
        ? Effect.tryPromise({ try: async () => run(), catch: toModHostError })
        : Effect.fail(unavailable());

    const streamEvents: ModHostShape["streamEvents"] = available
      ? Stream.callback<ModsStreamEvent, ModHostError>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const unsubscribe = manager.subscribe((event) => {
                Queue.offerUnsafe(queue, event);
              });
              Queue.offerUnsafe(queue, { type: "snapshot", snapshot: manager.snapshot() });
              return unsubscribe;
            }),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        )
      : Stream.fail(unavailable());

    return {
      available,
      list: () => guarded(() => manager.snapshot()),
      setEnabled: (input) => guarded(() => manager.setEnabled(input.id, input.enabled)),
      reload: (input) => guarded(() => manager.reload(input.id)),
      readLogs: (input) => guarded(() => manager.readLogs(input.id)),
      runCommand: (input) =>
        guarded(() => manager.runCommand(input.modId, input.command, input.threadId ?? null)),
      renderView: (input) =>
        guarded(() => manager.renderView(input.modId, input.viewId, input.context)),
      dispatchUi: (input) =>
        guarded(() => manager.dispatchUi(input.modId, input.handlerId, input.payload)),
      export: (input) => guarded(() => manager.exportMod(input.id)),
      import: (input) => guarded(() => manager.importMod(input.bundle, input.replace)),
      streamEvents,
    } satisfies ModHostShape;
  }),
);
