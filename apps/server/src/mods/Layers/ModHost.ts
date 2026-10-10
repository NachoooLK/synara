// FILE: ModHost.ts
// Purpose: Builds the ModManager for this server and exposes it as an Effect service.
// Layer: Mods service (Beta-only; on Stable nothing starts and every method refuses)

import * as path from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MODS_DIRECTORY_NAME,
  type ModLogLevel,
  type ModsStreamEvent,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@synara/contracts";
import { MODS_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { Effect, Layer, Option, Queue, Stream } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { shouldPublishThreadShellForEvent } from "../../orchestration/threadShellEvents.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ModHostError } from "../Errors.ts";
import type { ModProject, ModThread } from "../modApi.ts";
import { ModManager, type ModViewSource } from "../modManager.ts";
import type { ModSecretVault } from "../modMcpSignIn.ts";
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

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const unavailable = () =>
  new ModHostError({ message: "Mods are not available in this version of Synara." });

/** A mod's sign-ins to its MCP servers sit with Synara's other secrets, one per mod. */
const secretName = (modId: string) => `mod-mcp-sign-ins-${modId}`;

const toModHostError = (cause: unknown) =>
  new ModHostError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
    ...(cause instanceof Error && "code" in cause && typeof cause.code === "string"
      ? { code: cause.code }
      : {}),
  });

