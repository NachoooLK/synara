// FILE: settingsSearchIndex.test.ts
// Purpose: Guards that the Beta-only Mods section can be found from settings search.
// Layer: Route/UI support tests

import { describe, expect, it } from "vitest";

import { rankSettingsSearchEntries } from "./settingsSearchIndex";

describe("rankSettingsSearchEntries for Mods", () => {
  it.each(["mods", "plugins", "extensions", "import mod", "export mod", "mods folder"])(
    "finds the Mods section for %j",
    (query) => {
      const results = rankSettingsSearchEntries(query, 12);
      expect(results.some((entry) => entry.section === "mods")).toBe(true);
    },
  );
});
