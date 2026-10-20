import { describe, expect, it } from "vitest";
import {
  getRestartRecoveryTerminalDeliveryEvidence,
  mergeRestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-state.js";
import {
  buildCurrentRunRestartRecoveryClaim as claim,
  buildRestartRecoveryTerminalDeliveryEvidence as capture,
} from "./agent-command-restart-recovery.js";
import { hasMessagingToolDeliveryToSource } from "./subagents/announce/subagent-announce-completion-delivery.js";
import { createDirectAnnounceResponseClassifier } from "./subagents/announce/subagent-announce-direct-response.js";

const session = { sessionId: "session-1", updatedAt: 1 };
const target = { provider: "discord", to: "channel:123" };

describe("buildCurrentRunRestartRecoveryClaim", () => {
  const scopedPolicy = {
    restartRecoveryDisableMessageTool: true,
    restartRecoverySourceIngress: "internal",
    restartRecoverySourceReplyDeliveryMode: "automatic",
    restartRecoveryForceSafeTools: true,
  } as const;

  it("persists a scoped restart-safe policy and clears retired media constraints", () => {
    expect(
      claim({
        disableMessageTool: true,
        entry: {
          ...session,
          restartRecoveryDeliveryMediaUrls: ["/tmp/old.png"],
          restartRecoverySuppressTextDelivery: true,
        },
        forceRestartSafeTools: true,
        runId: "scoped-run",
        sourceIngress: "internal",
        sourceRunId: "scoped-run",
        sourceReplyDeliveryMode: "automatic",
      }),
    ).toStrictEqual(
      expect.objectContaining({
        ...scopedPolicy,
        restartRecoveryDeliveryMediaUrls: undefined,
        restartRecoverySuppressTextDelivery: undefined,
        restartRecoveryDeliveryRunId: "scoped-run",
        restartRecoveryDeliverySourceRunId: "scoped-run",
      }),
    );
  });

  it("preserves the claimed route when delivery preparation resolves an alias", () => {
    expect(
      claim({
        deliveryContext: { channel: "telegram", to: "telegram:-100123:topic:1", threadId: 1 },
        entry: {
          ...scopedPolicy,
          ...session,
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliveryContext: { channel: "telegram", to: "-100123", threadId: 1 },
        },
        runId: "recovery-run",
      }),
    ).toMatchObject({
      ...scopedPolicy,
      restartRecoveryDeliveryContext: { channel: "telegram", to: "-100123", threadId: 1 },
      restartRecoveryDeliveryRunId: "recovery-run",
    });
  });

  it("requires explicit ownership for a new source claim", () => {
    expect(() =>
      claim({
        entry: session,
        runId: "media-run",
        sourceRunId: "media-run",
      }),
    ).toThrow("restart recovery source ownership is required for a new claim");
  });
});

describe("buildRestartRecoveryTerminalDeliveryEvidence", () => {
  type TerminalDeliveryInput = Parameters<typeof capture>[0];
  type PayloadOutcome = NonNullable<
    NonNullable<TerminalDeliveryInput["deliveryStatus"]>["payloadOutcomes"]
  >[number];

  function project(result: TerminalDeliveryInput) {
    const persisted = JSON.stringify([{ runId: "original", ...capture(result) }]);
    return getRestartRecoveryTerminalDeliveryEvidence(
      {
        ...session,
        restartRecoveryTerminalDeliveryEvidence: JSON.parse(persisted),
      },
      "original",
    );
  }

  const classify = createDirectAnnounceResponseClassifier({
    params: {
      sourceTool: "subagent_settle",
      expectsCompletionMessage: false,
      requesterIsSubagent: false,
    },
    parentOnly: false,
    requesterSessionBound: true,
    replyExpectation: "optional",
    deliveryTarget: {},
    shouldDeliverAgentFinal: true,
    requiresMessageToolDelivery: false,
    isSubagentCompletion: false,
    hasSuccessfulTrustedSubagentNoOutputCompletion: false,
    hasRequiredSubagentNoOutputCompletion: false,
    subagentDirectMessageCompletionRequiresMessageTool: false,
    effectiveDirectOrigin: undefined,
    requesterSessionOrigin: undefined,
    textCompletionDirectDeliveryKind: "completed_result",
    tryTextCompletionDirectDelivery: async () => undefined,
  });

  const delivery = (result: TerminalDeliveryInput) => classify({ status: "ok", result });
  const suppressedOutcomes = (reason: string, count = 65): PayloadOutcome[] =>
    Array.from({ length: count }, (_, index) => ({ index, status: "suppressed", reason }));
  const silent = { terminalReply: { disposition: "silent" as const } };

  it.each([
    ["intentional silent final", { meta: silent }, true],
    ["unsettled yielded silence", { meta: { ...silent, yielded: true } }, false],
    ["pending continuation", { meta: { ...silent, continuationPending: true } }, false],
    ["aborted silent run", { meta: { ...silent, aborted: true } }, false],
    [
      "failed silent run",
      { meta: { ...silent, error: new Error("private synthetic failure") } },
      false,
    ],
    [
      "host-settled yielded continuation",
      { meta: { yielded: true }, requesterContinuationSettled: true },
      true,
    ],
    ["legacy empty receipt", { payloads: [] }, false],
  ] satisfies Array<[string, TerminalDeliveryInput, boolean]>)(
    "replays %s without inventing visible delivery",
    async (_name, result, delivered) => {
      const stored = project(result);
      const classified = await delivery(stored);
      expect(classified).toMatchObject({ delivered, path: "direct" });
      expect(JSON.stringify(stored)).not.toContain("private synthetic failure");
      if (!delivered) {
        expect(classified).toMatchObject({ reason: "visible_reply_missing" });
      }
    },
  );

  it.each([
    { reason: "no_visible_payload", expected: { reason: "visible_reply_missing" } },
    { reason: "message_tool_only", expected: { reason: "visible_reply_missing" } },
    { reason: "adapter_returned_no_identity", expected: { disposition: "ambiguous" } },
    {
      reason: "cancelled_by_message_sending_hook",
      expected: { disposition: "intentional_non_delivery", reason: "delivery_suppressed" },
    },
  ] as const)(
    "preserves automatic suppression $reason across receipt replay",
    async ({ reason, expected }) => {
      const stored = project({
        payloads: [],
        meta: { yielded: true },
        deliveryStatus: { status: "suppressed", resultCount: 0, reason },
      });
      expect(await classify({ status: "ok", result: stored })).toMatchObject({
        delivered: false,
        ...expected,
      });
    },
  );

  it.each([
    { status: "suppressed", reason: "adapter_returned_no_identity" },
    { status: "failed", sentBeforeError: true },
    { status: "sent" },
  ] satisfies Array<Omit<PayloadOutcome, "index">>)(
    "retains omitted $status send evidence instead of acknowledging policy suppression",
    async (lastOutcome) => {
      const original = {
        payloads: Array.from({ length: 65 }, () => ({ text: "progress", isCommentary: true })),
        deliveryStatus: {
          status: "suppressed",
          resultCount: 0,
          reason: "cancelled_by_message_sending_hook",
          payloadOutcomes: [
            ...suppressedOutcomes("cancelled_by_message_sending_hook", 64),
            { index: 64, ...lastOutcome },
          ],
        },
      } satisfies TerminalDeliveryInput;
      expect(await delivery(original)).toMatchObject({
        delivered: false,
        disposition: "ambiguous",
      });
      const stored = project(original);
      expect(stored?.deliveryStatus?.payloadOutcomes).toHaveLength(64);
      expect(stored?.deliveryStatus?.payloadOutcomes?.[63]).toEqual({ index: 64, ...lastOutcome });
      expect(await delivery(stored)).toMatchObject({
        delivered: false,
        disposition: "ambiguous",
      });
    },
  );

  it("preserves late policy cancellation beyond the bounded outcome list", async () => {
    const original = {
      deliveryStatus: {
        status: "suppressed",
        resultCount: 0,
        reason: "no_visible_payload",
        payloadOutcomes: [
          ...suppressedOutcomes("no_visible_payload", 64),
          { index: 64, status: "suppressed", reason: "cancelled_by_message_sending_hook" },
        ],
      },
    } satisfies TerminalDeliveryInput;
    const expected = {
      delivered: false,
      disposition: "intentional_non_delivery",
      reason: "delivery_suppressed",
    };
    expect(await delivery(original)).toMatchObject(expected);
    expect(await delivery(project(original))).toMatchObject(expected);
  });

  it("bounds suppression reasons and outcomes without retaining raw terminal objects", () => {
    const evidence = project({
      meta: {
        terminalReply: { disposition: "silent", text: "discarded" },
        error: new Error("discarded"),
      },
      deliveryStatus: {
        status: "suppressed",
        reason: "x".repeat(300),
        payloadOutcomes: suppressedOutcomes("y".repeat(300)),
      },
    });
    expect(evidence?.meta).toEqual({ terminalReply: { disposition: "silent" }, error: true });
    expect(evidence?.deliveryStatus?.reason).toHaveLength(256);
    expect(evidence?.deliveryStatus?.payloadOutcomes).toHaveLength(64);
    expect(evidence?.deliveryStatus?.payloadOutcomes?.[0]?.reason).toHaveLength(256);
    expect(JSON.stringify(evidence)).not.toContain("discarded");
    const receipts = mergeRestartRecoveryTerminalDeliveryEvidence(
      undefined,
      Array.from({ length: 65 }, (_, index) => ({ ...evidence, runId: `run-${index}` })),
    );
    expect(receipts).toHaveLength(64);
    expect(receipts?.[0]?.runId).toBe("run-1");
  });

  it("does not promote malformed persisted completion markers into authority", () => {
    const [receipt] = mergeRestartRecoveryTerminalDeliveryEvidence(undefined, [
      {
        runId: "malformed",
        captured: true,
        meta: {
          terminalReply: { disposition: "visible", text: "unbounded" },
          yielded: "true",
          aborted: 1,
          error: {},
        },
        requesterContinuationSettled: "true",
        deliveryStatus: { status: "suppressed", reason: { message: "invalid" } },
      },
    ])!;
    expect(receipt).toBeDefined();
    expect(receipt?.meta).toBeUndefined();
    expect(receipt?.requesterContinuationSettled).toBeUndefined();
    expect(receipt?.deliveryStatus?.reason).toBeUndefined();
  });

  it.each([false, true])(
    "retains the source final marker %s through durable projection",
    (sourceReplyFinal) => {
      const stored = project({
        messagingToolSentTargets: [{ ...target, text: "reply", sourceReplyFinal }],
      });
      expect(stored?.messagingToolSentTargets?.[0]?.sourceReplyFinal).toBe(sourceReplyFinal);
      expect(
        hasMessagingToolDeliveryToSource(
          stored!,
          { channel: "discord", to: "channel:123" },
          { requireFinalReply: true },
        ),
      ).toBe(sourceReplyFinal);
    },
  );

  it.each([1, undefined])(
    "preserves automatic result count %s without manufacturing a send",
    (resultCount) => {
      const stored = project({ deliveryStatus: { status: "sent", resultCount } });
      expect(stored?.deliveryStatus?.resultCount).toBe(resultCount);
    },
  );

  it("marks bounded messaging-tool target evidence as truncated", () => {
    const evidence = capture({
      messagingToolSentTargets: Array.from({ length: 65 }, (_, index) => ({
        provider: "discord",
        to: `channel:${index}`,
        text: "sent",
      })),
    });

    expect(evidence?.messagingToolSentTargets).toHaveLength(64);
    expect(evidence?.messagingToolSentTargetsTruncated).toBe(true);
  });

  it.each([
    { name: "literal silence token", payload: { text: "NO_REPLY" }, expected: { visible: true } },
    {
      name: "explicitly hidden payload",
      payload: { visible: false, mediaUrls: ["/tmp/private.png"] },
      expected: { mediaUrls: ["/tmp/private.png"], visible: false },
    },
  ])("preserves $name visibility", ({ payload, expected }) => {
    const evidence = capture({ payloads: [payload] });
    expect(evidence.payloads).toEqual([expected]);
    expect(evidence.meta?.terminalReply).toBeUndefined();
  });

  it("retains mixed unaccounted aggregate delivery as ambiguous evidence", () => {
    const evidence = capture({
      didSendViaMessagingTool: true,
      messagingToolSentMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
      messagingToolSentTargets: [{ ...target, mediaUrls: ["/tmp/one.png"] }],
    });

    expect(evidence?.messagingToolAggregateEvidenceUnaccounted).toBe(true);
    expect(evidence?.messagingToolSentTargets).toEqual([
      {
        ...target,
        mediaUrls: ["/tmp/one.png"],
        visible: true,
      },
    ]);
  });

  it("preserves explicit negative messaging-target visibility", () => {
    const evidence = capture({
      messagingToolSentTargets: [{ ...target, text: "" }],
    });

    expect(evidence?.messagingToolSentTargets).toEqual([{ ...target, visible: false }]);
  });
});
