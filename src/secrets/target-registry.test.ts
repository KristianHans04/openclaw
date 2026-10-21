/** Tests core secret target registry queries without plugin discovery. */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  discoverConfigSecretTargetsByIds,
  resolveConfigSecretTargetByPath,
  resolveSecretPlanTargetByPathCore,
} from "./target-registry.js";

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: () => ({ plugins: [] }),
}));

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const resolvePlan = (configFile: "openclaw.json" | "auth-profile-store", path: string[]) =>
  resolveSecretPlanTargetByPathCore({ configFile, pathSegments: path });

describe("secret target registry", () => {
  it("discovers PostgreSQL connection refs for configure, apply, and audit", () => {
    const connection = envRef("DATABASE_DSN");
    const config: OpenClawConfig = { database: { engine: "postgres", postgres: { connection } } };
    const [target] = discoverConfigSecretTargetsByIds(
      config,
      new Set(["database.postgres.connection"]),
    );
    expect(target).toMatchObject({
      path: "database.postgres.connection",
      value: connection,
      entry: { includeInPlan: true, includeInConfigure: true, includeInAudit: true },
    });
    expect(resolvePlan("openclaw.json", ["database", "postgres", "connection"])?.entry.id).toBe(
      "database.postgres.connection",
    );
  });

  it("preserves dotted provider header keys during discovery", () => {
    const config = {
      models: {
        providers: {
          openai: {
            headers: {
              "X.Trace": envRef("TRACE_HEADER"),
            },
            request: {
              headers: {
                "X.Request.Trace": envRef("REQUEST_TRACE_HEADER"),
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const targets = discoverConfigSecretTargetsByIds(
      config,
      new Set(["models.providers.*.headers.*", "models.providers.*.request.headers.*"]),
    );

    expect(targets.map(({ path }) => path).toSorted()).toEqual([
      'models.providers.openai.headers["X.Trace"]',
      'models.providers.openai.request.headers["X.Request.Trace"]',
    ]);
  });

  it("returns null when no config target path matches", () => {
    expect(resolveConfigSecretTargetByPath(["gateway", "auth", "mode"])).toBeNull();
  });

  it.each([{ prefix: [] }, { prefix: ["agents", "entries", "main"] }])(
    "does not offer string-only memory headers as structured SecretRef apply targets ($prefix)",
    ({ prefix }) => {
      expect(
        resolveConfigSecretTargetByPath([
          ...prefix,
          "memory",
          "search",
          "remote",
          "headers",
          "Authorization",
        ]),
      ).toBeNull();
    },
  );

  it("resolves plan targets by owning config document", () => {
    expect(resolvePlan("openclaw.json", ["models", "providers", "openai", "apiKey"])).toMatchObject(
      { entry: { targetType: "models.providers.apiKey" }, providerId: "openai" },
    );
    expect(
      resolvePlan("auth-profile-store", ["profiles", "openai:default", "key"])?.entry.targetType,
    ).toBe("auth-profiles.api_key.key");
  });
});
