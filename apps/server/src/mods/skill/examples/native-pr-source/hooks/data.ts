import type { ModApi, ModPullRequestDetail, ModPullRequestIdentity } from "synara";

export const SOURCE_ID = "team-reviews";

// Static demonstration data. Mutable data belongs in $.state (or $.store),
// so a module reload does not silently discard an acknowledged action.
export const FIXTURES: ReadonlyArray<ModPullRequestDetail> = [
  {
    repository: "Team/Payments",
    itemId: "review/A-α",
    title: "Keep payment retries idempotent",
    url: "https://reviews.example.test/payments/A",
    state: "open",
    body: "This fixture demonstrates native Code review without a company account.",
    isDraft: false,
    author: { login: "alex", name: "Alex" },
    headBranch: "fix/retries",
    baseBranch: "main",
    createdAt: "2026-10-09T10:00:00.000Z",
    updatedAt: "2026-10-09T12:00:00.000Z",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commentCount: 0,
    comments: [],
    commits: [],
    checks: [],
    reviewers: [],
  },
  {
    repository: "Team/Bookings",
    itemId: "review/B",
    title: "Show the booking reference",
    url: "https://reviews.example.test/bookings/B",
    state: "open",
    body: "Another fixture. Unknown dates and counts are omitted, not invented.",
  },
];

export const PATCH =
  "diff --git a/retries.txt b/retries.txt\n--- a/retries.txt\n+++ b/retries.txt\n@@ -1 +1 @@\n-retry every request\n+retry only idempotent requests\n";

export function stateKey(identity: ModPullRequestIdentity): string {
  return JSON.stringify([identity.repository, identity.itemId]);
}

export async function readDetail(
  $: ModApi,
  identity: ModPullRequestIdentity,
): Promise<ModPullRequestDetail> {
  const fixture = FIXTURES.find(
    (item) => item.repository === identity.repository && item.itemId === identity.itemId,
  );
  if (!fixture) throw new Error("This fixture source does not contain that PR.");
  return (await $.state.get<ModPullRequestDetail>(stateKey(identity))) ?? fixture;
}
