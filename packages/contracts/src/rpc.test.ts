import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { WebSocketRequest } from "./ws";

import {
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsComputerRpcGroup,
  WsProjectAgentRpcGroup,
} from "./rpc";
import { COMPUTER_WS_METHODS } from "./computer";
import { ORCHESTRATION_WS_METHODS } from "./orchestration";

describe("WS RPC contracts", () => {
  it("decodes generic source requests without GitHub identity normalization", () => {
    const identity = {
      modId: "demo",
      sourceId: "reviews",
      repository: "Team/Repo",
      itemId: "review/A-α",
    };
    const requests = [
      {
        _tag: "mods.pullRequestsList",
        modId: "demo",
        sourceId: "reviews",
        state: "open",
        sort: "updated",
      },
      { _tag: "mods.pullRequestsDetail", ...identity },
      { _tag: "mods.pullRequestsDiff", ...identity },
      { _tag: "mods.pullRequestsComment", ...identity, body: "Hello" },
      { _tag: "mods.pullRequestsAction", ...identity, action: "close" },
      { _tag: "mods.pullRequestsSetPinned", ...identity, isPinned: true },
    ];
    for (const body of requests) {
      const decoded = Schema.decodeUnknownSync(WebSocketRequest)({ id: "request-1", body });
      expect(decoded.body._tag).toBe(body._tag);
      if ("itemId" in decoded.body) expect(decoded.body.itemId).toBe("review/A-α");
    }
  });
  it("keeps bootstrap and feature RPCs in separate groups", () => {
    expect(WsBootstrapRpcGroup.requests.has("bootstrap.negotiate")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("bootstrap.negotiate")).toBe(false);
    expect(
      WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers),
    ).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery)).toBe(
      true,
    );
  });

  it("registers every computer method, including setup", () => {
    for (const method of Object.values(COMPUTER_WS_METHODS)) {
      expect(WsComputerRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("exports project-agent RPCs in a satellite group", () => {
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.linkProject")).toBe(true);
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.unlinkProject")).toBe(true);
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.getOverview")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("projectAgent.linkProject")).toBe(false);
    expect(WsFeatureRpcGroup.requests.has("projectAgent.getOverview")).toBe(false);
  });
});
