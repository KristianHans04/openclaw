import { describe, expect, it } from "vitest";
import { GIB, hardware as makeHardware } from "./catalog.test-support.js";
import type { LlamaCppHardware } from "./hardware.js";
import {
  LLAMA_CPP_MEDIA_RECIPES,
  recommendLlamaCppMedia as recommend,
  resolveLlamaCppMediaArtifact as resolveArtifact,
} from "./media-catalog.js";

const hardware = (overrides: Partial<LlamaCppHardware> = {}) =>
  makeHardware(8, {
    platform: "linux",
    arch: "x64",
    availableMemoryBytes: 7 * GIB,
    accelerator: { kind: "cpu", reason: "CPU host" },
    ...overrides,
  });

describe("managed local media catalog", () => {
  it("pins every model and matching projector to immutable verified downloads", () => {
    expect(new Set(LLAMA_CPP_MEDIA_RECIPES.map((recipe) => recipe.capability))).toEqual(
      new Set(["ocr", "vision"]),
    );
    for (const recipe of LLAMA_CPP_MEDIA_RECIPES) {
      expect(recipe.projector.repository).toBe(recipe.model.repository);
      expect(recipe.projector.revision).toBe(recipe.model.revision);
      for (const artifact of [recipe.model, recipe.projector]) {
        const { repository, revision, filename, source } = artifact;
        expect(artifact).toMatchObject({
          revision: expect.stringMatching(/^[a-f0-9]{40}$/u),
          expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          url: `https://huggingface.co/${repository}/resolve/${revision}/${filename}?download=true`,
        });
        expect(artifact.expectedSize).toBeGreaterThan(0);
        expect(resolveArtifact(source)).toBe(artifact);
        expect(resolveArtifact(source.replace(revision, "main"))).toBeUndefined();
      }
    }
    expect(resolveArtifact("hf:unknown/model/mmproj.gguf")).toBeUndefined();
  });

  it.each([
    ["total RAM", { totalMemoryBytes: 4 * GIB }, /total RAM/u],
    ["unknown disk", { availableRuntimeDiskBytes: undefined }, /permissions/u],
    ["runtime disk", { availableRuntimeDiskBytes: GIB, sharedDisk: false }, /runtime directory/u],
  ] satisfies [string, Partial<LlamaCppHardware>, RegExp][])(
    "rejects insufficient %s",
    (_name, overrides, reason) => {
      expect(recommend(hardware(overrides))).toMatchObject({
        kind: "unavailable",
        reason: expect.stringMatching(reason),
      });
    },
  );

  it("charges separate volumes separately and shared capacity only once", () => {
    const host = hardware({
      availableDiskBytes: 3 * GIB,
      availableRuntimeDiskBytes: 2 * GIB,
      sharedDisk: false,
    });
    expect(recommend(host).kind).toBe("recommended");
    expect(recommend({ ...host, sharedDisk: true }).kind).toBe("unavailable");
  });

  it("credits verified models and projectors independently on retry", () => {
    const artifacts = LLAMA_CPP_MEDIA_RECIPES.flatMap(({ model, projector }) => [model, projector]);
    const { projector } = LLAMA_CPP_MEDIA_RECIPES[1];
    const artifactSha256 = new Set(artifacts.map((artifact) => artifact.expectedSha256));
    const host = hardware({ availableDiskBytes: 1024 ** 2, availableRuntimeDiskBytes: 1024 ** 2 });
    expect(recommend(host, { artifactSha256, runtime: true })).toMatchObject({
      kind: "recommended",
      requiredDiskBytes: 0,
    });
    artifactSha256.delete(projector.expectedSha256);
    expect(recommend(host, { artifactSha256, runtime: true }).kind).toBe("unavailable");
    expect(recommend(hardware(), { artifactSha256, runtime: true })).toMatchObject({
      kind: "recommended",
      requiredDiskBytes: projector.expectedSize,
    });
    expect(recommend(host, { artifactSha256 }).kind).toBe("unavailable");
  });
});
