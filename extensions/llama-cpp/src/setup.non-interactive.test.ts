import assert from "node:assert/strict";
import path from "node:path";
import { Command } from "commander";
import type {
  ProviderAuthMethodNonInteractiveContext,
  ProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { buildLlamaCppModel, DEFAULT_LLAMA_CPP_EMBEDDING_MODEL } from "./defaults.js";
import { mocks, tempRoot } from "./setup.test-support.js";

const { default: plugin } = await import("../index.js");
const localChoice =
  manifest.providerAuthChoices.find((choice) => choice.method === "local") ??
  assert.fail("managed llama.cpp must declare its local auth choice");
const memory = { search: { provider: "local" as const } };
const other = { baseUrl: "http://localhost:8080/v1", models: [] };

function serverConfig(managed: boolean): ProviderAuthMethodNonInteractiveContext["config"] {
  const models = managed
    ? [buildLlamaCppModel({ id: "chat", name: "Chat", source: "/models/chat.gguf" })]
    : [];
  const localService = managed ? { command: "/runtime/llama-server" } : undefined;
  return {
    memory: structuredClone(memory),
    models: { providers: { "llama-cpp": { ...other, models, localService } } },
  };
}

function expectNoDownloads() {
  expect(mocks.ensureServerInstalled).not.toHaveBeenCalled();
  expect(mocks.ensureModel).not.toHaveBeenCalled();
}

function expectEmbeddingDownload(source: string) {
  expect(mocks.ensureModel).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ source, download: true }),
  );
}

function setupContext(): ProviderAuthMethodNonInteractiveContext {
  return {
    authChoice: "llama-cpp",
    config: { memory: structuredClone(memory) },
    baseConfig: {},
    opts: new Command()
      .exitOverride()
      .option(localChoice.cliOption)
      .parse([localChoice.cliFlag], { from: "user" })
      .opts<Record<string, unknown>>(),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    resolveApiKey: vi.fn(),
    toApiKeyCredential: vi.fn(),
  };
}

async function setup(ctx: ProviderAuthMethodNonInteractiveContext) {
  const providers: ProviderPlugin[] = [];
  plugin.register(
    createTestPluginApi({ registerProvider: (provider) => providers.push(provider) }),
  );
  const method = providers
    .find((provider) => provider.id === "llama-cpp")
    ?.auth.find((entry) => entry.id === "local");
  assert(method?.runNonInteractive, "managed llama.cpp must support non-interactive setup");
  return await method.runNonInteractive(ctx);
}

describe("managed llama.cpp non-interactive onboarding", () => {
  it.each([undefined, false, "true"])(
    "requires explicit boolean download consent (%s)",
    async (consent) => {
      const ctx = setupContext();
      ctx.opts.llamaCppEmbeddingOnly = consent;
      await expect(setup(ctx)).rejects.toThrow("--llama-cpp-embedding-only");
      expectNoDownloads();
    },
  );

  it("downloads only embeddings and preserves chat, unrelated providers and auth bindings", async () => {
    const ctx = setupContext();
    expect(ctx.opts).toEqual({ [localChoice.optionKey]: true });
    ctx.config.agents = { defaults: { model: { primary: "openai/gpt-5.4" } } };
    ctx.config.models = { providers: { other: structuredClone(other) } };
    ctx.config.auth = {
      profiles: {
        "llama-cpp:default": { provider: "llama-cpp", mode: "api_key" },
        "other:default": { provider: "other", mode: "api_key" },
      },
      order: { "llama-cpp": ["llama-cpp:default"], other: ["other:default"] },
    };

    const result = await setup(ctx);

    expect(result?.models?.providers?.["llama-cpp"]).toMatchObject({
      baseUrl: "http://127.0.0.1:19432/v1",
      api: "openai-completions",
      models: [],
      localService: { command: path.join(tempRoot, "llama-server") },
    });
    expect(result?.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(result?.models?.providers?.other).toEqual(other);
    expect(result?.auth).toEqual({
      profiles: { "other:default": { provider: "other", mode: "api_key" } },
      order: { other: ["other:default"] },
    });
    expect(ctx.config.auth.profiles?.["llama-cpp:default"]).toBeDefined();
    expectEmbeddingDownload(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
  });

  it("uses the enabled agent's configured embedding model", async () => {
    const ctx = setupContext();
    ctx.config = {
      agents: {
        entries: {
          research: {
            memory: {
              search: { ...memory.search, local: { modelPath: "/models/custom-embedding.gguf" } },
            },
          },
        },
      },
    };
    await setup(ctx);
    expectEmbeddingDownload("/models/custom-embedding.gguf");
  });

  it.each([
    ["unconfigured local memory", {}, "Set memory.search.provider"],
    [
      "disabled local memory",
      { memory: { search: { enabled: false, provider: "local" } } },
      "Set memory.search.provider",
    ],
    ["external server", serverConfig(false), "Embedding-only setup cannot replace"],
    ["managed chat server", serverConfig(true), "Embedding-only setup cannot replace"],
    [
      "conflicting embedding models",
      {
        memory,
        agents: {
          entries: {
            alpha: { memory: { search: { local: { modelPath: "/models/alpha.gguf" } } } },
            beta: { memory: { search: { local: { modelPath: "/models/beta.gguf" } } } },
          },
        },
      },
      "Configured agents resolve to different",
    ],
  ] satisfies [string, ProviderAuthMethodNonInteractiveContext["config"], string][])(
    "rejects %s before downloads",
    async (_name, config, error) => {
      const ctx = setupContext();
      ctx.config = config;
      await expect(setup(ctx)).rejects.toThrow(error);
      expectNoDownloads();
    },
  );
});
