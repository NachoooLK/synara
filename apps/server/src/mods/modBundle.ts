// FILE: modBundle.ts
// Purpose: Packs a mod's folder into the one-file form it is exported in, and
//          checks and unpacks such a file when a mod is imported.
// Layer: Mods runtime (filesystem reads and writes, no lifecycle)

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  MOD_BUNDLE_FORMAT,
  MOD_BUNDLE_FORMAT_VERSION,
  MOD_BUNDLE_LIMITS,
  ModBundle,
  type ModBundleFile,
} from "@synara/contracts";
import { Schema, SchemaIssue } from "effect";

/** The one hidden folder a mod keeps: its manifest. Every other hidden entry stays behind. */
const MOD_HIDDEN_FOLDER = ".synara-mod";
/** Folders that belong to a mod's tooling, not to the mod. */
const SKIPPED_FOLDERS = new Set(["node_modules"]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
/** Names Windows reserves for devices, with or without an extension. */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu;
// oxlint-disable-next-line no-control-regex -- control characters are what this rejects
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\\:*?"<>|]/u;

export class ModBundleError extends Error {
  override readonly name = "ModBundleError";
}

const decodeBundle = Schema.decodeUnknownSync(ModBundle);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function tooBig(bytes: number): ModBundleError {
  return new ModBundleError(
    `The mod is ${formatMegabytes(bytes)}; an exported mod is limited to ${formatMegabytes(
      MOD_BUNDLE_LIMITS.bytes,
    )}.`,
  );
}

function toBundleFile(relativePath: string, contents: Buffer): ModBundleFile {
  try {
    return { path: relativePath, encoding: "utf8", content: utf8.decode(contents) };
  } catch {
    return { path: relativePath, encoding: "base64", content: contents.toString("base64") };
  }
}

/**
 * Reads every file of a mod's folder into its exported form. Hidden entries
 * other than `.synara-mod` (such as `.env` or `.git`), `node_modules` and links
 * stay behind, so secrets and tooling do not travel with the mod.
 */
export async function packModFolder(
  root: string,
  info: { readonly name: string; readonly version: string },
): Promise<ModBundle> {
  const folder = await fs.realpath(root);
  const files: ModBundleFile[] = [];
  let rawBytes = 0;

  const visit = async (directory: string, segments: ReadonlyArray<string>): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const isManifestFolder = segments.length === 0 && entry.name === MOD_HIDDEN_FOLDER;
      if (entry.name.startsWith(".") && !isManifestFolder) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) await visit(absolute, [...segments, entry.name]);
        continue;
      }
      if (!entry.isFile()) continue;
      // Check the size before reading, so a stray large file is never loaded.
      const { size } = await fs.stat(absolute);
      if (rawBytes + size > MOD_BUNDLE_LIMITS.bytes) throw tooBig(rawBytes + size);
      if (files.length >= MOD_BUNDLE_LIMITS.files) {
        throw new ModBundleError(
          `The mod has more than ${MOD_BUNDLE_LIMITS.files} files, the most an exported mod can hold.`,
        );
      }
      const contents = await fs.readFile(absolute);
      rawBytes += contents.byteLength;
      if (rawBytes > MOD_BUNDLE_LIMITS.bytes) throw tooBig(rawBytes);
      files.push(toBundleFile([...segments, entry.name].join("/"), contents));
    }
  };
  await visit(folder, []);

  const bundle: ModBundle = {
    format: MOD_BUNDLE_FORMAT,
    formatVersion: MOD_BUNDLE_FORMAT_VERSION,
    name: info.name,
    version: info.version,
    exportedAt: new Date().toISOString(),
    files,
  };
  const bytes = Buffer.byteLength(JSON.stringify(bundle));
  if (bytes > MOD_BUNDLE_LIMITS.bytes) throw tooBig(bytes);
  return bundle;
}

function checkBundlePath(filePath: string): void {
  const refuse = (why: string) =>
    new ModBundleError(`The file lists "${filePath}", which ${why}, so it cannot be imported.`);
  if (UNSAFE_PATH_CHARACTERS.test(filePath)) throw refuse("has characters a path cannot use");
  const segments = filePath.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw refuse("is not a plain relative path");
    }
    if (segment.startsWith(".") && !(index === 0 && segment === MOD_HIDDEN_FOLDER)) {
      throw refuse("is a hidden file");
    }
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      throw refuse("ends in a space or a dot");
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) throw refuse("is a name Windows reserves");
  }
}

export interface UnpackedModFile {
  /** Relative to the mod's folder, with `/` between segments. */
  readonly path: string;
  readonly contents: Buffer;
}

/** Checks an imported file and returns the mod it holds. Throws a ModBundleError that says what is wrong. */
export function readModBundle(value: unknown): {
  readonly bundle: ModBundle;
  readonly files: ReadonlyArray<UnpackedModFile>;
} {
  const header =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (header.format !== MOD_BUNDLE_FORMAT) {
    throw new ModBundleError("This file is not an exported Synara mod.");
  }
  if (header.formatVersion !== MOD_BUNDLE_FORMAT_VERSION) {
    throw new ModBundleError(
      "This mod was exported by a newer version of Synara. Update Synara to import it.",
    );
  }
  let bundle: ModBundle;
  try {
    bundle = decodeBundle(value);
  } catch (error) {
    const issue = (error as { readonly issue?: SchemaIssue.Issue }).issue;
    throw new ModBundleError(
      `This exported mod is damaged: ${
        issue ? SchemaIssue.makeFormatterDefault()(issue) : (error as Error).message
      }`,
    );
  }

  const seen = new Set<string>();
  const files: UnpackedModFile[] = [];
  let bytes = 0;
  for (const file of bundle.files) {
    checkBundlePath(file.path);
    // Case-insensitive file systems would write both names to one file.
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      throw new ModBundleError(`The file lists "${file.path}" twice, so it cannot be imported.`);
    }
    seen.add(key);
    if (file.encoding === "base64" && !BASE64_PATTERN.test(file.content)) {
      throw new ModBundleError(`This exported mod is damaged: "${file.path}" is not valid base64.`);
    }
    const contents = Buffer.from(file.content, file.encoding);
    bytes += contents.byteLength;
    if (bytes > MOD_BUNDLE_LIMITS.bytes) throw tooBig(bytes);
    files.push({ path: file.path, contents });
  }
  return { bundle, files };
}

/** Writes an imported mod's files into `root`, which must not exist yet. */
export async function writeModFiles(
  root: string,
  files: ReadonlyArray<UnpackedModFile>,
): Promise<void> {
  await fs.mkdir(root);
  for (const file of files) {
    const target = path.join(root, ...file.path.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.contents, { flag: "wx" });
  }
}
