// FILE: modManager.test.ts
// Purpose: Runs real mods in real workers: loading, commands, hook chains,
//          failures, hung hooks, reloads, the `$` state and store, and moving a
//          mod between installs by export and import.
// Layer: Mods runtime tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ModBundle, ModsSnapshot, ModSummary } from "@synara/contracts";
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

  it("points a syntax error inside the register arrow at its own line", async () => {
    await writeMod("typo", {
      "hooks/register.tsx": [
        "export const register = (on) => {",
        '  on("mod.start", async ($) => {',
        "    const ok = 1;",
        '    await $.ui.toast("hi";',
        "  });",
        '  on("ui.render", () => <Box>{[1].map((n) => <Text>{n}</Text>)}</Box>);',
        "};",
        "",
      ].join("\n"),
    });
    await writeFile(
      path.join(modsDir, "typo", "hooks", "hooks.json"),
      JSON.stringify({ modules: ["./register.tsx"] }),
    );
    const manager = makeManager();
    const summary = await startEnabled(manager, "typo");
    expect(summary.status).toBe("error");
    expect(summary.error).toContain('hooks/register.tsx: Unexpected token, expected "," (4:26)');
    expect(summary.error).toContain(
      '  4 |     await $.ui.toast("hi";\n    |                          ^',
    );
  });

  it("tells the window when a render hook or a command fails instead of drawing nothing", async () => {
    await writeMod("faulty", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => {
            await $.ui.view({ id: "boom", site: "dock", title: "Boom" });
            await $.command.register({ name: "explode", title: "Explode" });
          });
          on("ui.render", () => { throw new Error("render broke"); });
          on("command.run", () => { throw new Error("command broke"); });
        };
      `,
    });
    const manager = makeManager();
    await startEnabled(manager, "faulty");
    await expect(
      manager.renderView("faulty", "boom", { threadId: null, projectId: null }),
    ).rejects.toThrow(/"boom" view could not be drawn: .*render broke/u);
    await expect(manager.runCommand("faulty", "explode", null)).rejects.toThrow(
      /"explode" command failed: .*command broke/u,
    );
  });

  it("refuses elements it cannot draw and drops icons that do not exist, saying so once", async () => {
    await writeMod("icons", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => {
            await $.ui.view({ id: "rail", site: "sidebar", title: "Rail", icon: "no-such-icon" });
            await $.ui.view({ id: "table", site: "dock", title: "Table" });
          });
          on("ui.render", { view: "rail" }, () => h(Box, {}, h(Row, { icon: "no-such-icon" }, "a"), h(Icon, { name: "star" }), h(Icon, { name: "missing-too" })));
          on("ui.render", { view: "table" }, () => h("Table", {}, "x"));
        };
      `,
    });
    const manager = makeManager({ iconNames: new Set(["star"]) });
    const summary = await startEnabled(manager, "icons");
    expect(summary.views.find((view) => view.id === "rail")?.icon).toBeNull();
    const context = { threadId: null, projectId: null };
    const { tree } = await manager.renderView("icons", "rail", context);
    await manager.renderView("icons", "rail", context);
    expect(tree).toEqual({
      type: "Box",
      props: {},
      children: [
        { type: "Row", props: {}, children: ["a"] },
        { type: "Icon", props: { name: "star" }, children: [] },
      ],
    });
    const warnings = manager
      .readLogs("icons")
      .logs.filter((entry) => entry.level === "warn")
      .map((entry) => entry.message);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/no icon named "no-such-icon"/u);
    expect(warnings[1]).toMatch(/no icon named "missing-too"/u);
    await expect(manager.renderView("icons", "table", context)).rejects.toThrow(
      /"Table" is not an element Synara draws/u,
    );
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
    await expect(manager.runCommand("broken", "boom", null)).rejects.toThrow(
      /"boom" command failed: .*kaboom/u,
    );
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
    await expect(manager.runCommand("spinner", "spin", null)).rejects.toThrow(
      /"spin" command failed/u,
    );
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
    // The store reaches the disk after a burst settles, and at the latest on stop.
    await manager.stop();
    const stored = JSON.parse(await readFile(path.join(dataDir, "store", "counter.json"), "utf8"));
    expect(stored).toEqual({ lastRuns: 2 });
  });

  it("keeps every key when a mod writes its store in parallel", async () => {
    await writeMod("parallel", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => { await $.command.register({ name: "fill", title: "Fill" }); });
          on("command.run", async ($) => {
            await Promise.all(Array.from({ length: 20 }, (_, i) => $.store.set("k" + i, i)));
            return { text: String((await $.store.keys()).length) };
          });
        };
      `,
    });
    const manager = makeManager();
    await startEnabled(manager, "parallel");
    await expect(manager.runCommand("parallel", "fill", null)).resolves.toEqual({ text: "20" });
    await manager.stop();
    const stored = JSON.parse(await readFile(path.join(dataDir, "store", "parallel.json"), "utf8"));
    expect(Object.keys(stored)).toHaveLength(20);
  });

  it("joins redraw requests and ignores the ones a view makes while it draws", async () => {
    await writeMod("looper", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => {
            await $.ui.view({ id: "main", site: "dock", title: "Main" });
            await $.command.register({ name: "touch", title: "Touch" });
          });
          on("ui.render", async ($) => {
            await $.state.set("drawnAt", Math.random());
            await $.ui.invalidate("main");
            return "drawn";
          });
          on("command.run", async ($) => {
            await $.state.set("a", 1);
            await $.state.set("b", 2);
            await $.state.set("b", 2);
            await $.ui.invalidate("main");
          });
        };
      `,
    });
    const manager = makeManager();
    await startEnabled(manager, "looper");
    // Registering the view asked for one first drawing; let it pass.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const invalidations: string[] = [];
    manager.subscribe((event) => {
      if (event.type === "invalidate") invalidations.push(event.viewId ?? "*");
    });
    const context = { threadId: null, projectId: null };
    await manager.renderView("looper", "main", context);
    await manager.renderView("looper", "main", context);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(invalidations).toEqual([]);
    await manager.runCommand("looper", "touch", null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(invalidations).toEqual(["*"]);
  });

  it("bounds a hook that keeps waiting on $ instead of letting it block the mod", async () => {
    await writeMod("waiter", {
      "hooks/register.ts": `
        export const register = (on) => {
          on("mod.start", async ($) => { for (;;) await $.state.get("k"); });
        };
      `,
    });
    const manager = makeManager({ hookTimeoutMs: 200, hookDeadlineMs: 600 });
    const started = Date.now();
    await startEnabled(manager, "waiter");
    expect(Date.now() - started).toBeLessThan(5_000);
    // The hook runs out of its own budget (each wait costs a little) or of the whole deadline.
    await waitFor(() =>
      manager
        .readLogs("waiter")
        .logs.some((entry) =>
          /"mod\.start" hook failed: The hook did not finish/u.test(entry.message),
        ),
    );
    await manager.setEnabled("waiter", false);
    expect(summaryOf(manager.snapshot(), "waiter").status).toBe("disabled");
  });

  it("forgets that a mod was trusted when its folder goes away", async () => {
    await writeMod("gone", {
      "hooks/register.ts": `export const register = (on) => { on("mod.start", () => undefined); };`,
    });
    const manager = makeManager({ watch: true });
    await startEnabled(manager, "gone");
    rmSync(path.join(modsDir, "gone"), { recursive: true, force: true });
    await waitFor(() => !manager.snapshot().mods.some((mod) => mod.id === "gone"));
    // New code under the old name starts off, waiting for the person.
    await writeMod("gone", {
      "hooks/register.ts": `export const register = (on) => { on("mod.start", () => undefined); };`,
    });
    await waitFor(() => manager.snapshot().mods.some((mod) => mod.id === "gone"));
    await manager.whenIdle();
    expect(summaryOf(manager.snapshot(), "gone")).toMatchObject({
      enabled: false,
      status: "disabled",
    });
    const registry = JSON.parse(await readFile(path.join(dataDir, "registry.json"), "utf8"));
    expect(registry.enabled).toEqual([]);
  });

  it("drops trust left for folders that no longer exist when it starts", async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "registry.json"),
      JSON.stringify({ version: 1, enabled: ["missing"] }),
    );
    const manager = makeManager();
    await manager.start();
    const registry = JSON.parse(await readFile(path.join(dataDir, "registry.json"), "utf8"));
    expect(registry.enabled).toEqual([]);
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

