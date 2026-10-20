import { expect, it, vi } from "vitest";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../../../state/agent-database-admission.js";
import {
  createRunEntry,
  readLifecycleRun,
  type LifecycleTestDrivers,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { RequesterSettleWakeState } from "./subagent-registry.types.js";

const inspectionError = (reason: string, pending = false) =>
  new AgentDatabaseAdmissionError(
    createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: ["/synthetic/main.sqlite"],
      reason,
      pending,
    }),
  );

export function registerRequesterDatabaseAdmissionTests({
  createLifecycleController,
  waitForLifecycleState,
}: Pick<LifecycleTestDrivers, "createLifecycleController" | "waitForLifecycleState">) {
  function fixture(requesterSettleWake?: RequesterSettleWakeState) {
    const entry = createRunEntry({ endedAt: 4_000, requesterSettleWake });
    const warn = vi.fn();
    const settleWake =
      vi.fn<SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"]>();
    const controller = createLifecycleController({
      entry,
      warn,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });
    const read = () => readLifecycleRun(entry);
    const resume = async () => {
      const join = observeRootWork();
      controller.resumeRequesterSettleWake(entry.runId, read());
      await join();
    };
    return { entry, controller, warn, settleWake, read, resume };
  }

  it.each(["ready", "cancelled"])(
    "retains a wake through pending database inspection until %s",
    async (outcome) => {
      const wake: RequesterSettleWakeState = {
        status: "dispatching",
        attemptCount: 1,
        replayCount: 1,
        batchRunIds: ["run-1"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };
      const { controller, settleWake, read, resume } = fixture(wake);
      const pending = inspectionError("Startup inspection is still running", true);
      let ready = false;
      settleWake.mockImplementation(async (params) => {
        if (!ready) {
          throw pending;
        }
        await params.completeBatch([params.settledEntry], wake.rearmGeneration, {
          delivered: true,
          path: "direct",
        });
        return true;
      });
      await resume();
      expect(read().requesterSettleWake).toEqual(wake);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(settleWake).toHaveBeenCalledOnce();
      if (outcome === "cancelled") {
        await controller.retireSubagentObligations(read(), () => {}, { requesterNotified: true });
      } else {
        ready = true;
      }
      await resume();
      expect(settleWake).toHaveBeenCalledTimes(outcome === "cancelled" ? 1 : 2);
      expect(read().requesterSettleWake).toBeUndefined();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it.each(["ordinary", "inspection-failed"])(
    "settles bookkeeping after a %s wake rejection before attempt admission",
    async (kind) => {
      const { entry, controller, warn, settleWake, read } = fixture();
      settleWake.mockImplementation(async () => {
        throw kind === "inspection-failed"
          ? inspectionError("Integrity check failed")
          : new Error("wake exploded");
      });
      await expect(
        controller.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          cleanup: "keep",
          completedAt: 5_000,
        }),
      ).resolves.toBeUndefined();
      await waitForLifecycleState(() => {
        expect(warn).toHaveBeenCalledWith("requester settle wake failed", expect.anything());
        expect(read().requesterSettleWake).toBeUndefined();
      });
    },
  );
}
