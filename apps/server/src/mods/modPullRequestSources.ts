// Registration ownership, validation and scheduling for native Code review sources.
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  ModPullRequestDetail,
  ModPullRequestListResult,
  ModPullRequestMutationResult,
  ModPullRequestSourceDefinition,
  PullRequestDiffResult,
  ModsPullRequestActionInput,
  ModsPullRequestCommentInput,
  ModsPullRequestDetailInput,
  ModsPullRequestDiffInput,
  ModsPullRequestListInput,
  ModsPullRequestSetPinnedInput,
  type ModPullRequestSourceSummary,
  ModPullRequestSourceRef,
  type ModPullRequestListEntry,
  type ModPullRequestProjectContext,
  type ModsPullRequestListResult,
  type ModsPullRequestDetailResult,
  type ModsPullRequestSetPinnedResult,
} from "@synara/contracts";
import { MOD_HOOK_DEADLINE_MS } from "./modWorkerHost";
import type { ModProject } from "./modApi";
import type { ModPullRequestPins } from "./modPullRequestPins";

type Invoke = (event: string, input: unknown) => Promise<unknown>;
interface Source {
  readonly summary: ModPullRequestSourceSummary;
  readonly generation: number;
  readonly invoke: Invoke;
  active: number;
  readonly queue: Array<() => void>;
  readonly reads: Map<string, Promise<unknown>>;
  readonly writes: Map<string, Promise<unknown>>;
}
interface Options {
  readonly pins: ModPullRequestPins;
  readonly projects: () => Promise<ReadonlyArray<ModProject>>;
  readonly onChange: (modId: string, sourceId: string | null) => void;
  readonly log: (modId: string, message: string) => void;
}
const sourceKey = (modId: string, sourceId: string) => JSON.stringify([modId, sourceId]);
export class ModPullRequestSources {
  private readonly sources = new Map<string, Source>();
  constructor(private readonly options: Options) {}
  register(modId: string, generation: number, value: unknown, invoke: Invoke): void {
    const definition = Schema.decodeUnknownSync(ModPullRequestSourceDefinition)(value);
    const previous = this.sources.get(sourceKey(modId, definition.id));
    if (
      previous?.generation === generation &&
      previous.summary.title === definition.title &&
      JSON.stringify(previous.summary.capabilities) === JSON.stringify(definition.capabilities)
    )
      return;
    this.replace(modId, generation, definition, invoke);
  }
  private replace(
    modId: string,
    generation: number,
    definition: ModPullRequestSourceDefinition,
    invoke: Invoke,
  ): void {
    const source = Schema.decodeUnknownSync(ModPullRequestSourceRef)({
      kind: "mod",
      modId,
      sourceId: definition.id,
    });
    const id = sourceKey(modId, definition.id);
    if (!this.sources.has(id) && this.summaries(modId).length >= 10)
      throw new Error("A mod may register at most ten pull request sources.");
    this.sources
      .get(id)
      ?.queue.splice(0)
      .forEach((resolve) => resolve());
    this.sources.set(id, {
      summary: {
        source,
        title: definition.title,
        capabilities: definition.capabilities,
        revision: randomUUID(),
      },
      generation,
      invoke,
      active: 0,
      queue: [],
      reads: new Map(),
      writes: new Map(),
    });
    this.options.onChange(modId, definition.id);
  }
  unregister(modId: string, sourceId: string): void {
    const id = sourceKey(modId, sourceId);
    const previous = this.sources.get(id);
    if (this.sources.delete(id)) {
      previous?.queue.splice(0).forEach((resolve) => resolve());
      this.options.onChange(modId, sourceId);
    }
  }
  withdrawMod(modId: string): void {
    for (const source of this.summaries(modId)) this.unregister(modId, source.source.sourceId);
  }
  summaries(modId: string): ModPullRequestSourceSummary[] {
    return [...this.sources.values()]
      .filter((source) => source.summary.source.modId === modId)
      .map((source) => source.summary);
  }
  authenticationChanged(modId: string): void {
    for (const source of [...this.sources.values()]) {
      if (source.summary.source.modId !== modId) continue;
      this.replace(
        modId,
        source.generation,
        {
          id: source.summary.source.sourceId,
          title: source.summary.title,
          capabilities: source.summary.capabilities,
        },
        source.invoke,
      );
    }
  }
  invalidate(modId: string, sourceId?: string): void {
    if (sourceId !== undefined) this.require({ modId, sourceId });
    this.options.onChange(modId, sourceId ?? null);
  }
  private require(input: { modId: string; sourceId: string }): Source {
    const source = this.sources.get(sourceKey(input.modId, input.sourceId));
    if (!source)
      throw new Error(
        "This mod pull request source is unavailable; it may be disabled or reloading.",
      );
    return source;
  }
  private current(source: Source, remoteWriteMayHaveCompleted = false): void {
    const ref = source.summary.source;
    if (this.sources.get(sourceKey(ref.modId, ref.sourceId)) !== source)
      throw new Error(
        "This source was withdrawn or changed while the request was running." +
          (remoteWriteMayHaveCompleted
            ? " A remote write may already have completed; do not retry automatically."
            : ""),
      );
  }
  private async invoke(source: Source, event: string, input: unknown): Promise<unknown> {
    this.current(source);
    try {
      const result = await source.invoke(event, input);
      this.current(source, event === "pullRequests.comment" || event === "pullRequests.action");
      return result;
    } catch (error) {
      this.options.log(
        source.summary.source.modId,
        `${event}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
  private read<T>(
    source: Source,
    event: string,
    input: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([event, input]);
    const pending = source.reads.get(key);
    if (pending) return pending as Promise<T>;
    const result = (async () => {
      if (source.active >= 4) await new Promise<void>((resolve) => source.queue.push(resolve));
      this.current(source);
      source.active++;
      try {
        return await run();
      } finally {
        source.active--;
        source.queue.shift()?.();
      }
    })();
    source.reads.set(key, result);
    void result.finally(() => source.reads.delete(key)).catch(() => undefined);
    return result;
  }
  private write<T>(
    source: Source,
    input: { repository: string; itemId: string },
    run: () => Promise<T>,
    cancelled?: AbortSignal,
  ): Promise<T> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(MOD_HOOK_DEADLINE_MS),
      ...(cancelled ? [cancelled] : []),
    ]);
    let dispatched = false;
    const key = JSON.stringify([input.repository, input.itemId]);
    const result = (source.writes.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        signal.throwIfAborted();
        this.current(source);
        dispatched = true;
        return run();
      });
    source.writes.set(key, result);
    void result
      .finally(() => {
        if (source.writes.get(key) === result) source.writes.delete(key);
      })
      .catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      const abort = () =>
        reject(
          new Error(
            dispatched
              ? "The request was cancelled after dispatch. The remote write may have completed; do not retry automatically."
              : "The queued write was cancelled before dispatch.",
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private async decorate<T extends ModPullRequestListEntry>(
    source: Source,
    item: T,
  ): Promise<T & { projectContexts: ModPullRequestProjectContext[]; isPinned: boolean }> {
    const projects = await this.options.projects();
    this.current(source);
    const projectContexts = [...new Set(item.projectIds)].map((id) => {
      const project = projects.find((project) => project.id === id);
      if (!project) throw new Error(`Unknown local project association: ${id}`);
      return {
        projectId: id as ModPullRequestProjectContext["projectId"],
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
      };
    });
    return {
      ...item,
      projectContexts,
      isPinned: this.options.pins.isPinned(source.summary.source, item),
    };
  }
  async list(value: ModsPullRequestListInput): Promise<ModsPullRequestListResult> {
    const { modId, ...input } = Schema.decodeUnknownSync(ModsPullRequestListInput)(value);
    const source = this.require({ modId, sourceId: input.sourceId });
    return this.read(source, "pullRequests.list", input, async () => {
      const result = Schema.decodeUnknownSync(ModPullRequestListResult)(
        await this.invoke(source, "pullRequests.list", input),
      );
      if (result.items.length > input.limit)
        throw new Error("The source returned more items than the requested page limit.");
      if (
        result.items.some((item) =>
          input.state === "open" ? item.state !== "open" : item.state === "open",
        )
      )
        throw new Error("The source returned an item outside the requested state.");
      const items = await Promise.all(result.items.map((item) => this.decorate(source, item)));
      this.current(source);
      return { ...result, items, source: source.summary.source, revision: source.summary.revision };
    });
  }
  async detail(value: ModsPullRequestDetailInput): Promise<ModsPullRequestDetailResult> {
    const { modId, ...input } = Schema.decodeUnknownSync(ModsPullRequestDetailInput)(value);
    const source = this.require({ modId, sourceId: input.sourceId });
    return this.read(source, "pullRequests.detail", input, async () => {
      const result = Schema.decodeUnknownSync(ModPullRequestDetail)(
        await this.invoke(source, "pullRequests.detail", {
          ...input,
          forceRefresh: input.forceRefresh === true,
        }),
      );
      if (result.repository !== input.repository || result.itemId !== input.itemId)
        throw new Error("The source returned a different item identity.");
      const decorated = await this.decorate(source, result);
      return { ...decorated, source: source.summary.source, revision: source.summary.revision };
    });
  }
  async diff(value: ModsPullRequestDiffInput): Promise<PullRequestDiffResult> {
    const { modId, ...input } = Schema.decodeUnknownSync(ModsPullRequestDiffInput)(value);
    const source = this.require({ modId, sourceId: input.sourceId });
    if (!source.summary.capabilities.diff) throw new Error("Diff is unsupported by this source.");
    return this.read(source, "pullRequests.diff", input, async () =>
      Schema.decodeUnknownSync(PullRequestDiffResult)(
        await this.invoke(source, "pullRequests.diff", input),
      ),
    );
  }
  async comment(
    value: ModsPullRequestCommentInput,
    signal?: AbortSignal,
  ): Promise<ModPullRequestMutationResult> {
    const { modId, ...input } = Schema.decodeUnknownSync(ModsPullRequestCommentInput)(value);
    const source = this.require({ modId, sourceId: input.sourceId });
    if (!source.summary.capabilities.comment)
      throw new Error("Comment is unsupported by this source.");
    return this.write(
      source,
      input,
      async () =>
        Schema.decodeUnknownSync(ModPullRequestMutationResult)(
          await this.invoke(source, "pullRequests.comment", input),
        ),
      signal,
    );
  }
  async action(
    value: ModsPullRequestActionInput,
    signal?: AbortSignal,
  ): Promise<ModPullRequestMutationResult> {
    const { modId, ...input } = Schema.decodeUnknownSync(ModsPullRequestActionInput)(value);
    const source = this.require({ modId, sourceId: input.sourceId });
    const capabilities = source.summary.capabilities;
    if (
      !capabilities.actions.includes(input.action) ||
      (input.action === "merge" &&
        (!input.mergeMethod || !capabilities.mergeMethods.includes(input.mergeMethod)))
    )
      throw new Error("This action or merge method is unsupported by the source.");
    return this.write(
      source,
      input,
      async () =>
        Schema.decodeUnknownSync(ModPullRequestMutationResult)(
          await this.invoke(source, "pullRequests.action", input),
        ),
      signal,
    );
  }
  async setPinned(value: ModsPullRequestSetPinnedInput): Promise<ModsPullRequestSetPinnedResult> {
    const input = Schema.decodeUnknownSync(ModsPullRequestSetPinnedInput)(value);
    const source = this.require(input);
    await this.options.pins.setPinned(source.summary.source, input, input.isPinned);
    this.current(source);
    this.options.onChange(input.modId, input.sourceId);
    return {
      source: source.summary.source,
      repository: input.repository,
      itemId: input.itemId,
      isPinned: input.isPinned,
    };
  }
}
