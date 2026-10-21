import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const storeMocks = vi.hoisted(() => ({
  readValue: vi.fn(),
}));

vi.mock("./store/secret-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store/secret-store.js")>();
  return { ...actual, readSecretStoreValue: storeMocks.readValue };
});

const roots: string[] = [];
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const missing = {
  ok: false,
  error: { code: "SECRET_STORE_NOT_FOUND", message: "Secret store entry was not found." },
};

async function runtimeOptions(skill: string, id: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-store-"));
  roots.push(root);
  const ref = { source: "store", provider: "default", id } as const;
  return {
    ref,
    options: {
      config: asConfig({
        agents: { entries: { main: {} } },
        skills: { entries: { [skill]: { apiKey: ref } } },
      }),
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      loadablePluginOrigins: new Map(),
    },
  };
}

beforeEach(() => {
  storeMocks.readValue.mockReset().mockResolvedValue(missing);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("store SecretRef runtime degradation", () => {
  it("isolates a missing store-backed skill instead of failing gateway startup", async () => {
    const { ref, options } = await runtimeOptions("unavailable", "MISSING_SKILL_API_KEY");
    const snapshot = await prepareSecretsRuntimeSnapshot(options);

    expect(snapshot.config.skills?.entries?.unavailable?.apiKey).toEqual(ref);
    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "skill:unavailable",
        state: "unavailable",
        reason: "secret reference was not found",
      },
    ]);
  });

  it.each(["missing", "redacted"])(
    "makes a %s store ref cold instead of retaining its value",
    async (failure) => {
      const { ref, options } = await runtimeOptions("service", "SERVICE_API_KEY");

      storeMocks.readValue.mockResolvedValue({ ok: true, value: "previous-secret" });
      const active = await prepareSecretsRuntimeSnapshot(options);
      const { activateSecretsRuntimeSnapshot } = await import("./runtime.js");
      activateSecretsRuntimeSnapshot(active);
      expect(active.config.skills?.entries?.service?.apiKey).toBe("previous-secret");

      storeMocks.readValue.mockResolvedValue(
        failure === "redacted" ? { ok: true, value: "__OPENCLAW_REDACTED__" } : missing,
      );
      const refreshed = await prepareSecretsRuntimeSnapshot({
        ...options,
        ...(failure === "missing"
          ? { forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]) }
          : {}),
      });

      expect(refreshed.config.skills?.entries?.service?.apiKey).toEqual(ref);
      expect(refreshed.degradedOwners).toMatchObject([
        {
          ownerKind: "capability",
          ownerId: "skill:service",
          degradationState: "cold",
        },
      ]);
      expect(JSON.stringify(refreshed)).not.toContain("previous-secret");
    },
  );
});
