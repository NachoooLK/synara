// FILE: modUiTree.ts
// Purpose: Checks a tree a mod's `ui.render` hook returned and copies it into
//          plain JSON the web app can draw.
// Layer: Mods runtime

import { MOD_UI_TREE_LIMITS, type ModUiTree } from "@synara/contracts";

export class ModUiTreeError extends Error {
  override readonly name = "ModUiTreeError";
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Copies a prop value as JSON, dropping `undefined`; functions were already turned into `{ $handler }`. */
function copyProp(value: unknown, depth: number): Json | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth > MOD_UI_TREE_LIMITS.depth) {
    throw new ModUiTreeError(`A prop nests deeper than ${MOD_UI_TREE_LIMITS.depth} levels.`);
  }
  if (Array.isArray(value)) {
    return value.map((item) => copyProp(item, depth + 1) ?? null);
  }
  if (typeof value === "object") {
    const copy: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const copied = copyProp(item, depth + 1);
      if (copied !== undefined) copy[key] = copied;
    }
    return copy;
  }
  throw new ModUiTreeError(`A prop has a ${typeof value} value; props must be plain data.`);
}

/**
 * Validates a rendered tree: elements are `{ type, props, children }` (what JSX
 * and `h()` build), text is strings or numbers, and empty values are dropped.
 * A top-level list is wrapped in a Fragment. Returns null for "draw nothing".
 */
export function normalizeModUiTree(value: unknown): ModUiTree | null {
  let nodes = 0;
  const visit = (node: unknown, depth: number): Json | null => {
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (typeof node === "string") return node;
    if (typeof node === "number") return Number.isFinite(node) ? String(node) : null;
    if (depth > MOD_UI_TREE_LIMITS.depth) {
      throw new ModUiTreeError(`The tree nests deeper than ${MOD_UI_TREE_LIMITS.depth} levels.`);
    }
    if (Array.isArray(node)) {
      return { type: "Fragment", props: {}, children: visitChildren(node, depth) };
    }
    if (typeof node !== "object") {
      throw new ModUiTreeError(`The tree holds a ${typeof node}; return elements, text or null.`);
    }
    nodes += 1;
    if (nodes > MOD_UI_TREE_LIMITS.nodes) {
      throw new ModUiTreeError(`The tree has more than ${MOD_UI_TREE_LIMITS.nodes} elements.`);
    }
    const element = node as {
      readonly type?: unknown;
      readonly props?: unknown;
      readonly children?: unknown;
    };
    if (typeof element.type !== "string" || element.type.length === 0) {
      throw new ModUiTreeError(
        "An element has no type. Build trees with JSX or h(), using the elements Synara draws.",
      );
    }
    const props =
      element.props !== null && typeof element.props === "object" && !Array.isArray(element.props)
        ? (copyProp(element.props, depth + 1) as { [key: string]: Json })
        : {};
    const children = Array.isArray(element.children) ? visitChildren(element.children, depth) : [];
    return { type: element.type, props, children };
  };
  const visitChildren = (children: ReadonlyArray<unknown>, depth: number): Json[] =>
    children.flatMap((child) => {
      const visited = visit(child, depth + 1);
      return visited === null ? [] : [visited];
    });

  const tree = visit(value, 0);
  if (tree === null) return null;
  if (JSON.stringify(tree).length > MOD_UI_TREE_LIMITS.bytes) {
    throw new ModUiTreeError(`The tree is larger than ${MOD_UI_TREE_LIMITS.bytes / 1000} KB.`);
  }
  return tree;
}
