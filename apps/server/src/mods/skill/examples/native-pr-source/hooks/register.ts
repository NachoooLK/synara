import type { Register } from "synara";

import { FIXTURES, PATCH, SOURCE_ID, readDetail, stateKey } from "./data";

export const register: Register = (on) => {
  on("mod.start", async ($) => {
    // Registration publishes metadata only. Do not fetch PRs here.
    await $.pullRequests.registerSource({
      id: SOURCE_ID,
      title: "Team reviews",
      capabilities: { diff: true, timeline: true, comment: true, actions: ["close", "reopen"] },
    });
  });

  on("pullRequests.list", { sourceId: SOURCE_ID }, async ($, e) => {
    const all = await Promise.all(FIXTURES.map((item) => readDetail($, item)));
    const matching = all.filter((item) =>
      e.state === "open" ? item.state === "open" : item.state !== "open",
    );
    const field = e.sort === "created" ? "createdAt" : "updatedAt";
    matching.sort((a, b) => (b[field] ?? "").localeCompare(a[field] ?? ""));
    // This example owns this cursor format; an MCP adapter forwards its server's
    // cursor unchanged instead of converting it to a GitHub page number.
    const offset = e.cursor === null ? 0 : Number(e.cursor.replace(/^next:/u, ""));
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      (e.cursor !== null && e.cursor !== `next:${offset}`)
    )
      throw new Error("Invalid fixture cursor.");
    const end = offset + e.limit;
    return {
      items: matching.slice(offset, end),
      totalCount: matching.length,
      nextCursor: end < matching.length ? `next:${end}` : null,
      viewer: "demo",
    };
  });

  on("pullRequests.detail", { sourceId: SOURCE_ID }, ($, e) => readDetail($, e));

  on("pullRequests.diff", { sourceId: SOURCE_ID }, async ($, e) => {
    await readDetail($, e);
    return { patch: PATCH, truncated: false };
  });

  on("pullRequests.comment", { sourceId: SOURCE_ID }, async ($, e) => {
    const item = await readDetail($, e);
    const now = new Date().toISOString();
    const comments = [
      ...(item.comments ?? []),
      {
        id: `fixture-${(item.comments?.length ?? 0) + 1}`,
        kind: "issue-comment" as const,
        author: { login: "demo", name: "Demo" },
        body: e.body,
        createdAt: now,
        updatedAt: null,
        path: null,
        reviewState: null,
      },
    ];
    await $.state.set(stateKey(e), {
      ...item,
      comments,
      commentCount: comments.length,
      updatedAt: now,
    });
    await $.pullRequests.invalidate(SOURCE_ID);
    return { ok: true as const };
  });

  on("pullRequests.action", { sourceId: SOURCE_ID }, async ($, e) => {
    const item = await readDetail($, e);
    if (
      (e.action === "close" && item.state !== "open") ||
      (e.action === "reopen" && item.state !== "closed")
    )
      throw new Error("That action is unavailable in this state.");
    if (e.action !== "close" && e.action !== "reopen")
      throw new Error("This fixture supports only close and reopen.");
    const now = new Date().toISOString();
    await $.state.set(stateKey(e), {
      ...item,
      state: e.action === "close" ? "closed" : "open",
      closedAt: e.action === "close" ? now : null,
      updatedAt: now,
    });
    await $.pullRequests.invalidate(SOURCE_ID);
    return { ok: true as const };
  });
};
