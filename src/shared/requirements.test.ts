import { describe, expect, it } from "vitest";
import { evaluateRequirementsFromMetadataWithRemote } from "./requirements.js";

type EvaluationParams = Parameters<typeof evaluateRequirementsFromMetadataWithRemote>[0];

function evaluate(overrides: Partial<EvaluationParams> = {}) {
  return evaluateRequirementsFromMetadataWithRemote({
    always: false,
    hasLocalBin: () => false,
    localPlatform: "linux",
    isEnvSatisfied: () => false,
    isConfigSatisfied: () => false,
    ...overrides,
  });
}

describe("requirements evaluation", () => {
  it("requires at least one any-bin locally or remotely", () => {
    const metadata = { requires: { anyBins: ["a", "b"] } };

    expect(evaluate({ metadata }).missing.anyBins).toEqual(["a", "b"]);
    expect(evaluate({ metadata, hasLocalBin: (bin) => bin === "b" }).missing.anyBins).toStrictEqual(
      [],
    );
    const remote = { hasAnyBin: (bins: string[]) => bins.includes("b") };
    expect(evaluate({ metadata, remote }).missing.anyBins).toStrictEqual([]);
  });

  it("normalizes macos and accepts local or remote platforms", () => {
    const missingOs = (os: string, overrides: Partial<EvaluationParams> = {}) =>
      evaluate({ metadata: { os: [os] }, ...overrides }).missing.os;
    expect(missingOs("linux")).toStrictEqual([]);
    expect(missingOs("macos", { localPlatform: "darwin" })).toStrictEqual([]);
    expect(missingOs("macos", { remote: { platforms: ["darwin"] } })).toStrictEqual([]);
    expect(missingOs("darwin")).toEqual(["darwin"]);
  });

  it("reports every missing category through the public wrapper", () => {
    const required = {
      bins: ["node"],
      anyBins: ["bun", "deno"],
      env: ["OPENAI_API_KEY", "PRESENT"],
      config: ["browser.enabled", "gateway.enabled"],
      os: ["darwin"],
    };
    const { os, ...requires } = required;
    const result = evaluate({
      metadata: { requires, os },
      remote: {
        hasBin: (bin) => bin === "node",
        hasAnyBin: () => false,
        platforms: ["windows"],
      },
      isEnvSatisfied: (name) => name === "PRESENT",
      isConfigSatisfied: (path) => path === "gateway.enabled",
    });

    expect(result.required).toEqual(required);
    expect(result.missing).toEqual({
      bins: [],
      anyBins: ["bun", "deno"],
      env: ["OPENAI_API_KEY"],
      config: ["browser.enabled"],
      os: ["darwin"],
    });
    expect(result.configChecks).toEqual([
      { path: "browser.enabled", satisfied: false },
      { path: "gateway.enabled", satisfied: true },
    ]);
    expect(result.eligible).toBe(false);
  });

  it("clears runtime requirements when always is true on a compatible OS", () => {
    const result = evaluate({
      always: true,
      metadata: {
        requires: {
          bins: ["node"],
          anyBins: ["bun"],
          env: ["OPENAI_API_KEY"],
          config: ["browser.enabled"],
        },
        os: ["linux"],
      },
    });

    expect(result.missing).toEqual({ bins: [], anyBins: [], env: [], config: [], os: [] });
    expect(result.configChecks).toEqual([{ path: "browser.enabled", satisfied: false }]);
    expect(result.eligible).toBe(true);
  });

  it("preserves OS incompatibility when always is true", () => {
    const result = evaluate({
      always: true,
      metadata: {
        requires: { bins: ["node"], env: ["OPENAI_API_KEY"] },
        os: ["darwin"],
      },
    });

    expect(result.missing).toEqual({ bins: [], anyBins: [], env: [], config: [], os: ["darwin"] });
    expect(result.eligible).toBe(false);
  });
});