export const ModHostLive = Layer.effect(
  ModHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const secretStore = yield* ServerSecretStore;
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
    const secrets: ModSecretVault = {
      read: (modId) =>
        runPromise(secretStore.get(secretName(modId))).then((bytes) =>
          bytes === null ? null : new TextDecoder().decode(bytes),
        ),
      write: (modId, value) =>
        runPromise(secretStore.set(secretName(modId), new TextEncoder().encode(value))),
      remove: (modId) => runPromise(secretStore.remove(secretName(modId))),
    };
    const manager = new ModManager({
      iconNames,
      secrets,
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
      // A tool call waiting for the person: mods allowed to review approvals may deny it.
      // The denial is the same command the window sends, so the provider and the thread
      // see an ordinary "declined"; a second line says which mod did it and why.
      const reviewApproval = (threadId: ThreadId, activity: OrchestrationThreadActivity) => {
        if (!manager.hasHooks("approval.requested")) return;
        const payload = asRecord(activity.payload);
        const requestId = stringOrNull(payload.requestId);
        // Synara's own computer-use consent is not a provider's tool call.
        if (requestId === null || requestId.startsWith("computer:")) return;
        runFork(
          Effect.gen(function* () {
            const thread = yield* snapshotQuery.getThreadShellById(threadId);
            // In full access nothing waits for approval, so there is nothing to deny.
            if (Option.isNone(thread) || thread.value.runtimeMode === "full-access") return;
            const denial = yield* Effect.promise(() =>
              manager.reviewApproval({
                threadId,
                requestId,
                provider: thread.value.modelSelection.provider,
                kind:
                  stringOrNull(payload.requestKind) ?? stringOrNull(payload.requestType) ?? "tool",
                toolName: stringOrNull(payload.toolName),
                title: stringOrNull(payload.title),
                detail: stringOrNull(payload.detail),
              }),
            );
            if (denial === null) return;
            const createdAt = new Date().toISOString();
            const lifecycleGeneration = stringOrNull(payload.lifecycleGeneration);
            // Fails when the person answered first; their answer stands.
            yield* orchestrationEngine.dispatch({
              type: "thread.approval.respond",
              commandId: CommandId.makeUnsafe(`server:mod-approval-deny:${activity.id}`),
              threadId,
              requestId: ApprovalRequestId.makeUnsafe(requestId),
              ...(lifecycleGeneration === null ? {} : { lifecycleGeneration }),
              decision: "decline",
              createdAt,
            });
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(`server:mod-approval-denied:${activity.id}`),
              threadId,
              activity: {
                id: EventId.makeUnsafe(`mod-approval-denied:${activity.id}`),
                tone: "approval",
                kind: "mod.approval.denied",
                summary: `Denied by the ${denial.modId} mod`,
                payload: { requestId, modId: denial.modId, detail: denial.reason },
                turnId: activity.turnId,
                createdAt,
              },
              createdAt,
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.logDebug("A mod's approval denial did not apply", String(error)).pipe(
                Effect.annotateLogs({ component: "mods" }),
              ),
            ),
          ),
        );
      };

      // What mods may watch: when things happen, never what was said or run.
      const observe = (event: OrchestrationEvent) => {
        switch (event.type) {
          case "thread.created":
            manager.observe("thread.created", {
              threadId: event.payload.threadId,
              projectId: event.payload.projectId,
              title: event.payload.title,
            });
            return;
          case "thread.turn-start-requested":
            manager.observe("turn.started", {
              threadId: event.payload.threadId,
              origin: event.payload.dispatchOrigin ?? "user",
            });
            return;
          case "thread.activity-appended": {
            const { threadId, activity } = event.payload;
            const payload = asRecord(activity.payload);
            if (activity.kind === "turn.completed") {
              manager.observe("turn.completed", {
                threadId,
                turnId: activity.turnId,
                state: stringOrNull(payload.state) ?? "completed",
              });
            } else if (activity.kind === "tool.started" || activity.kind === "tool.completed") {
              manager.observe(activity.kind, {
                threadId,
                turnId: activity.turnId,
                tool: stringOrNull(payload.title),
                kind: stringOrNull(payload.itemType),
                status: stringOrNull(payload.status),
              });
            } else if (activity.kind === "approval.requested") {
              reviewApproval(threadId, activity);
            }
            return;
          }
          default:
            return;
        }
      };

      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
          Effect.sync(() => {
            observe(event);
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
      pullRequests: {
        list: (input) => guarded(() => manager.pullRequests.list(input)),
        detail: (input) => guarded(() => manager.pullRequests.detail(input)),
        diff: (input) => guarded(() => manager.pullRequests.diff(input)),
        comment: (input) => guarded(() => manager.pullRequests.comment(input)),
        action: (input) => guarded(() => manager.pullRequests.action(input)),
        setPinned: (input) => guarded(() => manager.pullRequests.setPinned(input)),
      },
      setEnabled: (input) =>
        guarded(() =>
          manager.setEnabled(input.id, input.enabled, { reloadOnChange: input.reloadOnChange }),
        ),
      reload: (input) => guarded(() => manager.reload(input.id)),
      readLogs: (input) => guarded(() => manager.readLogs(input.id)),
      runCommand: (input) =>
        guarded(() => manager.runCommand(input.modId, input.command, input.threadId ?? null)),
      renderView: (input) =>
        guarded(() => manager.renderView(input.modId, input.viewId, input.context)),
      dispatchUi: (input) =>
        guarded(() => manager.dispatchUi(input.modId, input.handlerId, input.payload)),
      hasHooks: (event) => available && manager.hasHooks(event),
      submitPrompt: (input, maxChars) =>
        available
          ? Effect.promise(() =>
              manager.submitPrompt(input, maxChars).catch(
                // Never let a mod cost the person their message.
                () => ({ kind: "send" as const, text: input.text, changedBy: [] }),
              ),
            )
          : Effect.succeed({ kind: "send" as const, text: input.text, changedBy: [] }),
      agentTools: () => (available ? manager.agentTools() : []),
      callAgentTool: (input) =>
        guarded(() => manager.callAgentTool(input.servedName, input.arguments, input.threadId)),
      export: (input) => guarded(() => manager.exportMod(input.id)),
      import: (input) => guarded(() => manager.importMod(input.bundle, input.replace)),
      mcpSignIn: (input) => guarded(() => manager.beginMcpSignIn(input.id, input.server)),
      mcpSignOut: (input) => guarded(() => manager.signOutMcp(input.id, input.server)),
      streamEvents,
    } satisfies ModHostShape;
  }),
);
