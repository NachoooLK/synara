// FILE: modManager.test.ts
// Purpose: Runs real mods in real workers: loading, commands, hook chains,
//          failures, hung hooks, reloads and the `$` state and store.
// Layer: Mods runtime tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ModsSnapshot, ModSummary } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModProject, ModThread } from "./modApi.ts";
import { ModManager, matchesModEvent, type ModManagerOptions } from "./modManager.ts";

let root: string;
let modsDir: string;
let dataDir: string;
const managers: ModManager[] = [];

const THREADS: ModThread[] = [
  {
    id: "thread-old",
    projectId: "project-a",
    title: "Older chat",
    provider: "codex",
    model: "gpt",
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    isPinned: false,
    latestTurnState: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
  },
  {
    id: "thread-new",
    projectId: "project-b",
    title: "Newer chat",
    provider: "claudeAgent",
    model: "opus",
    branch: "main",
    worktreePath: null,
    parentThreadId: null,
    isPinned: true,
    latestTurnState: "completed",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    archivedAt: null,
  },
];

const PROJECTS: ModProject[] = [
  {
    id: "project-a",
    title: "Project A",
    workspaceRoot: "/tmp/a",
    kind: "project",
    isPinned: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
];

function makeManager(options: Partial<ModManagerOptions> = {}): ModManager {
  const manager = new ModManager({
    modsDir,
    dataDir,
    watch: false,
    backend: {
      listThreads: async () => THREADS,
      listProjects: async () => PROJECTS,
      log: () => undefined,
    },
    ...options,
  });
  managers.push(manager);
  return manager;
}

async function writeMod(
  id: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = { name: id, version: "0.1.0" },
): Promise<string> {
  const modRoot = path.join(modsDir, id);
  await mkdir(path.join(modRoot, ".synara-mod"), { recursive: true });
  await mkdir(path.join(modRoot, "hooks"), { recursive: true });
  await writeFile(path.join(modRoot, ".synara-mod", "mod.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(modRoot, "hooks", "hooks.json"),
    JSON.stringify({ modules: ["./register.ts"] }),
  );
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(modRoot, relative)), { recursive: true });
    await writeFile(path.join(modRoot, relative), contents);
  }
  return modRoot;
}

function summaryOf(snapshot: ModsSnapshot, id: string): ModSummary {
  const summary = snapshot.mods.find((mod) => mod.id === id);
  if (!summary) throw new Error(`No mod ${id} in the snapshot.`);
  return summary;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startEnabled(manager: ModManager, id: string): Promise<ModSummary> {
  await manager.start();
  const snapshot = await manager.setEnabled(id, true);
  await manager.whenIdle();
  return summaryOf(manager.snapshot(), id) ?? summaryOf(snapshot, id);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "synara-mods-test-"));
  modsDir = path.join(root, "mods");
  dataDir = path.join(root, "state", "mods");
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  rmSync(root, { recursive: true, force: true });
});

describe("matchesModEvent", () => {
  it("matches every listed field, lists as any-of and nested objects by field", () => {
    expect(matchesModEvent(null, { command: "a" })).toBe(true);
    expect(matchesModEvent({ command: "a" }, { command: "a", threadId: null })).toBe(true);
    expect(matchesModEvent({ command: "b" }, { command: "a" })).toBe(false);
    expect(matchesModEvent({ command: ["a", "b"] }, { command: "b" })).toBe(true);
    expect(matchesModEvent({ props: { kind: "x" } }, { props: { kind: "x", other: 1 } })).toBe(
      true,
    );
    expect(matchesModEvent({ props: { kind: "x" } }, { props: null })).toBe(false);
  });
});