function bundleOf(
  name: string,
  files: Record<string, string>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: "synara-mod",
    formatVersion: 1,
    name,
    version: "0.1.0",
    exportedAt: "2026-10-09T00:00:00.000Z",
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      encoding: "utf8",
      content,
    })),
    ...overrides,
  };
}

function modFiles(name: string, version = "0.1.0"): Record<string, string> {
  return {
    ".synara-mod/mod.json": JSON.stringify({ name, version }),
    "hooks/hooks.json": JSON.stringify({ modules: ["./register.ts"] }),
    "hooks/register.ts": 'export const register = (on) => { on("mod.start", () => undefined); };',
  };
}

describe("ModManager export and import", () => {
  it("exports a mod without its secrets and tooling and imports it elsewhere, turned off", async () => {
    const source = await writeMod("share", {
      "hooks/register.ts": `export const register = (on) => { on("mod.start", () => undefined); };`,
      "hooks/lib/util.ts": "export const one = 1;",
      ".env": "TOKEN=secret",
      "node_modules/dep/index.js": "module.exports = 1;",
    });
    const logo = Buffer.from([0, 255, 1, 128]);
    await mkdir(path.join(source, "assets"), { recursive: true });
    await writeFile(path.join(source, "assets", "logo.bin"), logo);
    const first = makeManager();
    await first.start();

    const exported = await first.exportMod("share");
    expect(exported.filename).toBe("share.synara-mod.json");
    const bundle = JSON.parse(exported.contents) as ModBundle;
    expect(bundle).toMatchObject({ format: "synara-mod", formatVersion: 1, name: "share" });
    expect(bundle.files.map((file) => [file.path, file.encoding])).toEqual([
      [".synara-mod/mod.json", "utf8"],
      ["assets/logo.bin", "base64"],
      ["hooks/hooks.json", "utf8"],
      ["hooks/lib/util.ts", "utf8"],
      ["hooks/register.ts", "utf8"],
    ]);

    const otherMods = path.join(root, "other", "mods");
    const second = makeManager({ modsDir: otherMods, dataDir: path.join(root, "other", "state") });
    await second.start();
    const result = await second.importMod(bundle, false);
    expect(result).toMatchObject({ id: "share", replaced: false });
    expect(summaryOf(result.snapshot, "share")).toMatchObject({
      enabled: false,
      status: "disabled",
      error: null,
    });
    await expect(readFile(path.join(otherMods, "share", "assets", "logo.bin"))).resolves.toEqual(
      logo,
    );
    await expect(
      readFile(path.join(otherMods, "share", "hooks", "lib", "util.ts"), "utf8"),
    ).resolves.toBe("export const one = 1;");
    expect(await readdir(otherMods)).toEqual(["share"]);

    await second.setEnabled("share", true);
    await second.whenIdle();
    expect(summaryOf(second.snapshot(), "share").status).toBe("running");
  });

  it("replaces an installed mod only when asked, and turns it off", async () => {
    await writeMod("dup", {
      "hooks/register.ts": `export const register = (on) => { on("mod.start", () => undefined); };`,
      "hooks/old.ts": "export const old = true;",
    });
    const manager = makeManager();
    await startEnabled(manager, "dup");
    const newer = bundleOf("dup", modFiles("dup", "0.2.0"));

    await expect(manager.importMod(newer, false)).rejects.toThrow(/already installed/u);
    expect(summaryOf(manager.snapshot(), "dup")).toMatchObject({ status: "running" });

    const result = await manager.importMod(newer, true);
    expect(result.replaced).toBe(true);
    expect(summaryOf(result.snapshot, "dup")).toMatchObject({
      enabled: false,
      status: "disabled",
      version: "0.2.0",
    });
    await expect(readFile(path.join(modsDir, "dup", "hooks", "old.ts"))).rejects.toThrow();
    const registry = JSON.parse(await readFile(path.join(dataDir, "registry.json"), "utf8"));
    expect(registry.enabled).toEqual([]);
  });

  it("keeps a mod imported under a name that was enabled before turned off", async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "registry.json"),
      JSON.stringify({ version: 1, enabled: ["ghost"] }),
    );
    const manager = makeManager();
    await manager.start();

    const result = await manager.importMod(bundleOf("ghost", modFiles("ghost")), false);
    await manager.whenIdle();
    expect(summaryOf(result.snapshot, "ghost")).toMatchObject({
      enabled: false,
      status: "disabled",
    });
    const registry = JSON.parse(await readFile(path.join(dataDir, "registry.json"), "utf8"));
    expect(registry.enabled).toEqual([]);
  });

  it("refuses files that are not mods or would write outside the mod, leaving nothing behind", async () => {
    const manager = makeManager();
    await manager.start();
    const cases: Array<[unknown, RegExp]> = [
      [{ hello: "world" }, /not an exported Synara mod/u],
      [bundleOf("x", modFiles("x"), { formatVersion: 2 }), /newer version of Synara/u],
      [bundleOf("Bad Name", modFiles("x")), /damaged/u],
      [bundleOf("x", { ...modFiles("x"), "../escape.ts": "x" }), /plain relative path/u],
      [bundleOf("x", { ...modFiles("x"), "/etc/escape.ts": "x" }), /plain relative path/u],
      [bundleOf("x", { ...modFiles("x"), "hooks\\escape.ts": "x" }), /characters a path/u],
      [bundleOf("x", { ...modFiles("x"), ".env": "TOKEN=1" }), /hidden file/u],
      [bundleOf("x", { ...modFiles("x"), "Hooks/Register.ts": "x" }), /twice/u],
      [bundleOf("x", modFiles("y")), /cannot be imported: .*"y"/u],
      [bundleOf("x", { "readme.md": "hi" }), /no manifest and no hooks file/u],
    ];
    for (const [value, expected] of cases) {
      await expect(manager.importMod(value, false)).rejects.toThrow(expected);
    }
    expect(await readdir(modsDir)).toEqual([]);
    await expect(readFile(path.join(root, "escape.ts"))).rejects.toThrow();
  });
});
