import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { resolveSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import { prepareFreshSharedAuthStoreWriteAsync } from "../../agents/auth-profiles/shared-store-bootstrap-async.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { retireSqliteDatabaseAdmissionForPath } from "../sqlite-database-admission.js";
import * as receipts from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s receipt lifecycle",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("bootstraps empty shared auth after reopening an unsealed legacy source", async () => {
      const source = admit(() => openOpenClawAgentDatabase({ agentId: "main" }));
      if (engine === "postgres") {
        // An older server seal requires real schema verification on the next native open.
        admit(() =>
          source.db.exec("UPDATE openclaw_schema_meta SET server_major = 0 WHERE store = 'agent'"),
        );
      }
      admit(() => closeOpenClawAgentDatabaseByPath(source.path));
      await closeOpenClawAgentDatabaseByPathAsync(source.path);
      retireSqliteDatabaseAdmissionForPath(source.path);
      const committed: unknown[] = [];
      const observe = receipts.observeSqliteWorkerCommittedFacts;
      const observed = vi
        .spyOn(receipts, "observeSqliteWorkerCommittedFacts")
        .mockImplementation((admission, callback) =>
          observe(admission, (receipt) => {
            committed.push(receipt.facts);
            callback(receipt);
          }),
        );
      try {
        await expect(
          prepareFreshSharedAuthStoreWriteAsync({
            agentDir: undefined,
            allowExplicitMain: false,
            env: process.env,
          }),
        ).resolves.toBe(true);
        expect(resolveSharedAuthStoreOwnership(process.env)).toEqual({ location: "state-db" });
        expect(committed).toEqual([{ ownership: { location: "state-db" }, relocated: true }]);
      } finally {
        observed.mockRestore();
      }
    });

    it("keeps a peer borrower after caller refusal follows a committed opening lease", async () => {
      const options = { agentId: "receipt-refusal", env: process.env };
      const state = admit(() => openOpenClawStateDatabase());
      const source = admit(() => openOpenClawAgentDatabase(options));
      admit(() => closeOpenClawAgentDatabaseByPath(source.path));
      await closeOpenClawAgentDatabaseByPathAsync(source.path);
      const initiator = captureOpenClawAgentDatabaseExecution(options);
      const retained = captureOpenClawAgentDatabaseExecution(options);
      const refusal = new Error("Opening caller refused validation after its lease committed");
      let refused = false;
      let committedLeaseCount = 0;
      const createAdmission = receipts.createSqliteWorkerOperationAdmission;
      const refuseValidation = vi
        .spyOn(receipts, "createSqliteWorkerOperationAdmission")
        .mockImplementation((authorize, attachment) =>
          createAdmission((request, grant) => {
            if (
              !refused &&
              isRecord(attachment) &&
              attachment.kind === "agent-execution" &&
              request.stage === "prepare" &&
              isRecord(request.facts) &&
              request.facts.kind === "agent-validation-start"
            ) {
              committedLeaseCount = admit(() =>
                Number(
                  state.db
                    .prepare(
                      "SELECT COUNT(*) AS count FROM agent_database_leases WHERE agent_id = ?",
                    )
                    .get(options.agentId)?.count,
                ),
              );
              refused = true;
              throw refusal;
            }
            authorize(request, grant);
          }, attachment),
        );
      const owner: AgentDatabaseRequestExecutionSource = {
        assertCurrent() {},
        createAdmission: (binding) => () => ({
          nativeLocations: binding.nativeLocations,
          admission: receipts.createSqliteWorkerOperationAdmission((request, grant) => {
            binding.authorize(request);
            if (!grant()) {
              throw new Error("Receipt lifecycle caller admission expired");
            }
          }, binding.attachment),
        }),
      };
      const operation = vi.fn(async () => "not admitted");
      try {
        await expect(initiator.runExisting(owner, operation)).rejects.toBe(refusal);
        expect(refused).toBe(true);
        expect(committedLeaseCount).toBe(1);
        expect(operation).not.toHaveBeenCalled();
        expect(() => retained.assertCurrent()).not.toThrow();
        await expect(
          retained.runExisting(owner, (scope) =>
            scope.execute({
              type: "session.transcript.initialize",
              input: {
                sessionKey: "agent:receipt-refusal:retained",
                sessionId: "retained-after-refusal",
              },
            }),
          ),
        ).resolves.toMatchObject({
          kind: "session-transcript-initialized",
          sessionKey: "agent:receipt-refusal:retained",
        });
      } finally {
        refuseValidation.mockRestore();
        await Promise.all([initiator.release(), retained.release()]);
      }
    });
  },
);
