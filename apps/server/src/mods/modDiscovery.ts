// FILE: modDiscovery.ts
// Purpose: Finds the mods in the mods folder and reads each one's manifest and hooks file.
// Layer: Mods runtime (filesystem reads, no lifecycle)

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  MOD_HOOKS_PATH,
  MOD_MANIFEST_PATH,
  ModHooksFile,
  ModId,
  ModManifest,
} from "@synara/contracts";
import { Schema, SchemaIssue } from "effect";

export interface ModDefinition {
  readonly id: string;
  /** Absolute path of the mod's folder. */
  readonly root: string;
  readonly manifest: ModManifest | null;
  /** Absolute path of the hooks module, when the definition is valid. */
  readonly entry: string | null;
  /** Why the mod cannot load; null when manifest and hooks file are valid. */
  readonly error: string | null;
}

const isModId = Schema.is(ModId);

type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function decodeWith<T>(decode: (value: unknown) => T, value: unknown): Decoded<T> {
  try {
    return { ok: true, value: decode(value) };
  } catch (error) {
    const issue = (error as { readonly issue?: SchemaIssue.Issue }).issue;
    return {
      ok: false,
      error: issue ? SchemaIssue.makeFormatterDefault()(issue) : (error as Error).message,
    };
  }
}

const decodeManifest = Schema.decodeUnknownSync(ModManifest);
const decodeHooksFile = Schema.decodeUnknownSync(ModHooksFile);

async function readJson(
  file: string,
): Promise<{ readonly found: boolean; readonly value?: unknown; readonly error?: string }> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    // A file where a folder should be (a README next to the mods) is not a mod either.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { found: false };
    return { found: true, error: `cannot be read: ${(error as Error).message}` };
  }
  try {
    return { found: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { found: true, error: `is not valid JSON: ${(error as Error).message}` };
  }
}

/** Reads one mod folder. Returns null when the folder holds neither file, so it is not a mod. */
export async function readModDefinition(root: string): Promise<ModDefinition | null> {
  const id = path.basename(root);
  const manifestFile = path.join(root, MOD_MANIFEST_PATH);
  const hooksFile = path.join(root, MOD_HOOKS_PATH);
  const [manifestJson, hooksJson] = await Promise.all([
    readJson(manifestFile),
    readJson(hooksFile),
  ]);
  if (!manifestJson.found && !hooksJson.found) return null;

  const failed = (error: string, manifest: ModManifest | null = null): ModDefinition => ({
    id,
    root,
    manifest,
    entry: null,
    error,
  });

  if (!manifestJson.found) return failed(`${MOD_MANIFEST_PATH} is missing.`);
  if (manifestJson.error) return failed(`${MOD_MANIFEST_PATH} ${manifestJson.error}`);
  const manifestDecoded = decodeWith(decodeManifest, manifestJson.value);
  if (!manifestDecoded.ok) {
    return failed(`${MOD_MANIFEST_PATH} is invalid: ${manifestDecoded.error}`);
  }
  const manifest = manifestDecoded.value;
  if (manifest.name !== id) {
    return failed(
      `${MOD_MANIFEST_PATH} names the mod "${manifest.name}", but its folder is "${id}". They must match.`,
      manifest,
    );
  }

  if (!hooksJson.found) return failed(`${MOD_HOOKS_PATH} is missing.`, manifest);
  if (hooksJson.error) return failed(`${MOD_HOOKS_PATH} ${hooksJson.error}`, manifest);
  const hooksDecoded = decodeWith(decodeHooksFile, hooksJson.value);
  if (!hooksDecoded.ok) {
    return failed(`${MOD_HOOKS_PATH} is invalid: ${hooksDecoded.error}`, manifest);
  }
  const modulePath = hooksDecoded.value.modules[0] ?? "";
  const entry = path.resolve(path.dirname(hooksFile), modulePath);
  const relative = path.relative(root, entry);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return failed(`${MOD_HOOKS_PATH} names a module outside the mod's folder.`, manifest);
  }
  try {
    if (!(await fs.stat(entry)).isFile()) throw new Error("not a file");
  } catch {
    return failed(`${MOD_HOOKS_PATH} names ${modulePath}, which does not exist.`, manifest);
  }
  return { id, root, manifest, entry, error: null };
}

/** Lists the mod folders under `modsDir`, skipping hidden folders and names that are not mod ids. */
export async function listModFolders(modsDir: string): Promise<string[]> {
  let entries: Array<{ readonly name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = await fs.readdir(modsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !isModId(entry.name)) continue;
    const folder = path.join(modsDir, entry.name);
    if (entry.isDirectory()) {
      folders.push(folder);
    } else if (entry.isSymbolicLink()) {
      // A linked folder lets a mod live in its own repository during development.
      const stat = await fs.stat(folder).catch(() => null);
      if (stat?.isDirectory()) folders.push(folder);
    }
  }
  return folders.toSorted();
}
