import { Schema } from "effect";
import { ThreadSidechatContext, ModsPullRequestDetailResult, ThreadId } from "@synara/contracts";
import { expect, it } from "vitest";
import { createModPullRequestContextDraft } from "../components/chat/environment/environmentPullRequest.logic";
import {
  appendPullRequestContextsToPrompt,
  extractTrailingPullRequestContexts,
  normalizePullRequestContext,
  pullRequestContextDedupKey,
} from "./pullRequestContext";
import { normalizeCurrentPersistedComposerDraftStoreState } from "../composerDraftPersistence";
it("round-trips generic agent context without inventing a GitHub number", () => {
  const source = { kind: "mod" as const, modId: "alpha", sourceId: "reviews" };
  const detail = Schema.decodeUnknownSync(ModsPullRequestDetailResult)({
    source,
    revision: "current",
    repository: "Team/Repo",
    itemId: "review/A-α",
    title: "Review",
    url: "https://reviews.example.test/42",
    state: "open",
    projectContexts: [],
    isPinned: false,
  });
  const card = createModPullRequestContextDraft(source, detail);
  expect(normalizePullRequestContext(card)?.prNumber).toBeNull();
  const parsed = extractTrailingPullRequestContexts(
    appendPullRequestContextsToPrompt("Look", [card]),
  ).pullRequestContexts[0]!;
  expect(parsed.source).toEqual(source);
  expect(parsed.itemId).toBe("review/A-α");
  expect(parsed.repository).toBe("Team/Repo");
  expect(pullRequestContextDedupKey(card)).not.toBe(
    pullRequestContextDedupKey({ ...card, source: { ...source, modId: "beta" } }),
  );
  const context = {
    kind: "code-review-item",
    source,
    repository: detail.repository,
    itemId: detail.itemId,
    url: detail.url,
    title: detail.title,
  };
  expect(Schema.decodeUnknownSync(ThreadSidechatContext)(context)).toEqual(context);
  const persisted = normalizeCurrentPersistedComposerDraftStoreState({
    draftsByThreadId: { "draft-fixture": { pullRequestContexts: [card] } },
  });
  expect(
    persisted.draftsByThreadId[ThreadId.makeUnsafe("draft-fixture")]?.pullRequestContexts?.[0],
  ).toMatchObject({
    source,
    itemId: "review/A-α",
    repository: "Team/Repo",
    prNumber: null,
  });
});
