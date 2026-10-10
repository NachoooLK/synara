import { Schema } from "effect";

/** Shared with ModId without importing the mod snapshot (which contains sources). */
export const ModPullRequestSourceId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
);
export type ModPullRequestSourceId = typeof ModPullRequestSourceId.Type;
const OpaqueId = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4096));
export const ModPullRequestUrl = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }),
);
export const ModPullRequestSourceRef = Schema.Struct({
  kind: Schema.Literal("mod"),
  modId: ModPullRequestSourceId,
  sourceId: ModPullRequestSourceId,
});
export type ModPullRequestSourceRef = typeof ModPullRequestSourceRef.Type;
export const ModPullRequestIdentity = Schema.Struct({ repository: OpaqueId, itemId: OpaqueId });
export type ModPullRequestIdentity = typeof ModPullRequestIdentity.Type;
