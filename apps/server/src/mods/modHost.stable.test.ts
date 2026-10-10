import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { ServerConfig } from "../config";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ModHost } from "./Services/ModHost";
import { ModHostLive } from "./Layers/ModHost";
import type { ModHostError } from "./Errors";

vi.mock("../betaFeatureGate", () => ({ isServerBetaFeatureEnabled: () => false }));

it("refuses all native source calls on Stable without reading or creating mod state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synara-stable-mods-"));
  try {
    const baseDir = path.join(root, "home");
    const services = Layer.mergeAll(
      Layer.succeed(ServerConfig, { baseDir, stateDir: path.join(baseDir, "state") } as never),
      Layer.succeed(ProjectionSnapshotQuery, {} as never),
      Layer.succeed(OrchestrationEngineService, {} as never),
      Layer.succeed(ServerSecretStore, {} as never),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* ModHost;
        expect(host.available).toBe(false);
        const item = { modId: "demo", sourceId: "reviews", repository: "Repo", itemId: "42" };
        const calls: Array<Effect.Effect<unknown, ModHostError>> = [
          host.pullRequests.list({
            ...item,
            state: "open",
            sort: "updated",
            cursor: null,
            limit: 100,
          }),
          host.pullRequests.detail(item),
          host.pullRequests.diff(item),
          host.pullRequests.comment({ ...item, body: "Hi" }),
          host.pullRequests.action({ ...item, action: "close" }),
          host.pullRequests.setPinned({ ...item, isPinned: true }),
        ];
        for (const call of calls)
          expect((yield* Effect.flip(call)).message).toContain("not available");
      }).pipe(Effect.provide(ModHostLive.pipe(Layer.provide(services))), Effect.scoped),
    );
    await expect(access(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
