import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requestClientCredentialsFromApp } from "../infra/client-credential-ipc.js";
import {
  ClientCredentialMigrationRequiredError,
  readClientCredentialReceipt,
} from "../infra/client-credential-readiness.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import {
  assertNoPendingLegacyExecApprovals,
  ExecApprovalsMigrationRequiredError,
} from "../infra/exec-approvals-migration-gate.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

async function readCredentialPreparationState(
  env: NodeJS.ProcessEnv,
): Promise<"ready" | "upgrade" | "required"> {
  try {
    assertNoPendingLegacyExecApprovals({ env });
    // A running Mac app retains custody; its admitted operation is authoritative.
    if (
      await requestClientCredentialsFromApp(env, { kind: "identity.read", identity_key: "primary" })
    ) {
      return "ready";
    }
    // Existing independent native sources refresh through this same noncreating owner.
    using owner = openClientCredentialCustody(env);
    const receipt = owner && readClientCredentialReceipt(owner.database)?.receipt;
    // Older healthy bootstraps need durable provenance before a future filesystem remount.
    return receipt?.sharedFile && receipt.source === null ? "upgrade" : "ready";
  } catch (error) {
    if (
      error instanceof ClientCredentialMigrationRequiredError ||
      error instanceof ExecApprovalsMigrationRequiredError
    ) {
      return "required";
    }
    throw error;
  }
}

