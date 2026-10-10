// FILE: modSkill.test.ts
// Purpose: Keeps the mod authoring skill honest: it installs with this machine's
//          paths, its examples type-check against the published types, and each
//          example loads and runs as a real mod.
// Layer: Mods runtime tests

import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import ts from "typescript";
import { Schema } from "effect";
import { ModsPullRequestListInput } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModProject, ModThread } from "./modApi.ts";
import { ModManager } from "./modManager.ts";
import { installModSkill, MOD_SKILL_NAME, resolveModSkillSourceDir } from "./modSkill.ts";

let root: string;
const managers: ModManager[] = [];

const THREAD: ModThread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Fix the login bug",
  provider: "codex",
  model: "gpt",
  branch: null,
  worktreePath: null,
  parentThreadId: null,
  isPinned: true,
  latestTurnState: "completed",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  createdAt: "2026-10-09T08:00:00.000Z",
  updatedAt: "2026-10-09T09:00:00.000Z",
  archivedAt: null,
};

const PROJECT: ModProject = {
  id: "project-1",
  title: "Demo",
  workspaceRoot: "/tmp/demo",
  kind: "project",
  isPinned: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

async function skillSourceDir(): Promise<string> {
  const dir = await resolveModSkillSourceDir();
  if (dir === null) throw new Error("The mod skill source folder is missing.");
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "synara-mod-skill-test-"));
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  rmSync(root, { recursive: true, force: true });
});

