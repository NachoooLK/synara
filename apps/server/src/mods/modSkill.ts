// FILE: modSkill.ts
// Purpose: Installs the mod authoring skill (SKILL.md, the "synara" types,
//          examples and reference files) where every provider's skill catalog
//          finds it, with this machine's paths filled in.
// Layer: Mods runtime (runs once at server start, Beta-only)

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const MOD_SKILL_NAME = "synara-mods";
const VERSION_MARKER = ".synara-skill-version";
/** Files whose `{{…}}` placeholders take this machine's paths. */
const TEMPLATED_FILES = new Set(["SKILL.md", "reference/tsconfig.json"]);

/**
 * The skill's source folder: `skill/` next to this module, which is
 * `src/mods/skill` from source and `dist/skill` in the bundled server.
 */
export async function resolveModSkillSourceDir(): Promise<string | null> {
  for (const relative of ["./skill/"]) {
    const dir = fileURLToPath(new URL(relative, import.meta.url));
    const found = await fs.stat(path.join(dir, "SKILL.md")).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (found) return dir;
  }
  return null;
}

/** The icon names a mod may use, one per line in the skill's `reference/icons.txt`. */
export async function readModIconNames(sourceDir: string): Promise<ReadonlySet<string>> {
  const text = await fs.readFile(path.join(sourceDir, "reference", "icons.txt"), "utf8");
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.toSorted();
}

/**
 * Copies the skill into `<targetRoot>/synara-mods/`. Skips the copy when the
 * installed version already matches, and replaces the folder otherwise, so a
 * skill file removed from Synara disappears too.
 */
export async function installModSkill(input: {
  readonly sourceDir: string;
  readonly targetRoot: string;
  readonly modsDir: string;
}): Promise<{ readonly installed: boolean; readonly skillDir: string }> {
  const skillDir = path.join(input.targetRoot, MOD_SKILL_NAME);
  const files = await listFiles(input.sourceDir);
  const placeholders: Record<string, string> = {
    "{{MODS_DIR}}": input.modsDir,
    "{{SKILL_DIR}}": skillDir,
    "{{TYPES_DIR}}": path.join(skillDir, "types"),
  };
  const contents = new Map<string, string>();
  const hash = createHash("sha256");
  for (const file of files) {
    let text = await fs.readFile(path.join(input.sourceDir, file), "utf8");
    if (TEMPLATED_FILES.has(file)) {
      for (const [placeholder, value] of Object.entries(placeholders)) {
        text = text.replaceAll(placeholder, value.replaceAll("\\", "/"));
      }
    }
    contents.set(file, text);
    hash.update(file).update("\0").update(text).update("\0");
  }
  const version = hash.digest("hex");
  const installedVersion = await fs
    .readFile(path.join(skillDir, VERSION_MARKER), "utf8")
    .catch(() => null);
  if (installedVersion === version) return { installed: false, skillDir };

  // Build next to the target and swap it in, so a crash never leaves half a skill.
  const staging = `${skillDir}.${process.pid}.staging`;
  await fs.rm(staging, { recursive: true, force: true });
  for (const [file, text] of contents) {
    const target = path.join(staging, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, "utf8");
  }
  await fs.writeFile(path.join(staging, VERSION_MARKER), version, "utf8");
  await fs.rm(skillDir, { recursive: true, force: true });
  await fs.rename(staging, skillDir);
  return { installed: true, skillDir };
}
