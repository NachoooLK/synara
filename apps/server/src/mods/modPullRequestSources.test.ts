import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ModsPullRequestListInput } from "@synara/contracts";
import { ModPullRequestSources } from "./modPullRequestSources";
import { ModPullRequestPins } from "./modPullRequestPins";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const item = {
  repository: "Team/Repo",
  itemId: "review/A-α",
  title: "One review",
  url: "https://reviews.example.test/42",
  state: "open",
};
const input = { modId: "one", sourceId: "reviews", ...item };
const listInput = (cursor: string | null = null) =>
  Schema.decodeUnknownSync(ModsPullRequestListInput)({
    modId: "one",
    sourceId: "reviews",
    state: "open",
    sort: "updated",
    cursor,
  });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synara-pr-source-"));
  roots.push(root);
  const pins = new ModPullRequestPins(path.join(root, "pins.json"));
  await pins.load();
  return new ModPullRequestSources({
    pins,
    projects: async () => [],
    onChange: () => {},
    log: () => {},
  });
}
describe("ModPullRequestSources", () => {
  it("dispatches only to the owning mod", async () => {
    const host = await setup();
    host.register("one", 1, { id: "reviews", title: "One" }, async () => ({
      ...item,
      title: "One",
    }));
    host.register("two", 1, { id: "reviews", title: "Two" }, async () => ({
      ...item,
      title: "Two",
    }));
    expect((await host.detail(input)).title).toBe("One");
    expect((await host.detail({ ...input, modId: "two" })).title).toBe("Two");
  });
  it("rejects unsupported operations before dispatch", async () => {
    const host = await setup();
    let calls = 0;
    host.register("one", 1, { id: "reviews", title: "One" }, async () => {
      calls++;
      return { ok: true };
    });
    await expect(host.diff(input)).rejects.toThrow(/unsupported/i);
    await expect(host.comment({ ...input, body: "Hi" })).rejects.toThrow(/unsupported/i);
    await expect(host.action({ ...input, action: "merge", mergeMethod: "merge" })).rejects.toThrow(
      /unsupported/i,
    );
    expect(calls).toBe(0);
  });
  it("limits sources and concurrent reads", async () => {
    const host = await setup();
    let entered = 0;
    const releases: Array<() => void> = [];
    const invoke = async () => {
      entered++;
      await new Promise<void>((resolve) => releases.push(resolve));
      return { items: [item] };
    };
    for (let i = 0; i < 10; i++)
      host.register("one", 1, { id: `source-${i}`, title: "Source" }, invoke);
    expect(() => host.register("one", 1, { id: "eleventh", title: "Source" }, invoke)).toThrow(
      /ten|10/i,
    );
    host.unregister("one", "source-0");
    host.register("one", 1, { id: "reviews", title: "One" }, invoke);
    const reads = Array.from({ length: 5 }, (_, i) => host.list(listInput(String(i))));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(entered).toBe(4);
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(entered).toBe(5);
    releases.forEach((resolve) => resolve());
    await Promise.all(reads);
  });
  it("coalesces identical reads and serializes writes without deduplication", async () => {
    const host = await setup();
    const events: string[] = [];
    let release: () => void = () => {};
    host.register(
      "one",
      1,
      { id: "reviews", title: "One", capabilities: { comment: true } },
      async (event) => {
        events.push(event);
        if (event === "pullRequests.detail") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return item;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true };
      },
    );
    const a = host.detail(input);
    const b = host.detail(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await Promise.all([a, b]);
    expect(events).toEqual(["pullRequests.detail"]);
    await Promise.all([
      host.comment({ ...input, body: "Hello" }),
      host.comment({ ...input, body: "Hello" }),
    ]);
    expect(events).toEqual(["pullRequests.detail", "pullRequests.comment", "pullRequests.comment"]);
  });
  it("rejects invalid results and project associations", async () => {
    const host = await setup();
    host.register("one", 1, { id: "reviews", title: "One" }, async () => ({
      items: [{ ...item, projectIds: ["missing"] }],
    }));
    await expect(host.list(listInput())).rejects.toThrow(/project/i);
    host.register("one", 1, { id: "reviews", title: "One" }, async () => ({
      ...item,
      itemId: "other",
    }));
    await expect(host.detail(input)).rejects.toThrow(/identity/i);
    host.register("one", 1, { id: "reviews", title: "One" }, async () => ({
      items: [{ ...item, state: "closed" }],
    }));
    await expect(host.list(listInput())).rejects.toThrow(/state/i);
  });
  it("discards a slow result after re-registration", async () => {
    const host = await setup();
    let release: () => void = () => {};
    host.register("one", 1, { id: "reviews", title: "Old" }, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return item;
    });
    const oldRevision = host.summaries("one")[0]!.revision;
    const slow = host.detail(input);
    const rejection = expect(slow).rejects.toThrow(/withdrawn|changed/i);
    await new Promise((resolve) => setTimeout(resolve, 5));
    host.register("one", 2, { id: "reviews", title: "New" }, async () => ({
      ...item,
      title: "New",
    }));
    release();
    await rejection;
    expect(host.summaries("one")[0]!.revision).not.toBe(oldRevision);
    expect((await host.detail(input)).title).toBe("New");
    host.withdrawMod("one");
    await expect(host.detail(input)).rejects.toThrow(/unavailable/i);
  });
  it("preserves acknowledgement independently of refresh", async () => {
    const host = await setup();
    let writes = 0;
    host.register(
      "one",
      1,
      { id: "reviews", title: "One", capabilities: { comment: true } },
      async (event) => {
        if (event === "pullRequests.comment") {
          writes++;
          return { ok: true };
        }
        throw new Error("Read unavailable");
      },
    );
    expect(await host.comment({ ...input, body: "Hello" })).toMatchObject({ ok: true });
    await expect(host.detail(input)).rejects.toThrow("Read unavailable");
    expect(writes).toBe(1);
  });
  it("rejects queued reads immediately when a source is withdrawn", async () => {
    const host = await setup();
    const releases: Array<() => void> = [];
    host.register("one", 1, { id: "reviews", title: "One" }, async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { items: [] };
    });
    const active = Array.from({ length: 4 }, (_, i) =>
      host.list(listInput(String(i))).catch(() => null),
    );
    let settled = false;
    const queued = host.list(listInput("queued")).catch(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    host.withdrawMod("one");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const wasRejected = settled;
    releases.forEach((resolve) => resolve());
    await Promise.all([...active, queued]);
    expect(wasRejected).toBe(true);
  });
});
