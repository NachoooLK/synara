// FILE: runtimeDependencySmoke.ts
// Purpose: Exercises lazy runtime imports inside the packaged app without starting provider sessions.
// Layer: Release verification entrypoint

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAcpSdk } from "./provider/acp/AcpSdk.ts";
import { loadClaudeAgentSdk } from "./provider/claudeAgentSdk.ts";

// Keep these imports external, just like the server. Running this entrypoint
// from app.asar exposes missing peers that the development install can hide.
await loadAcpSdk();
await loadClaudeAgentSdk();
await import("@earendil-works/pi-coding-agent");
await import("open");
await import("node-pty");
await import("@xterm/headless");

const { parsePatchFiles } = await import("@pierre/diffs");
const patches = parsePatchFiles(
  "diff --git a/smoke.txt b/smoke.txt\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-before\n+after\n",
);
assert.equal(patches[0]?.files[0]?.name, "smoke.txt");

// Mods run in a worker loaded by path next to this bundle, and the worker
// compiles the mod with sucrase. Both have to resolve from inside app.asar.
const { ModWorkerHost, resolveModWorkerUrl } = await import("./mods/modWorkerHost.ts");
const modRoot = await mkdtemp(join(tmpdir(), "synara-mod-smoke-"));
try {
  await mkdir(join(modRoot, "hooks"), { recursive: true });
  await writeFile(
    join(modRoot, "hooks", "register.tsx"),
    `export const register = (on) => {
      on("mod.start", async ($) => {
        await $.pullRequests.registerSource({ id: "reviews", title: "Smoke reviews" });
        return <box />;
      });
      on("pullRequests.list", { sourceId: "reviews" }, () => ({ items: [{
        repository: "Team/Repo", itemId: "review/A", title: "Smoke review",
        url: "https://reviews.example.test/A", state: "open"
      }], nextCursor: null }));
    };`,
  );
  let registeredSource: unknown;
  const host = await ModWorkerHost.start({
    data: {
      modId: "smoke",
      version: "0.0.0",
      root: modRoot,
      entry: join(modRoot, "hooks", "register.tsx"),
      options: {},
      elements: ["Box"],
    },
    workerUrl: await resolveModWorkerUrl(),
    handleApi: async (method, args) => {
      assert.equal(method, "pullRequests.registerSource");
      registeredSource = args[0];
    },
    onUncaught: () => undefined,
    onExit: () => undefined,
  });
  try {
    const startHook = host.hooks.find((hook) => hook.event === "mod.start");
    const listHook = host.hooks.find((hook) => hook.event === "pullRequests.list");
    assert.ok(startHook && listHook);
    const next = async () => {
      throw new Error("The smoke hook must answer directly.");
    };
    assert.equal((await host.invoke(startHook.hookId, {}, next)).kind, "result");
    assert.deepEqual(registeredSource, { id: "reviews", title: "Smoke reviews" });
    const page = await host.invoke(
      listHook.hookId,
      { sourceId: "reviews", state: "open", sort: "updated", cursor: null, limit: 100 },
      next,
    );
    assert.deepEqual(page, {
      kind: "result",
      value: {
        items: [
          {
            repository: "Team/Repo",
            itemId: "review/A",
            title: "Smoke review",
            url: "https://reviews.example.test/A",
            state: "open",
          },
        ],
        nextCursor: null,
      },
    });
  } finally {
    await host.stop();
  }
} finally {
  await rm(modRoot, { recursive: true, force: true });
}
console.log("Packaged runtime dependency smoke passed.");