/** Complete the selected root's cutover before any client acquires credentials. */
export async function prepareStartupClientCredentials(
  params: { env?: NodeJS.ProcessEnv; runtime?: RuntimeEnv; config?: OpenClawConfig } = {},
): Promise<void> {
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  const preparation = await readCredentialPreparationState(env);
  if (preparation === "ready") {
    return;
  }
  const runtime = params.runtime ?? defaultRuntime;
  const [{ createConfigIO }, { resolveDatabaseEngineSelection }, { withDatabaseEngineSelection }] =
    await Promise.all([
      import("../config/io.js"),
      import("../infra/database-engine/config.js"),
      import("../infra/database-engine/context.js"),
    ]);
  // Config supplies the engine, not a different migration target or process-wide environment.
  const engineEnv = cloneEnvWithPlatformSemantics(env);
  let config = params.config;
  if (!config) {
    const snapshot = await createConfigIO({
      env: engineEnv,
      configPath: resolveConfigPath(env),
      observe: false,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot();
    if (!snapshot.valid) {
      throw new Error(`Cannot prepare client credentials with invalid config at ${snapshot.path}.`);
    }
    config = snapshot.config;
  }
  // Gateway recovery may have validated a backup before its lease-owned application.
  const selection = await resolveDatabaseEngineSelection(config, engineEnv);
  await withDatabaseEngineSelection(selection, async () => {
    const { beginDoctorMaintenance } = await import("./doctor-maintenance.js");
    let maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
    try {
      maintenance = await beginDoctorMaintenance({
        env,
        root: null,
        options: { repair: true, nonInteractive: true },
        waitForMaintenance: preparation === "required",
        // JSONL node workers reserve stdout for their protocol.
        runtime: { ...runtime, log: runtime.error },
      });
    } catch (error) {
      const [
        { collectNestedErrorCandidates },
        { GatewayStateOwnerContentionError },
        { DoctorMaintenanceRefusalError },
        { hasCommandProcessCleanupError },
        { resolveCommandProcessSignal },
      ] = await Promise.all([
        import("../infra/error-graph-internal.js"),
        import("../infra/gateway-state-owner.js"),
        import("../infra/update-doctor-result.js"),
        import("../process/exec-result.js"),
        import("../process/exec-spawn.js"),
      ]);
      const causes = collectNestedErrorCandidates(error);
      const optionalUpgrade =
        preparation === "upgrade" && error instanceof DoctorMaintenanceRefusalError;
      if (
        !causes.some((cause) => cause instanceof AggregateError) &&
        !hasCommandProcessCleanupError(error) &&
        (optionalUpgrade ||
          causes.some((cause) => cause instanceof GatewayStateOwnerContentionError)) &&
        (await readCredentialPreparationState(env)) !== "required"
      ) {
        resolveCommandProcessSignal()?.throwIfAborted();
        if (optionalUpgrade) {
          runtime.error(
            "Client credential metadata upgrade deferred; existing credentials remain available. Startup will retry automatically.",
          );
        }
        // Admission has settled. A peer may have completed required recovery meanwhile.
        return;
      }
      throw error;
    }
    if (!maintenance) {
      throw new Error("Client credential preparation requires maintenance ownership.");
    }
    try {
      await maintenance.run(async () => {
        if ((await readCredentialPreparationState(env)) === "ready") {
          return;
        }
        const { prepareOpenClawStateDatabaseSchema } =
          await import("../state/openclaw-state-db.js");
        const { isStatePostgres } = await import("../state/openclaw-state-db-engine.js");
        if (isStatePostgres()) {
          await preparePostgresClientCredentials(env, runtime);
        } else {
          const result = await prepareOpenClawStateDatabaseSchema({ env }, "doctor");
          for (const warning of result.warnings) {
            runtime.error(warning);
          }
        }
        const [identity, auth, approvals] = await Promise.all([
          import("../infra/state-migrations.device-identity.js"),
          import("../infra/state-migrations.device-auth.js"),
          import("../infra/state-migrations.exec-approvals.js"),
        ]);
        const context = { env, stateDir: resolveStateDir(env), doctorOnlyStateMigrations: true };
        const detectedIdentity = identity.detectLegacyDeviceIdentity(context);
        if (detectedIdentity.hasInvalidCanonical) {
          throw new Error(
            "Invalid client identity requires explicit repair; startup preserved it.",
          );
        }
        for (const migrate of [
          () => identity.migrateLegacyDeviceIdentity({ ...context, detected: detectedIdentity }),
          () =>
            auth.migrateLegacyDeviceAuth({
              ...context,
              detected: auth.detectLegacyDeviceAuth(context),
            }),
          () =>
            approvals.migrateLegacyExecApprovals({
              ...context,
              detected: approvals.detectLegacyExecApprovals(context),
            }),
        ]) {
          for (const warning of (await migrate()).warnings) {
            runtime.error(warning);
          }
        }
        if ((await readCredentialPreparationState(env)) !== "ready") {
          throw new ClientCredentialMigrationRequiredError();
        }
      });
    } finally {
      await maintenance.release();
    }
  });
}

async function preparePostgresClientCredentials(env: NodeJS.ProcessEnv, runtime: RuntimeEnv) {
  const [
    preflight,
    { prepareDoctorDatabaseMigrations },
    { withEngineStoreAdmission },
    state,
    credentials,
  ] = await Promise.all([
    import("../state/openclaw-database-preflight.js"),
    import("./doctor-schema-migrations.js"),
    import("../infra/database-engine/admission-scope.js"),
    import("../state/openclaw-state-db.js"),
    import("../infra/client-credential-migration.js"),
  ]);
  const schemas = await preflight.preflightOpenClawDatabaseSchemas({ env, scope: "state" });
  if (schemas.incompatible.length) {
    throw new preflight.OpenClawDatabaseSchemaPreflightError(schemas.incompatible, {
      operation: "doctor",
    });
  }
  const unreadable = schemas.indeterminate.find((entry) => entry.kind === "state");
  if (unreadable) {
    throw new Error(`Cannot prepare client credentials: ${unreadable.reason}`);
  }
  const migrations = schemas.pendingMigrations?.filter((entry) => entry.kind === "state") ?? [];
  if (migrations.length) {
    const paths = migrations.map((entry) => entry.path);
    const result = await prepareDoctorDatabaseMigrations({
      env,
      pendingDatabasePaths: paths,
      pendingMigrations: migrations,
      databasePaths: paths,
    });
    for (const warning of result.warnings) {
      runtime.error(warning);
    }
  }
  withEngineStoreAdmission(() => {
    const source = state.openOpenClawStateDatabase({ env });
    credentials.recoverClientCredentialStore(source.db, { env, path: source.path });
  });
}
