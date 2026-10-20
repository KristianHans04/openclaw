import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import {
  buildDiscordConversationRouteContext,
  buildDiscordRoutePeer,
  resolveDiscordBoundConversationRoute,
  shouldIgnoreStaleDiscordRouteBinding,
} from "./route-resolution.js";

const cfg: OpenClawConfig = {
  agents: { entries: { worker: {} } },
  bindings: [
    {
      agentId: "worker",
      match: { channel: "discord", accountId: "default", peer: { kind: "direct", id: "user-1" } },
    },
  ],
};

const route: ResolvedAgentRoute = {
  agentId: "newagent",
  channel: "discord",
  accountId: "default",
  sessionKey: "agent:newagent:discord:channel:c1",
  mainSessionKey: "agent:newagent:main",
  lastRoutePolicy: "session",
  matchedBy: "binding.peer",
};
const bindingRecord = {
  bindingId: "binding-1",
  targetSessionKey: "agent:oldagent:discord:channel:c1",
  targetKind: "session" as const,
  conversation: { channel: "discord", accountId: "default", conversationId: "c1" },
  status: "active" as const,
  boundAt: 1,
};

describe("discord route resolution helpers", () => {
  it("keeps a group DM keyed by its conversation instead of one sender", () => {
    expect(
      buildDiscordRoutePeer({
        isDirectMessage: true,
        isGroupDm: true,
        directUserId: "user-1",
        conversationId: "group-dm-1",
      }),
    ).toEqual({ kind: "group", id: "group-dm-1" });
  });

  it("records the direct routing peer separately from the native DM channel", () => {
    expect(
      buildDiscordConversationRouteContext({
        isDirectMessage: true,
        isGroupDm: false,
        directUserId: "user-1",
        conversationId: "dm-1",
        isThread: false,
      }),
    ).toEqual({
      ConversationRouteContextObserved: true,
      ConversationRoutePeerId: "user-1",
      NativeChannelId: "dm-1",
      InboundAccessAuthorized: true,
      MessageThreadId: undefined,
      ThreadParentId: undefined,
    });
  });

  it("composes route building with effective-route overrides", () => {
    expect(
      resolveDiscordBoundConversationRoute({
        cfg,
        accountId: "default",
        isDirectMessage: true,
        isGroupDm: false,
        directUserId: "user-1",
        conversationId: "dm-1",
        boundSessionKey: "agent:worker:discord:direct:user-1",
        matchedBy: "binding.channel",
      }),
    ).toEqual({
      agentId: "worker",
      channel: "discord",
      accountId: "default",
      dmScope: "main",
      groupScope: "per-group",
      sessionKey: "agent:worker:discord:direct:user-1",
      mainSessionKey: "agent:worker:main",
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    });
  });

  it("ignores stale route-shaped bindings after the configured agent changes", () => {
    expect(shouldIgnoreStaleDiscordRouteBinding({ route, bindingRecord })).toBe(true);
  });

  it("keeps explicit focus bindings even when their agent differs from routing", () => {
    expect(
      shouldIgnoreStaleDiscordRouteBinding({
        route,
        bindingRecord: {
          ...bindingRecord,
          bindingId: "focus-binding",
          metadata: { boundBy: "user-1", label: "oldagent" },
        },
      }),
    ).toBe(false);
  });
});
