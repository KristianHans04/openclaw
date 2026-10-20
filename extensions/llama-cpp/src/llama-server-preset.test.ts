import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withMockedPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLlamaServerPreset, type LlamaServerPresetOptions } from "./llama-server-preset.js";
import { prepareManagedLlamaServer } from "./managed-server.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
const EMBEDDING = "[embeddinggemma-300m-qat-q8_0]";
const CAPACITY = "parallel = 1\nctx-size = 2048\nubatch-size = 2048\n";

function refreshEmbedding(
  existing: string | undefined,
  options: Partial<LlamaServerPresetOptions> = {},
): string {
  return buildLlamaServerPreset(existing, {
    chatModel: { mode: "remove" },
    embeddingModelPath: "/models/embedding.gguf",
    ...options,
  });
}

describe("managed embedding capacity defaults", () => {
  it("keeps a preset np alias slot count without shrinking its context", () => {
    const preset = refreshEmbedding(
      `version = 1\n\n${EMBEDDING}\nmodel = /models/old.gguf\nnp = 2\nembedding = true\n`,
    );
    expect(preset).not.toMatch(/parallel = 1|ctx-size/u);
    expect(preset).toContain(`${EMBEDDING}\nmodel = /models/embedding.gguf\nnp = 2\n`);
    expect(preset).toContain("ubatch-size = 2048");
  });

  it("keeps explicit context and physical batch settings", () => {
    const global = "[*]\nLLAMA_ARG_KV_UNIFIED_PER_SLOT = 8192\nLLAMA_ARG_UBATCH = 1024\n\n";
    const existing = `version = 1\n\n${global}${EMBEDDING}\nmodel = /models/old.gguf\n`;
    const preset = refreshEmbedding(existing);
    expect(preset).toContain(`${global}${EMBEDDING}\nmodel = /models/embedding.gguf\n`);
    expect(preset).toContain("parallel = 1");
    expect(preset).not.toMatch(/ctx-size|ubatch-size/u);
  });

  it("keeps the router service's -np slot/context policy", () => {
    const preset = refreshEmbedding(undefined, { serviceSettings: { args: ["-np", "3"] } });
    expect(preset).not.toMatch(/parallel|ctx-size/u);
    expect(preset).toContain("ubatch-size = 2048");
  });

  it("preserves native per-slot sizing from --kv_unified_per_slot", () => {
    const preset = refreshEmbedding(undefined, {
      serviceSettings: { args: ["--kv_unified_per_slot", "8192"] },
    });
    expect(preset).not.toContain("ctx-size");
    expect(preset).toContain("parallel = 1");
    expect(preset).toContain("ubatch-size = 2048");
  });

  it("matches Windows environment names case-insensitively", () => {
    withMockedPlatform("win32", () => {
      const preset = refreshEmbedding(undefined, {
        serviceSettings: { env: { Llama_Arg_N_Parallel: "4" } },
      });
      expect(preset).not.toMatch(/parallel = 1|ctx-size = 2048/u);
    });
  });
});

describe("managed embedding capacity through server preparation", () => {
  async function prepareCandidatePreset(root: string, activePreset: string): Promise<string> {
    const runtime = await prepareManagedLlamaServer({
      localService: {
        command: path.join(root, "custom-server"),
        args: ["--models-preset", activePreset, "--parallel", "4"],
        env: { LLAMA_ARG_N_PARALLEL: "4" },
      },
      isolated: true,
      chatModel: { mode: "remove" },
      embeddingModelPath: "/models/embedding.gguf",
      port: 19_437,
    });
    const candidatePreset = String(runtime.args[runtime.args.indexOf("--models-preset") + 1]);
    expect(candidatePreset).not.toBe(activePreset);
    return await fs.readFile(candidatePreset, "utf8");
  }

  it("bounds an isolated candidate without changing the active preset or adopting its settings", async () => {
    const root = tempDirs.make("llama-server-candidate-slots-");
    const activePreset = path.join(root, "models.ini");
    await fs.writeFile(activePreset, "version = 1\n");
    expect(await prepareCandidatePreset(root, activePreset)).toContain(CAPACITY);
    expect(await fs.readFile(activePreset, "utf8")).toBe("version = 1\n");
  });

  it.each(["service", "process"])("keeps slot settings from the %s environment", async (source) => {
    if (source === "process") {
      vi.stubEnv("LLAMA_ARG_N_PARALLEL", "4");
    }
    const root = tempDirs.make("llama-server-environment-slots-");
    const presetPath = path.join(root, "custom.ini");
    await fs.writeFile(presetPath, `version = 1\n\n${EMBEDDING}\nmodel = /models/old.gguf\n`);
    await prepareManagedLlamaServer({
      localService: {
        command: path.join(root, "custom-server"),
        args: ["--models-preset", presetPath],
        ...(source === "service" ? { env: { LLAMA_ARG_N_PARALLEL: "4" } } : {}),
      },
      chatModel: { mode: "remove" },
      embeddingModelPath: "/models/embedding.gguf",
      port: 19_436,
    });
    expect(await fs.readFile(presetPath, "utf8")).not.toMatch(/parallel|ctx-size/u);
    if (source === "process") {
      expect(await prepareCandidatePreset(root, presetPath)).not.toMatch(/parallel|ctx-size/u);
    }
  });
});