describe("ModManager", () => {
  it("lists a new mod as disabled until it is enabled, then runs it", async () => {
    await writeMod("hello", {
      "hooks/register.ts": `
        import type { Register } from "synara";
        import { greeting } from "./greeting";
        export const register: Register = (on) => {
          on("mod.start", async ($) => {
            await $.command.register({ name: "greet", title: "Greet" });
            await $.ui.status("ready");
          });
          on("command.run", { command: "greet" }, async ($, e) => ({ text: greeting(e.threadId) }));
        };
      `,
      "hooks/greeting.ts": `export const greeting = (threadId: string | null): string => "hi " + threadId;`,
    });
    const manager = makeManager();
    await manager.start();
    expect(summaryOf(manager.snapshot(), "hello")).toMatchObject({
      enabled: false,
      status: "disabled",
      version: "0.1.0",
    });

    const summary = await startEnabled(manager, "hello");
    expect(summary).toMatchObject({
      enabled: true,
      status: "running",
      error: null,
      hooks: ["mod.start", "command.run"],
      commands: [{ name: "greet", title: "Greet", description: null }],
      statusText: "ready",
    });
    await expect(manager.runCommand("hello", "greet", "thread-1")).resolves.toEqual({
      text: "hi thread-1",
    });
    await expect(manager.runCommand("hello", "missing", null)).rejects.toThrow(/no "missing"/u);
  });

  it("remembers enabled mods across restarts", async () => {
    await writeMod("keeper", {
      "hooks/register.ts": `export const register = (on) => { on("mod.start", () => undefined); };`,
    });
    const first = makeManager();
    await startEnabled(first, "keeper");
    await first.stop();
    const registry = JSON.parse(await readFile(path.join(dataDir, "registry.json"), "utf8"));
    expect(registry).toEqual({ version: 1, enabled: ["keeper"] });

    const second = makeManager();
    await second.start();
    await second.whenIdle();
    expect(summaryOf(second.snapshot(), "keeper").status).toBe("running");
  });

  it("reports manifest and import errors instead of loading", async () => {
    await writeMod(
      "mismatch",
      { "hooks/register.ts": "export const register = () => {};" },
      {
        name: "other-name",
        version: "1.0.0",
      },
    );
    await writeMod("bare-import", {
      "hooks/register.ts": `import fs from "node:fs"; export const register = () => { void fs; };`,
    });
    const manager = makeManager();
    await manager.start();
    await manager.setEnabled("mismatch", true);
    await manager.setEnabled("bare-import", true);
    await manager.whenIdle();
    const snapshot = manager.snapshot();
    expect(summaryOf(snapshot, "mismatch")).toMatchObject({ status: "error" });
    expect(summaryOf(snapshot, "mismatch").error).toMatch(/must match/u);
    expect(summaryOf(snapshot, "bare-import")).toMatchObject({ status: "error" });
    expect(summaryOf(snapshot, "bare-import").error).toMatch(/only their own files and "synara"/u);
  });

  it("drops a failing hook from the chain and logs why", async () => {
    await writeMod("broken", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => { await $.command.register({ name: "boom", title: "Boom" }); });
          on("command.run", () => { throw new Error("kaboom"); });
        };
      `,
    });
    const manager = makeManager();
    await startEnabled(manager, "broken");
    await expect(manager.runCommand("broken", "boom", null)).resolves.toEqual({ text: null });
    const { logs } = manager.readLogs("broken");
    expect(logs.some((entry) => entry.level === "error" && entry.message.includes("kaboom"))).toBe(
      true,
    );
    expect(summaryOf(manager.snapshot(), "broken").status).toBe("running");
  });

  it("stops a mod whose hook blocks its worker", async () => {
    await writeMod("spinner", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => { await $.command.register({ name: "spin", title: "Spin" }); });
          on("command.run", () => { while (true) {} });
        };
      `,
    });
    const manager = makeManager({ hookTimeoutMs: 200 });
    await startEnabled(manager, "spinner");
    await expect(manager.runCommand("spinner", "spin", null)).resolves.toEqual({ text: null });
    await waitFor(() => summaryOf(manager.snapshot(), "spinner").status === "error");
    expect(summaryOf(manager.snapshot(), "spinner").error).toMatch(/ran synchronously/u);
  });

  it("runs a dispatched event through every mod in order, letting each rewrite it", async () => {
    await writeMod("a-first", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("test.event", async ($, e, next) => {
            const result = await next({ ...e, path: [...e.path, "a"] });
            return { ...result, wrappedBy: "a" };
          });
        };
      `,
    });
    await writeMod("b-second", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("test.event", { kind: "x" }, async ($, e, next) => next({ ...e, path: [...e.path, "b"] }));
          on("test.event", { kind: "never" }, () => ({ skipped: true }));
        };
      `,
    });
    const manager = makeManager();
    await manager.start();
    await manager.setEnabled("a-first", true);
    await manager.setEnabled("b-second", true);
    await manager.whenIdle();
    const result = await manager.dispatch("test.event", { kind: "x", path: [] }, async (input) => ({
      seen: (input as { path: string[] }).path,
    }));
    expect(result).toEqual({ seen: ["a", "b"], wrappedBy: "a" });
  });

  it("keeps $.state across reloads and $.store on disk", async () => {
    await writeMod("counter", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => {
            await $.command.register({ name: "bump", title: "Bump" });
            const runs = ((await $.state.get("runs")) ?? 0) + 1;
            await $.state.set("runs", runs);
            await $.store.set("lastRuns", runs);
          });
          on("command.run", async ($) => {
            const threads = await $.threads.list({ limit: 1 });
            const projects = await $.projects.list();
            return { text: [await $.state.get("runs"), await $.store.get("lastRuns"), threads[0].id, projects.length].join(",") };
          });
        };
      `,
    });
    const manager = makeManager();
    await startEnabled(manager, "counter");
    await manager.reload("counter");
    await expect(manager.runCommand("counter", "bump", null)).resolves.toEqual({
      text: "2,2,thread-new,1",
    });
    const stored = JSON.parse(await readFile(path.join(dataDir, "store", "counter.json"), "utf8"));
    expect(stored).toEqual({ lastRuns: 2 });
  });

  it("reloads a mod when its files change", async () => {
    const modRoot = await writeMod("live", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => { await $.command.register({ name: "version", title: "Version" }); });
          on("command.run", () => ({ text: "one" }));
        };
      `,
    });
    const manager = makeManager({ watch: true });
    await startEnabled(manager, "live");
    await expect(manager.runCommand("live", "version", null)).resolves.toEqual({ text: "one" });

    const firstLoad = summaryOf(manager.snapshot(), "live").loadedAt;
    await writeFile(
      path.join(modRoot, "hooks", "register.ts"),
      `
        export const register = (on) => {
          on("mod.start", async ($) => { await $.command.register({ name: "version", title: "Version" }); });
          on("command.run", () => ({ text: "two" }));
        };
      `,
    );
    await waitFor(() => {
      const summary = summaryOf(manager.snapshot(), "live");
      return (
        summary.status === "running" &&
        summary.loadedAt !== firstLoad &&
        summary.commands.length > 0
      );
    });
    await manager.whenIdle();
    await expect(manager.runCommand("live", "version", null)).resolves.toEqual({ text: "two" });
  });

  it("draws a view, runs its handlers and asks for redraws", async () => {
    await writeMod("panel", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => {
            await $.ui.view({ id: "threads", site: "sidebar", title: "My threads", icon: "list", refreshOn: ["threads", "bogus"] });
          });
          on("ui.render", { view: "threads" }, async ($, e) => {
            const threads = await $.threads.list();
            const selected = (await $.state.get("selected")) ?? "none";
            return [
              h("Text", { tone: "muted" }, "Selected: ", selected),
              ...threads.map((thread) =>
                h("Row", { key: thread.id, onPress: async () => {
                  await $.state.set("selected", thread.id);
                  await $.ui.openThread(thread.id);
                } }, thread.title),
              ),
              e.context.threadId,
            ];
          });
        };
      `,
    });
    const manager = makeManager();
    const summary = await startEnabled(manager, "panel");
    expect(summary.views).toEqual([
      { id: "threads", site: "sidebar", title: "My threads", icon: "list", refreshOn: ["threads"] },
    ]);
    const events: unknown[] = [];
    manager.subscribe((event) => events.push(event));

    const { tree } = await manager.renderView("panel", "threads", {
      threadId: "thread-open" as never,
      projectId: null,
    });
    expect(tree).toMatchObject({
      type: "Fragment",
      children: [
        { type: "Text", props: { tone: "muted" }, children: ["Selected: ", "none"] },
        { type: "Row", props: { key: "thread-new", onPress: { $handler: expect.any(String) } } },
        { type: "Row", props: { key: "thread-old" }, children: ["Older chat"] },
        "thread-open",
      ],
    });
    const handlerId = (tree as { children: Array<{ props?: { onPress?: { $handler: string } } }> })
      .children[1]?.props?.onPress?.$handler as string;

    await expect(manager.dispatchUi("panel", handlerId, null)).resolves.toEqual({
      effects: [{ type: "openThread", threadId: "thread-new" }],
    });
    await waitFor(() =>
      events.some(
        (event) =>
          (event as { type: string }).type === "invalidate" &&
          (event as { modId: string }).modId === "panel",
      ),
    );
    const redrawn = await manager.renderView("panel", "threads", {
      threadId: null,
      projectId: null,
    });
    expect(JSON.stringify(redrawn.tree)).toContain("thread-new");

    events.length = 0;
    manager.notifyDataChanged("threads");
    manager.notifyDataChanged("projects");
    expect(events).toEqual([{ type: "invalidate", modId: "panel", viewId: "threads" }]);

    await manager.reload("panel");
    await expect(manager.dispatchUi("panel", handlerId, null)).rejects.toThrow(/out of date/u);
  });

  it("refuses effects outside handlers and trees it cannot draw", async () => {
    await writeMod("strict", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => {
            await $.ui.view({ id: "bad", site: "dock", title: "Bad" });
            await $.command.register({ name: "open", title: "Open" });
          });
          on("ui.render", { view: "bad" }, () => ({ props: {} }));
          on("command.run", async ($) => {
            try {
              await $.ui.openThread("thread-new");
              return { text: "opened" };
            } catch (error) {
              return { text: error.message };
            }
          });
        };
      `,
    });
    const manager = makeManager();
    await startEnabled(manager, "strict");
    await expect(
      manager.renderView("strict", "bad", { threadId: null, projectId: null }),
    ).rejects.toThrow(/no type/u);
    await expect(
      manager.renderView("strict", "missing", { threadId: null, projectId: null }),
    ).rejects.toThrow(/no view named "missing"/u);
    await expect(manager.runCommand("strict", "open", null)).resolves.toEqual({
      text: "$.ui.openThread() works only inside a handler of a view, such as an onPress.",
    });
  });
});
