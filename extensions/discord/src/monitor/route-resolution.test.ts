import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { expect, it } from "vitest";
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

it.each([
  ["stale route-shaped", undefined, true],
  ["explicit focus", { boundBy: "user-1", label: "oldagent" }, false],
] as const)(
  "handles %s bindings after the configured agent changes",
  (_name, metadata, ignored) => {
    expect(
      shouldIgnoreStaleDiscordRouteBinding({
        route,
        bindingRecord: { ...bindingRecord, metadata },
      }),
    ).toBe(ignored);
  },
);
