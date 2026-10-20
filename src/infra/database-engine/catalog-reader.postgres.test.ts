import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { expect, it } from "vitest";
import {
  registerResolvedAgentDir,
  unregisterResolvedAgentDir,
} from "../../agents/agent-dir-registry.js";
import { writeAuthProfileJsonCell } from "../../agents/auth-profiles/sqlite-json-write.js";
import { inspectPersistedAuthProfileStoreRaw } from "../../agents/auth-profiles/sqlite.js";
import {
  PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
  readPluginModelCatalogEntries,
  replacePluginModelCatalogEntriesInDatabase,
} from "../../agents/plugin-model-catalog.kernel.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;

it.skipIf(!connection)(
  "shares the registered catalog auth reader without changing unregistered custom-path reads",
  async () => {
    const databaseName = `catalog_reader_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const client = new Client({ connectionString: connection });
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    const databaseClient = new Client({ connectionString: databaseUrl.href });
    await client.connect();
    try {
      await client.query(`CREATE DATABASE "${databaseName}"`);
      await databaseClient.connect();
      await databaseClient.query("CREATE EXTENSION unaccent");
      await databaseClient.query("CREATE EXTENSION pg_trgm");
      await databaseClient.query("CREATE EXTENSION vector");
      installDatabaseEngineSelection({
        effectiveEngines: resolveDatabaseFamilyEngines({
          database: { families: { agent: { engine: "postgres" } } },
        }),
        postgres: { connection: databaseUrl.href, schemaPrefix: databaseName },
      });
      await withOpenClawTestState(
        { scenario: "minimal", prepareProfileCatalog: false },
        async (state) => {
          const agentId = "catalog-reader";
          const agentDir = state.path("custom-agent");
          const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
          const target = { agentId, agentDir, env: state.env };
          const options = { agentId, path: databasePath, env: state.env };
          const store = {
            version: 1,
            profiles: { fixture: { type: "api_key", provider: "fixture", key: "synthetic" } },
          };
          const contents = '{"providers":{"fixture":{"models":[]}}}';
          withEngineStoreAdmission(() => {
            openOpenClawAgentDatabase(options);
            runOpenClawAgentWriteTransaction(({ db }) => {
              writeAuthProfileJsonCell(db, "store", "agent", store);
              replacePluginModelCatalogEntriesInDatabase({
                database: db,
                planned: new Map([["fixture", contents]]),
                updatedAt: 1,
              });
            }, options);
          });
          await closeOpenClawAgentDatabaseByPathAsync(databasePath, agentId);
          const readAuth = () =>
            withEngineStoreAdmission(() => inspectPersistedAuthProfileStoreRaw(agentDir));
          // Arbitrary directories need the stored owner, not an ID inferred from their name.
          expect(readAuth()).toEqual({ status: "readable", raw: store });
          expect(registerResolvedAgentDir(target)).toBe(true);
          try {
            expect(readAuth()).toEqual({ status: "readable", raw: store });
            await client.query(`ALTER DATABASE "${databaseName}" ALLOW_CONNECTIONS false`);
            try {
              expect(readAuth()).toEqual({ status: "readable", raw: store });
              expect(
                withEngineStoreAdmission(() =>
                  readPluginModelCatalogEntries(options, PLUGIN_MODEL_CATALOG_CACHE_SCOPE, [
                    "fixture",
                  ]),
                ),
              ).toEqual([{ pluginId: "fixture", contents }]);
            } finally {
              await client.query(`ALTER DATABASE "${databaseName}" ALLOW_CONNECTIONS true`);
            }
          } finally {
            unregisterResolvedAgentDir(target);
          }
        },
      );
    } finally {
      resetDatabaseEngineSelectionForTest();
      try {
        await databaseClient.end();
      } finally {
        try {
          // No FORCE: fixture drainage must release the retained catalog reader.
          await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        } finally {
          await client.end();
        }
      }
    }
  },
);
