import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ModPullRequestPins } from "./modPullRequestPins";

it("keeps pins through reload but removes deleted mod pins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synara-pr-pins-"));
  try {
    const file = path.join(root, "pins.json");
    const a = { kind: "mod" as const, modId: "one", sourceId: "reviews" };
    const b = { ...a, modId: "two" };
    const identity = { repository: "Team/Repo", itemId: "42" };
    const pins = new ModPullRequestPins(file);
    await pins.load();
    await Promise.all([pins.setPinned(a, identity, true), pins.setPinned(b, identity, true)]);
    const reloaded = new ModPullRequestPins(file);
    await reloaded.load();
    expect(reloaded.isPinned(a, identity)).toBe(true);
    expect(reloaded.isPinned(b, identity)).toBe(true);
    expect(reloaded.isPinned(a, { ...identity, repository: "team/repo" })).toBe(false);
    await reloaded.removeMod("one");
    const again = new ModPullRequestPins(file);
    await again.load();
    expect(again.isPinned(a, identity)).toBe(false);
    expect(again.isPinned(b, identity)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
