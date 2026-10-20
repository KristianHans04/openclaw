import { describe, expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { resolveDeferredCleanupDecision } from "./subagent-registry-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type EntryOverrides = Omit<Partial<SubagentRunRecord>, "execution"> & { endedAt?: number };
type CleanupInput = Parameters<typeof resolveDeferredCleanupDecision>[0];

function makeEntry(overrides: EntryOverrides = {}): SubagentRunRecord {
  const { endedAt = 1_000, ...recordOverrides } = overrides;
  return createSubagentRunRecord({
    runId: "run-1",
    createdAt: 0,
    execution: { status: "terminal", endedAt },
    ...recordOverrides,
  });
}

describe("resolveDeferredCleanupDecision", () => {
  const now = 2_000;

  function resolveDecision(
    overrides: Pick<CleanupInput, "entry"> & Partial<Pick<CleanupInput, "activeDescendantRuns">>,
  ) {
    return resolveDeferredCleanupDecision({
      now,
      activeDescendantRuns: 0,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: (retryCount) => retryCount * 1_000,
      ...overrides,
    });
  }

  it("defers completion-message cleanup while descendants are still pending", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: true }),
      activeDescendantRuns: 2,
    });

    expect(decision).toEqual({ kind: "defer-descendants", delayMs: 1_000 });
  });

  it("hard-expires completion-message cleanup when descendants never settle", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: true, endedAt: now - 30 * 60_000 }),
      activeDescendantRuns: 1,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry" });
  });

  it("honors a redriven completion at its delivery deadline", () => {
    expect(
      resolveDecision({
        entry: makeEntry({
          expectsCompletionMessage: true,
          endedAt: now - 60 * 60_000,
          delivery: { status: "pending", windowStartedAt: now - 1_000, deadlineAt: now },
        }),
      }).kind,
    ).toBe("give-up");
  });

  it.each([true, false])("backs off settled cleanup (completion required=%s)", (required) => {
    const decision = resolveDecision({
      entry: makeEntry({
        expectsCompletionMessage: required,
        delivery: { status: required ? "pending" : "not_required", attemptCount: 1 },
      }),
    });

    expect(decision).toEqual({ kind: "retry", retryCount: 2, resumeDelayMs: 2_000 });
  });
});
