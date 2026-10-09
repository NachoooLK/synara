import type { ModsSnapshot, ModSummary } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { describeModAdditions, describeModViews, findStoppedMods } from "./modsSnapshot.logic";

function mod(overrides: Partial<ModSummary> & Pick<ModSummary, "id">): ModSummary {
  return {
    version: "1.0.0",
    description: null,
    path: `/mods/${overrides.id}`,
    enabled: true,
    status: "running",
    error: null,
    hooks: [],
    commands: [],
    views: [],
    mcpServers: [],
    statusText: null,
    loadedAt: null,
    ...overrides,
  };
}

function snapshot(mods: ModSummary[]): ModsSnapshot {
  return { modsDir: "/mods", mods };
}

const kitchenSink = mod({
  id: "kitchen-sink",
  commands: [
    { name: "a", title: "A", description: null },
    { name: "b", title: "B", description: null },
    { name: "c", title: "C", description: null },
  ],
  views: [
    { id: "sink", site: "sidebar", title: "Kitchen sink", icon: null, refreshOn: [] },
    { id: "all", site: "dock", title: "All elements", icon: "grid", refreshOn: [] },
    { id: "band", site: "band", title: "Status", icon: null, refreshOn: [] },
  ],
});

describe("describeModViews", () => {
  it("names where each view lives", () => {
    expect(describeModViews(kitchenSink)).toBe(
      "Kitchen sink (Sidebar), All elements (Dock), Status (Above the composer)",
    );
    expect(describeModViews(mod({ id: "hooks-only" }))).toBeNull();
  });
});

describe("describeModAdditions", () => {
  it("lists views with their place and counts commands", () => {
    expect(describeModAdditions(kitchenSink)).toBe(
      "Added: Kitchen sink (sidebar), All elements (dock), Status (above the composer), 3 commands",
    );
  });

  it("is null for a mod that only runs hooks", () => {
    expect(describeModAdditions(mod({ id: "hooks-only" }))).toBeNull();
  });
});

describe("findStoppedMods", () => {
  it("reports a mod that went from running to error", () => {
    const before = snapshot([mod({ id: "a" }), mod({ id: "b" })]);
    const after = snapshot([mod({ id: "a", status: "error", error: "boom" }), mod({ id: "b" })]);
    expect(findStoppedMods(before, after).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("ignores the first snapshot, turning a mod off, and mods that never ran", () => {
    const after = snapshot([
      mod({ id: "a", status: "error", error: "boom" }),
      mod({ id: "b", enabled: false, status: "disabled" }),
      mod({ id: "c", status: "error", error: "bad manifest" }),
    ]);
    expect(findStoppedMods(null, after)).toEqual([]);
    const before = snapshot([
      mod({ id: "a", status: "starting" }),
      mod({ id: "b" }),
      mod({ id: "c", status: "error", error: "bad manifest" }),
    ]);
    expect(findStoppedMods(before, after)).toEqual([]);
  });
});
