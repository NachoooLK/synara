// FILE: modUiTree.test.ts
// Purpose: Covers the shape and size checks on trees mods return from `ui.render`.
// Layer: Mods runtime tests

import { MOD_UI_TREE_LIMITS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { normalizeModUiTree } from "./modUiTree.ts";

const el = (type: string, props: Record<string, unknown> = {}, ...children: unknown[]) => ({
  type,
  props,
  children,
});

describe("normalizeModUiTree", () => {
  it("keeps elements, turns numbers into text and drops empty values", () => {
    expect(
      normalizeModUiTree(
        el(
          "Box",
          { gap: 2, hidden: undefined, onPress: { $handler: "1.0" } },
          "a",
          3,
          null,
          false,
          el("Text"),
        ),
      ),
    ).toEqual({
      type: "Box",
      props: { gap: 2, onPress: { $handler: "1.0" } },
      children: ["a", "3", { type: "Text", props: {}, children: [] }],
    });
  });

  it("wraps a top-level list and maps nothing to null", () => {
    expect(normalizeModUiTree(["x", el("Text")])).toEqual({
      type: "Fragment",
      props: {},
      children: ["x", { type: "Text", props: {}, children: [] }],
    });
    expect(normalizeModUiTree(null)).toBeNull();
    expect(normalizeModUiTree(undefined)).toBeNull();
  });

  it("rejects elements without a type and trees past the limits", () => {
    expect(() => normalizeModUiTree({ props: {} })).toThrow(/no type/u);
    let deep: unknown = "leaf";
    for (let depth = 0; depth <= MOD_UI_TREE_LIMITS.depth + 1; depth += 1)
      deep = el("Box", {}, deep);
    expect(() => normalizeModUiTree(deep)).toThrow(/deeper/u);
    const wide = el(
      "Box",
      {},
      ...Array.from({ length: MOD_UI_TREE_LIMITS.nodes + 1 }, () => el("Text")),
    );
    expect(() => normalizeModUiTree(wide)).toThrow(/more than/u);
  });
});
