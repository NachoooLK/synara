import type { ModMcpSignIn, ModsSnapshot, ModSummary } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  describeModAdditions,
  describeModViews,
  findNewlyNeededSignIns,
  findStoppedMods,
} from "./modsSnapshot.logic";

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
    pullRequestSources: [],
    mcpServers: [],
    mcpSignIns: [],
    permissions: [],
    tools: [],
    reloadsOnChange: false,
    statusText: null,
    loadedAt: null,
    ...overrides,
  };
}

function snapshot(mods: ModSummary[]): ModsSnapshot {
  return { modsDir: "/mods", mods };
}

function signIn(overrides: Partial<ModMcpSignIn> & Pick<ModMcpSignIn, "state">): ModMcpSignIn {
  return { server: "tracker", host: "mcp.tracker.example", detail: null, ...overrides };
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

describe("findNewlyNeededSignIns", () => {
  it("reports a server that began asking for a sign-in", () => {
    const before = snapshot([mod({ id: "a" }), mod({ id: "b" })]);
    const after = snapshot([
      mod({ id: "a", mcpSignIns: [signIn({ state: "needed" })] }),
      mod({ id: "b" }),
    ]);
    expect(findNewlyNeededSignIns(before, after)).toEqual([
      { modId: "a", signIn: signIn({ state: "needed" }) },
    ]);
  });

  it("reports a sign-in that ended, for that server of the mod only", () => {
    const before = snapshot([
      mod({
        id: "a",
        mcpSignIns: [
          signIn({ state: "signed-in" }),
          signIn({ server: "docs", host: "mcp.docs.example", state: "signed-in" }),
        ],
      }),
    ]);
    const ranOut = signIn({ state: "needed", detail: "The sign-in ran out." });
    const after = snapshot([
      mod({
        id: "a",
        mcpSignIns: [
          ranOut,
          signIn({ server: "docs", host: "mcp.docs.example", state: "signed-in" }),
        ],
      }),
    ]);
    expect(findNewlyNeededSignIns(before, after)).toEqual([{ modId: "a", signIn: ranOut }]);
  });

  it("ignores the first snapshot, a sign-in already asked for, and one that completed", () => {
    const after = snapshot([
      mod({
        id: "a",
        mcpSignIns: [signIn({ state: "needed", detail: "The sign-in was cancelled." })],
      }),
      mod({ id: "b", mcpSignIns: [signIn({ state: "signed-in" })] }),
    ]);
    expect(findNewlyNeededSignIns(null, after)).toEqual([]);
    const before = snapshot([
      mod({ id: "a", mcpSignIns: [signIn({ state: "needed" })] }),
      mod({ id: "b", mcpSignIns: [signIn({ state: "needed" })] }),
    ]);
    expect(findNewlyNeededSignIns(before, after)).toEqual([]);
  });

  it("ignores a sign-out, which the person did themselves", () => {
    const before = snapshot([mod({ id: "a", mcpSignIns: [signIn({ state: "signed-in" })] })]);
    const after = snapshot([mod({ id: "a", mcpSignIns: [signIn({ state: "needed" })] })]);
    expect(findNewlyNeededSignIns(before, after)).toEqual([]);
  });

  it("ignores a mod that is not on", () => {
    const before = snapshot([mod({ id: "changed", mcpSignIns: [signIn({ state: "signed-in" })] })]);
    const after = snapshot([
      mod({
        id: "changed",
        status: "changed",
        mcpSignIns: [signIn({ state: "needed", detail: "The sign-in ran out." })],
      }),
      mod({
        id: "imported",
        enabled: false,
        status: "disabled",
        mcpSignIns: [signIn({ state: "needed" })],
      }),
    ]);
    expect(findNewlyNeededSignIns(before, after)).toEqual([]);
  });

  it("reports a mod that asks while it starts", () => {
    const before = snapshot([mod({ id: "a", enabled: false, status: "disabled" })]);
    const after = snapshot([
      mod({ id: "a", status: "starting", mcpSignIns: [signIn({ state: "needed" })] }),
    ]);
    expect(findNewlyNeededSignIns(before, after).map((entry) => entry.modId)).toEqual(["a"]);
  });
});
