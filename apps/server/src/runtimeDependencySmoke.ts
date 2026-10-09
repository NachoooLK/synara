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
    'export const register = (on: (event: string, hook: () => unknown) => void) => { on("mod.start", () => <box />); };',
  );
  const host = await ModWorkerHost.start({
    data: {
      modId: "smoke",
      version: "0.0.0",
      root: modRoot,
      entry: join(modRoot, "hooks", "register.tsx"),
      options: {},
    },
    workerUrl: await resolveModWorkerUrl(),
    handleApi: async () => undefined,
    onUncaught: () => undefined,
    onExit: () => undefined,
  });
  assert.equal(host.hooks[0]?.event, "mod.start");
  await host.stop();
} finally {
  await rm(modRoot, { recursive: true, force: true });
}
console.log("Packaged runtime dependency smoke passed.");
