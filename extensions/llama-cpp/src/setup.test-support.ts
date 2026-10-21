import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  prepareServer: vi.fn(),
  removeProfiles: vi.fn(),
  progressUpdate: vi.fn(),
  hardware: vi.fn(),
  downloadFetch: vi.fn(),
  ensureServerInstalled: vi.fn(),
}));
export { mocks };

function mockWith<T extends object>(overrides: T) {
  return async <M>(load: () => Promise<M>) => ({ ...(await load()), ...overrides });
}

vi.mock(
  import("openclaw/plugin-sdk/provider-auth-runtime"),
  mockWith({ removeProviderAuthProfilesWithLock: mocks.removeProfiles }),
);
vi.mock(
  import("openclaw/plugin-sdk/ssrf-runtime"),
  mockWith({ fetchWithSsrFGuard: mocks.downloadFetch }),
);
vi.mock(
  import("./managed-server.js"),
  mockWith({
    ensureLlamaCppModel: mocks.ensureModel,
    prepareManagedLlamaServer: mocks.prepareServer,
  }),
);
vi.mock(
  import("./llama-server-install.js"),
  mockWith({ ensureLlamaServerInstalled: mocks.ensureServerInstalled }),
);
vi.mock(import("./hardware.js"), mockWith({ detectLlamaCppHardware: mocks.hardware }));

import { GIB, hardware } from "./catalog.test-support.js";
import { LLAMA_CPP_PROVIDER_ID } from "./defaults.js";
import { resolveLlamaCppCatalogArtifact } from "./model-catalog.js";

export { GIB };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
export let tempRoot: string;
export let modelPath: string;

beforeEach(async () => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GIB);
  vi.spyOn(os, "hostname").mockReturnValue("gateway-host");
  mocks.hardware.mockImplementation(async () => hardware(os.totalmem() / GIB));
  tempRoot = await fs.realpath(tempDirs.make("llama-server-setup-"));
  modelPath = path.join(tempRoot, "model.gguf");
  const command = path.join(tempRoot, "llama-server");
  mocks.ensureModel.mockImplementation(async ({ source, download }) => {
    if (!download) {
      throw new Error("not cached");
    }
    return resolveLlamaCppCatalogArtifact(source)
      ? modelPath
      : path.join(tempRoot, "embedding.gguf");
  });
  mocks.prepareServer.mockResolvedValue({
    command,
    baseUrl: "http://127.0.0.1:19432/v1",
    healthUrl: "http://127.0.0.1:19432/health",
    args: ["--host", "127.0.0.1", "--port", "19432"],
  });
  mocks.removeProfiles.mockResolvedValue({ version: 1, profiles: {} });
  mocks.ensureServerInstalled.mockImplementation(async ({ asset }) => ({ command, asset }));
});

afterEach(() => vi.restoreAllMocks());

export function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:19432/v1",
    params: { modelCacheDir: tempRoot },
    models: [],
    ...overrides,
  };
}

export function config(): ProviderAuthContext["config"] {
  const providers = { [LLAMA_CPP_PROVIDER_ID]: provider({ api: "openai-completions" }) };
  return { models: { providers } };
}

export function authContext(confirm: boolean): ProviderAuthContext {
  const prompter = {
    confirm: vi.fn(async () => confirm),
    note: vi.fn(async () => {}),
    progress: vi.fn(() => ({ update: mocks.progressUpdate, stop: vi.fn() })),
  };
  return { config: config(), prompter, runtime: {} } as unknown as ProviderAuthContext;
}
