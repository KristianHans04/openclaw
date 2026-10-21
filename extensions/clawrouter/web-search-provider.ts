import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const loadRuntime = createLazyRuntimeModule(() => import("./web-search-provider.runtime.js"));

export function createClawRouterTavilyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "clawrouter-tavily",
    label: "Tavily through ClawRouter",
    hint: "Native Tavily search using your managed ClawRouter credential and grants",
    // Explicit selection only: a router denial must never trigger another account/provider.
    requiresCredential: false,
    authProviderId: "clawrouter",
    envVars: [],
    placeholder: "",
    signupUrl: "https://clawrouter.openclaw.ai",
    docsUrl: "https://docs.openclaw.ai/providers/clawrouter",
    credentialPath: "models.providers.clawrouter.apiKey",
    configPath: null,
    ...createWebSearchProviderContractFields({
      credentialPath: "",
      searchCredential: { type: "none" },
    }),
    createTool: (ctx) => ({
      description:
        "Search the web with Tavily through ClawRouter. Returns cited sources and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          count: { type: "integer", minimum: 1, maximum: 20, description: "Result count (1-20)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(args, execution) {
        execution?.signal?.throwIfAborted();
        const query = readStringParam(args, "query", { required: true });
        const count = readPositiveIntegerParam(args, "count", { max: 20 }) ?? 5;
        const { searchClawRouterTavily } = await loadRuntime();
        return searchClawRouterTavily({
          config: ctx.config,
          agentDir: ctx.agentDir,
          authProfile: ctx.authProfile,
          query,
          count,
          ...execution,
        });
      },
    }),
  };
}
