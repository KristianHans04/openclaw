import { getDatabaseEngineInput } from "../infra/database-engine/context.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";

/** Prepare recovery before readiness without relying on cron registration order. */
export function startGatewaySessionRecoveryPrewarm(params: {
  runtime: Pick<
    GatewayKernelRuntime,
    "minimalTestGateway" | "opts" | "startupSessionDatabases" | "lifecycle"
  >;
  log: Pick<ReturnType<typeof createSubsystemLogger>, "debug">;
  trackStartupWork: (run: (signal: AbortSignal) => Promise<void>) => Promise<void>;
}): void {
  const { runtime, log, trackStartupWork } = params;
  if (
    runtime.minimalTestGateway ||
    runtime.opts.updateCanary ||
    !getDatabaseEngineInput("agent") ||
    runtime.startupSessionDatabases.length === 0
  ) {
    return;
  }
  void trackStartupWork(async (signal) => {
    const [{ prewarmSessionHistoryWorker }, { maintenanceLane }] = await Promise.all([
      import("../config/sessions/session-transcript-worker-runtime.js"),
      import("../config/sessions/session-transcript-worker-resources.js"),
    ]);
    for (const { database, assertCurrent } of runtime.startupSessionDatabases) {
      if (signal.aborted || runtime.lifecycle.closePreludeStarted) {
        return;
      }
      assertCurrent();
      await prewarmSessionHistoryWorker(database, maintenanceLane);
    }
  }).catch((error: unknown) => {
    if (!runtime.lifecycle.closePreludeStarted) {
      log.debug(`Session recovery reader preparation failed: ${String(error)}`);
    }
  });
}