describe("installModSkill", () => {
  it("installs the skill with this machine's paths and skips an unchanged copy", async () => {
    const targetRoot = path.join(root, "builtin-skills");
    const modsDir = path.join(root, "mods");
    const first = await installModSkill({ sourceDir: await skillSourceDir(), targetRoot, modsDir });
    expect(first).toEqual({ installed: true, skillDir: path.join(targetRoot, MOD_SKILL_NAME) });

    const skill = await readFile(path.join(first.skillDir, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: synara-mods\n/u);
    expect(skill).toContain(`Mods folder: \`${modsDir}\``);
    expect(skill).not.toContain("{{");
    const tsconfig = JSON.parse(
      await readFile(path.join(first.skillDir, "reference", "tsconfig.json"), "utf8"),
    );
    expect(tsconfig.compilerOptions.paths.synara).toEqual([
      path.join(first.skillDir, "types", "synara.d.ts"),
    ]);

    const second = await installModSkill({
      sourceDir: await skillSourceDir(),
      targetRoot,
      modsDir,
    });
    expect(second.installed).toBe(false);

    await writeFile(path.join(first.skillDir, "stale.txt"), "left over");
    const changedSource = path.join(root, "source");
    await cp(await skillSourceDir(), changedSource, { recursive: true });
    await writeFile(path.join(changedSource, "SKILL.md"), `${skill}\nOne more line.\n`);
    const third = await installModSkill({ sourceDir: changedSource, targetRoot, modsDir });
    expect(third.installed).toBe(true);
    await expect(readdir(first.skillDir)).resolves.not.toContain("stale.txt");
  });
});

describe("example mods", () => {
  it("loads and queries the native source example", async () => {
    const modsDir = path.join(root, "mods");
    await cp(
      path.join(await skillSourceDir(), "examples", "native-pr-source"),
      path.join(modsDir, "native-pr-source"),
      { recursive: true },
    );
    const manager = new ModManager({
      modsDir,
      dataDir: path.join(root, "state"),
      watch: false,
      backend: {
        listThreads: async () => [],
        listProjects: async () => [PROJECT],
        log: () => undefined,
      },
    });
    managers.push(manager);
    await manager.start();
    await manager.setEnabled("native-pr-source", true);
    await manager.whenIdle();
    const mod = manager.snapshot().mods[0]!;
    expect([mod.status, mod.error, mod.views]).toEqual(["running", null, []]);
    expect(mod.pullRequestSources.map((source) => source.source.sourceId)).toEqual([
      "team-reviews",
    ]);
    const source = { modId: mod.id, sourceId: "team-reviews" };
    const page = await manager.pullRequests.list(
      Schema.decodeUnknownSync(ModsPullRequestListInput)({
        ...source,
        state: "open",
        sort: "updated",
        limit: 1,
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const second = await manager.pullRequests.list(
      Schema.decodeUnknownSync(ModsPullRequestListInput)({
        ...source,
        state: "open",
        sort: "updated",
        limit: 1,
        cursor: page.nextCursor,
      }),
    );
    expect(second.items[0]?.itemId).not.toBe(page.items[0]?.itemId);
    const identity = {
      ...source,
      repository: page.items[0]!.repository,
      itemId: page.items[0]!.itemId,
    };
    const detail = await manager.pullRequests.detail(identity);
    expect(detail.body).toContain("fixture");
    expect((await manager.pullRequests.diff(identity)).patch).toContain("diff --git");
    await expect(
      manager.pullRequests.comment({ ...identity, body: "Looks good." }),
    ).resolves.toMatchObject({ ok: true });
    expect((await manager.pullRequests.detail(identity)).comments?.at(-1)?.body).toBe(
      "Looks good.",
    );
    await manager.pullRequests.action({ ...identity, action: "close" });
    expect((await manager.pullRequests.detail(identity)).state).toBe("closed");
  });

  it("type-check against the published types", async () => {
    const sourceDir = await skillSourceDir();
    const examples = await readdir(path.join(sourceDir, "examples"));
    const rootNames = [path.join(sourceDir, "types", "globals.d.ts")];
    for (const example of examples) {
      const hooksDir = path.join(sourceDir, "examples", example, "hooks");
      for (const file of await readdir(hooksDir)) {
        if (/\.tsx?$/u.test(file)) rootNames.push(path.join(hooksDir, file));
      }
    }
    const program = ts.createProgram({
      rootNames,
      options: {
        target: ts.ScriptTarget.ES2022,
        // Mods run in a worker with no DOM; the template tsconfig says the same.
        lib: ["lib.es2022.d.ts"],
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        jsx: ts.JsxEmit.React,
        jsxFactory: "h",
        jsxFragmentFactory: "Fragment",
        types: [],
        paths: { synara: [path.join(sourceDir, "types", "synara.d.ts")] },
      },
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  it("load, register their views and commands, and draw", async () => {
    const sourceDir = await skillSourceDir();
    const modsDir = path.join(root, "mods");
    await mkdir(modsDir, { recursive: true });
    const examples = await readdir(path.join(sourceDir, "examples"));
    for (const example of examples) {
      await cp(path.join(sourceDir, "examples", example), path.join(modsDir, example), {
        recursive: true,
      });
    }
    const manager = new ModManager({
      modsDir,
      dataDir: path.join(root, "state"),
      watch: false,
      backend: {
        listThreads: async () => [THREAD],
        listProjects: async () => [PROJECT],
        log: () => undefined,
      },
    });
    managers.push(manager);
    await manager.start();
    for (const example of examples) await manager.setEnabled(example, true);
    await manager.whenIdle();

    const snapshot = manager.snapshot();
    expect(snapshot.mods.map((mod) => [mod.id, mod.status, mod.error])).toEqual(
      examples.toSorted().map((example) => [example, "running", null]),
    );
    const context = { threadId: THREAD.id as never, projectId: PROJECT.id };
    for (const mod of snapshot.mods) {
      for (const view of mod.views) {
        const { tree } = await manager.renderView(mod.id, view.id, context);
        expect(tree, `${mod.id}/${view.id} draws something`).not.toBeNull();
      }
    }
    await expect(manager.runCommand("hello-command", "count-threads", null)).resolves.toEqual({
      text: "1 threads in 1 projects.",
    });
  });
});
