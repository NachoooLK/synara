import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import * as api from "./modPullRequests";

const entry = {
  repository: "Team/Repo",
  itemId: "review/A-α",
  title: "Review this",
  url: "https://reviews.example.test/items/A",
  state: "open",
};

describe("mod pull request contracts", () => {
  it("accepts opaque item identities", () => {
    expect(Schema.decodeUnknownSync(api.ModPullRequestIdentity)(entry)).toEqual({
      repository: "Team/Repo",
      itemId: "review/A-α",
    });
    expect(() =>
      Schema.decodeUnknownSync(api.ModPullRequestIdentity)({ ...entry, itemId: " " }),
    ).toThrow();
  });

  it("preserves unknown metadata", () => {
    const decoded = Schema.decodeUnknownSync(api.ModPullRequestListEntry)(entry);
    expect(decoded).toMatchObject({
      additions: null,
      deletions: null,
      createdAt: null,
      updatedAt: null,
      isDraft: null,
      commentCount: null,
      viewerInvolvement: null,
      projectIds: [],
    });
    expect(decoded.repository).toBe("Team/Repo");
  });

  it("defaults optional capabilities", () => {
    const decoded = Schema.decodeUnknownSync(api.ModPullRequestSourceDefinition)({
      id: "reviews",
      title: "Reviews",
    });
    expect(decoded.capabilities).toEqual({
      diff: false,
      timeline: false,
      comment: false,
      actions: [],
      mergeMethods: [],
    });
    expect(() =>
      Schema.decodeUnknownSync(api.ModPullRequestSourceDefinition)({
        id: "UPPER",
        title: "Reviews",
      }),
    ).toThrow();
  });

  it("rejects invalid links and excessive pages", () => {
    const decode = Schema.decodeUnknownSync(api.ModPullRequestListResult);
    expect(() => decode({ items: [{ ...entry, url: "javascript:alert(1)" }] })).toThrow();
    expect(() =>
      decode({
        items: [
          { ...entry, author: { login: "a", avatarUrl: "file:///secret", name: null, url: null } },
        ],
      }),
    ).toThrow();
    expect(() => decode({ items: Array.from({ length: 501 }, () => entry) })).toThrow();
    const input = { modId: "demo", sourceId: "reviews", state: "open", sort: "updated" };
    expect(Schema.decodeUnknownSync(api.ModsPullRequestListInput)(input).limit).toBe(100);
    expect(() =>
      Schema.decodeUnknownSync(api.ModsPullRequestListInput)({ ...input, limit: 501 }),
    ).toThrow();
  });
});
