import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { withServer } from "../plugin-sdk/test-env.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "../plugins/web-provider-public-artifacts.explicit.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { runWebSearch } from "./runtime.js";

beforeEach(() => {
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("loads the native public artifact and keeps an explicit ClawRouter denial terminal", async () => {
  const manifestRecords = loadPluginManifestRegistryCore().plugins;
  const native = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
    onlyPluginIds: ["clawrouter"],
    manifestRecords,
  })?.find((provider) => provider.id === "clawrouter-tavily");
  expect(native).toBeDefined();
  const paths: string[] = [];
  const authorization: Array<string | undefined> = [];
  let denied = false;
  await withServer(
    (request, response) => {
      paths.push(request.url!);
      authorization.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/catalog") {
        response.end(
          JSON.stringify({
            version: "clawrouter.client-catalog.v1",
            providers: [
              {
                id: "tavily",
                allowed: true,
                executable: true,
                nativeBaseUrl: "/v1/native/tavily",
                routes: [
                  {
                    path: "/search",
                    methods: ["POST"],
                    requestFormat: "tavily.search",
                    responseFormat: "tavily.search",
                  },
                ],
                models: [{ id: "tavily/search", upstream: "search", capabilities: ["web.search"] }],
              },
            ],
          }),
        );
      } else {
        response.statusCode = denied ? 402 : 200;
        response.end(
          JSON.stringify(
            denied
              ? { error: { message: "budget denied" } }
              : {
                  results: [
                    { title: "source", content: "citation", url: "https://example.com/citation" },
                  ],
                },
          ),
        );
      }
    },
    async (origin) => {
      await withOpenClawTestState({ label: "clawrouter-native-tavily-caller" }, async (state) => {
        const agentDir = state.agentDir();
        const authStore = {
          version: 1,
          profiles: {
            "clawrouter:automation-fixture": {
              type: "api_key" as const,
              provider: "clawrouter",
              key: "synthetic-router-key",
            },
          },
        };
        // Exercise the persisted automation credential through the real SDK auth loader.
        await state.writeAuthProfiles(authStore);
        const config: OpenClawConfig = {
          tools: { web: { search: { provider: "clawrouter-tavily" } } },
          models: {
            providers: {
              clawrouter: {
                baseUrl: origin + "/v1",
                models: [],
                request: { allowPrivateNetwork: true },
              },
            },
          },
          plugins: { entries: { clawrouter: { enabled: true } } },
        };
        const fixture = createPluginRegistryFixture(config);
        const alternate = vi.fn(async () => ({ results: [] }));
        registerVirtualTestPlugin({
          ...fixture,
          id: "clawrouter",
          name: "ClawRouter",
          contracts: { webSearchProviders: ["clawrouter-tavily"] },
          register(api) {
            api.registerWebSearchProvider(native!);
          },
        });
        registerVirtualTestPlugin({
          ...fixture,
          id: "fixture-alternate",
          name: "Alternate",
          contracts: { webSearchProviders: ["alternate"] },
          register(api) {
            api.registerWebSearchProvider(
              createWebSearchTestProvider({
                id: "alternate",
                pluginId: "fixture-alternate",
                credentialPath: "",
                requiresCredential: false,
                createTool: () => ({
                  description: "alternate",
                  parameters: {},
                  execute: alternate,
                }),
              }),
            );
          },
        });
        const search = () =>
          withPluginRuntimeRegistryScope(fixture.registry.registry, () =>
            runWebSearch({
              config,
              preferInputConfig: true,
              preferRuntimeProviders: true,
              authStore,
              agentDir,
              args: { query: "native citation" },
            }),
          );
        await expect(search()).resolves.toMatchObject({
          provider: "clawrouter-tavily",
          result: {
            provider: "clawrouter-tavily",
            count: 1,
            results: [{ url: "https://example.com/citation" }],
          },
        });
        denied = true;
        await expect(search()).rejects.toThrow("402");
        expect(alternate).not.toHaveBeenCalled();
        expect(authorization).toEqual(Array(4).fill("Bearer synthetic-router-key"));
        expect(paths).toEqual([
          "/v1/catalog",
          "/v1/native/tavily/search",
          "/v1/catalog",
          "/v1/native/tavily/search",
        ]);
      });
    },
  );
});
