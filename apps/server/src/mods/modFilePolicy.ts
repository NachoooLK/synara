// The files exported and fingerprinted are the only files a mod may load.
import { promises as fs } from "node:fs";
import * as path from "node:path";

export function isTrustedModSegments(segments: ReadonlyArray<string>): boolean {
  return (
    segments.length > 0 &&
    segments.every(
      (segment, index) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        segment !== "node_modules" &&
        (!segment.startsWith(".") || (index === 0 && segment === ".synara-mod")),
    )
  );
}
export function trustedModSegments(root: string, file: string): string[] {
  const relative = path.relative(root, file);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("The file resolves outside the mod's folder.");
  const segments = relative.split(path.sep);
  if (!isTrustedModSegments(segments))
    throw new Error(
      "The file is not part of the mod's trusted files (hidden files and node_modules are excluded).",
    );
  return segments;
}
export async function assertTrustedModFile(root: string, file: string): Promise<void> {
  let current = root;
  for (const segment of trustedModSegments(root, file)) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw new Error("Links are not part of the mod's trusted files.");
  }
  trustedModSegments(await fs.realpath(root), await fs.realpath(file));
}
