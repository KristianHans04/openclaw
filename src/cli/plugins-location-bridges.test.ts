import { beforeEach, expect, it, vi } from "vitest";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";

const readPersistedInstalledPluginIndexMock = vi.fn();
const loadPluginManifestRegistryForInstalledIndexMock = vi.fn();

vi.mock("../plugins/installed-plugin-index-store.js", () => ({
  readPersistedInstalledPluginIndex: (...args: unknown[]) =>
    readPersistedInstalledPluginIndexMock(...args),
}));

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: (...args: unknown[]) =>
    loadPluginManifestRegistryForInstalledIndexMock(...args),
}));

const { listPersistedBundledPluginLocationBridges, listPersistedBundledPluginRecoveryLocations } =
  await import("../plugins/location-bridges.js");

function makeIndex(
  pluginId: string,
  overrides: Partial<InstalledPluginIndex["plugins"][number]> = {},
) {
  const record: InstalledPluginIndex["plugins"][number] = {
    pluginId,
    manifestPath: `/app/dist/extensions/${pluginId}/openclaw.plugin.json`,
    manifestHash: "hash",
    source: `/app/dist/extensions/${pluginId}/index.js`,
    rootDir: `/app/dist/extensions/${pluginId}`,
    origin: "bundled",
    enabled: true,
    startup: { sidecar: false, memory: false, agentHarnesses: [] },
    compat: [],
    ...overrides,
  };
  return { plugins: [record] };
}

beforeEach(() => {
  readPersistedInstalledPluginIndexMock.mockReset();
  loadPluginManifestRegistryForInstalledIndexMock.mockReset();
});

it("targets the renamed official plugin id when externalizing a bundled plugin", async () => {
  readPersistedInstalledPluginIndexMock.mockResolvedValue(
    makeIndex("qqbot", { packageInstall: { warnings: [] } }),
  );
  loadPluginManifestRegistryForInstalledIndexMock.mockReturnValue({
    plugins: [{ id: "qqbot", channels: ["qqbot"] }],
  });

  await expect(listPersistedBundledPluginLocationBridges({})).resolves.toEqual([
    {
      bundledPluginId: "qqbot",
      pluginId: "openclaw-qqbot",
      npmSpec: "@tencent-connect/openclaw-qqbot@2.0.3",
      expectedIntegrity:
        "sha512-yngu/2cPeZjJfIfHWCXWB2/6KlDHrb9vpOUjKLdQxePLSp6wCn3CFOALcBIVq/9o6jlYz9WTU9idW6nfX1xpFA==",
      channelIds: ["qqbot"],
    },
  ]);
});

it("includes exact packaged and legacy paths for disabled bundled records", async () => {
  readPersistedInstalledPluginIndexMock.mockResolvedValue(
    makeIndex("diagnostics-otel", { enabled: false }),
  );

  await expect(listPersistedBundledPluginRecoveryLocations({})).resolves.toEqual([
    {
      pluginId: "diagnostics-otel",
      loadPaths: ["/app/dist/extensions/diagnostics-otel", "/app/extensions/diagnostics-otel"],
    },
  ]);
});

it("does not use a relative persisted bundled root as ownership proof", async () => {
  readPersistedInstalledPluginIndexMock.mockResolvedValue(
    makeIndex("diagnostics-otel", {
      manifestPath: "extensions/diagnostics-otel/openclaw.plugin.json",
      source: "extensions/diagnostics-otel/index.js",
      rootDir: "extensions/diagnostics-otel",
    }),
  );
  await expect(listPersistedBundledPluginRecoveryLocations({})).resolves.toStrictEqual([]);
});
