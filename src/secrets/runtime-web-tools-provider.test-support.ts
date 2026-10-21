import { ensureRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/config.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";

export type ProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "duckduckgo";

export function createWebCredentialEntry(
  surface: "webSearch" | "webFetch",
  apiKey: unknown,
  options: { enabled?: boolean } = {},
) {
  return {
    ...options,
    config: { [surface]: { apiKey } },
  };
}

export function providerPluginId(provider: ProviderUnderTest): string {
  switch (provider) {
    case "gemini":
      return "google";
    case "grok":
      return "xai";
    case "kimi":
      return "moonshot";
    default:
      return provider;
  }
}

export { ensureRecord };

function setConfiguredProviderKey(
  configTarget: OpenClawConfig,
  pluginId: string,
  surface: "webSearch" | "webFetch",
  value: unknown,
): void {
  const plugins = ensureRecord(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const pluginEntry = ensureRecord(entries, pluginId);
  const config = ensureRecord(pluginEntry, "config");
  ensureRecord(config, surface).apiKey = value;
}

function configuredKey(
  config: OpenClawConfig | undefined,
  pluginId: string,
  surface: "webSearch" | "webFetch",
) {
  const entry = config?.plugins?.entries?.[pluginId]?.config;
  return entry && typeof entry === "object"
    ? (entry as Partial<Record<typeof surface, { apiKey?: unknown }>>)[surface]?.apiKey
    : undefined;
}

export function createTestProvider(params: {
  provider: ProviderUnderTest;
  pluginId: string;
  order: number;
}): PluginWebSearchProviderEntry {
  const credentialPath = `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  return {
    pluginId: params.pluginId,
    id: params.provider,
    label: params.provider,
    hint: `${params.provider} test provider`,
    requiresCredential: params.provider === "duckduckgo" ? false : undefined,
    envVars: params.provider === "duckduckgo" ? [] : [`${params.provider.toUpperCase()}_API_KEY`],
    placeholder: params.provider === "duckduckgo" ? "(no key needed)" : `${params.provider}-...`,
    signupUrl: `https://example.com/${params.provider}`,
    autoDetectOrder: params.order,
    credentialPath: params.provider === "duckduckgo" ? "" : credentialPath,
    inactiveSecretPaths: params.provider === "duckduckgo" ? [] : [credentialPath],
    getCredentialValue: (searchConfig) =>
      params.provider === "duckduckgo" ? "duckduckgo-no-key-needed" : searchConfig?.apiKey,
    setCredentialValue: (searchConfigTarget, value) => {
      searchConfigTarget.apiKey = value;
    },
    getConfiguredCredentialValue: (config) => configuredKey(config, params.pluginId, "webSearch"),
    getConfiguredCredentialFallback: (config) => {
      if (params.provider === "gemini") {
        const provider = config?.models?.providers?.google;
        return provider && typeof provider === "object" && "apiKey" in provider
          ? {
              path: "models.providers.google.apiKey",
              value: (provider as { apiKey?: unknown }).apiKey,
            }
          : undefined;
      }
      return undefined;
    },
    setConfiguredCredentialValue: (configTarget, value) => {
      setConfiguredProviderKey(configTarget, params.pluginId, "webSearch", value);
    },
    resolveRuntimeMetadata:
      params.provider === "perplexity"
        ? () => ({
            perplexityTransport: "search_api" as const,
          })
        : undefined,
    createTool: () => null,
  };
}

export function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return [
    createTestProvider({ provider: "brave", pluginId: "brave", order: 10 }),
    createTestProvider({ provider: "gemini", pluginId: "google", order: 20 }),
    createTestProvider({ provider: "grok", pluginId: "xai", order: 30 }),
    createTestProvider({ provider: "kimi", pluginId: "moonshot", order: 40 }),
    createTestProvider({ provider: "perplexity", pluginId: "perplexity", order: 50 }),
    createTestProvider({ provider: "duckduckgo", pluginId: "duckduckgo", order: 100 }),
  ];
}

export function buildTestWebFetchProviders(): PluginWebFetchProviderEntry[] {
  return [
    {
      pluginId: "firecrawl",
      id: "firecrawl",
      label: "firecrawl",
      hint: "firecrawl test provider",
      requiresCredential: false,
      envVars: ["FIRECRAWL_API_KEY"],
      placeholder: "fc-...",
      signupUrl: "https://example.com/firecrawl",
      autoDetectOrder: 50,
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      inactiveSecretPaths: ["plugins.entries.firecrawl.config.webFetch.apiKey"],
      getCredentialValue: (fetchConfig) => fetchConfig?.apiKey,
      setCredentialValue: (fetchConfigTarget, value) => {
        fetchConfigTarget.apiKey = value;
      },
      getConfiguredCredentialValue: (config) => configuredKey(config, "firecrawl", "webFetch"),
      getConfiguredCredentialFallback: (config) => {
        const apiKey = configuredKey(config, "firecrawl", "webSearch");
        return apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webSearch.apiKey",
              value: apiKey,
            };
      },
      setConfiguredCredentialValue: (configTarget, value) => {
        setConfiguredProviderKey(configTarget, "firecrawl", "webFetch", value);
      },
      createTool: () => null,
    },
  ];
}
