import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ModsPullRequestListResult } from "@synara/contracts";
import {
  codeReviewItemKey,
  codeReviewSourceKey,
  parseCodeReviewSourceKey,
  sortCodeReviewRows,
  toCodeReviewRows,
  visibleModCodeReviewRows,
} from "./codeReview.logic";
const source = { kind: "mod" as const, modId: "demo", sourceId: "reviews" };
function page(modId: string, updatedAt: string | null = null) {
  return Schema.decodeUnknownSync(ModsPullRequestListResult)({
    source: { ...source, modId },
    revision: "generation-1",
    items: [
      {
        repository: "Team/Repo",
        itemId: "42",
        title: modId,
        url: "https://reviews.example.test/42",
        state: "open",
        author: { login: "same-login", name: null },
        projectContexts: [],
        isPinned: false,
        updatedAt,
      },
    ],
  });
}
describe("code review identity", () => {
  it("finds mod PRs by their creator's display name as well as login", () => {
    const result = page("demo");
    const rows = toCodeReviewRows(undefined, [
      {
        ...result,
        items: [
          {
            ...result.items[0]!,
            author: { login: "account-27", name: "Ada Lovelace", avatarUrl: null, url: null },
          },
        ],
      },
    ]);
    const filters = {
      kind: "all" as const,
      state: "open" as const,
      involvement: "everything" as const,
      projectIds: [],
      labels: [],
    };
    for (const query of ["ada", "lovelace", "ada lovelace", "account-27"])
      expect(
        visibleModCodeReviewRows(rows, filters, query, "updated").map((row) => row.identity.itemId),
      ).toEqual(["42"]);
    expect(visibleModCodeReviewRows(rows, filters, "grace hopper", "updated")).toEqual([]);
  });
  it("separates source identities and viewers", () => {
    const rows = toCodeReviewRows(undefined, [page("demo"), page("other")]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.involvement.authored).toBe(false);
    expect(codeReviewItemKey(rows[0]!.source, rows[0]!.identity)).not.toBe(
      codeReviewItemKey(rows[1]!.source, rows[1]!.identity),
    );
    expect(codeReviewItemKey(source, { repository: "Team/Repo", itemId: "42" })).not.toBe(
      codeReviewItemKey(source, { repository: "team/repo", itemId: "42" }),
    );
    expect(parseCodeReviewSourceKey(codeReviewSourceKey(source))).toEqual(source);
    expect(parseCodeReviewSourceKey("mod:UPPER:reviews")).toBeNull();
  });
  it("sorts unknown dates without fabricating values", () => {
    const rows = sortCodeReviewRows(
      toCodeReviewRows(undefined, [page("demo"), page("other", "2026-10-10T00:00:00Z")]),
      "updated",
    );
    expect(rows.map((row) => row.item.title)).toEqual(["other", "demo"]);
    expect(rows[1]!.item.updatedAt).toBeNull();
  });
});
