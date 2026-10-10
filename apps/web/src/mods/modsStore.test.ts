import type { ModsSnapshot, ModSummary } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { shareModsSnapshot } from "./modsStore";

function mod(id: string, statusText: string | null = null): ModSummary {
  return {
    id,
    version: "0.1.0",
    description: null,
    path: `/mods/${id}`,
    enabled: true,
    status: "running",
    error: null,
    hooks: [],
    commands: [],
    views: [],
    mcpServers: [],
    mcpSignIns: [],
    permissions: [],
    tools: [],
    reloadsOnChange: false,
    statusText,
    loadedAt: null,
  };
}

describe("shareModsSnapshot", () => {
  it("keeps the previous snapshot when nothing changed", () => {
    const previous: ModsSnapshot = { modsDir: "/mods", mods: [mod("a"), mod("b")] };
    const next: ModsSnapshot = { modsDir: "/mods", mods: [mod("a"), mod("b")] };
    expect(shareModsSnapshot(previous, next)).toBe(previous);
  });

  it("reuses the mods that did not change", () => {
    const previous: ModsSnapshot = { modsDir: "/mods", mods: [mod("a"), mod("b")] };
    const next: ModsSnapshot = { modsDir: "/mods", mods: [mod("a"), mod("b", "busy")] };
    const shared = shareModsSnapshot(previous, next);
    expect(shared).not.toBe(previous);
    expect(shared.mods[0]).toBe(previous.mods[0]);
    expect(shared.mods[1]).toBe(next.mods[1]);
  });
});
