import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createAgentHarnessToolExecutionBoundaryRegistry } from "../../harness/tool-execution.js";
import { runAgentHarnessToolInvocation } from "../../harness/tool-invocation.js";
import { createEditTool } from "./edit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const original = "alpha\nbefore\nomega\n";
const pair = { oldText: "before", newText: "after" };

async function createFixture() {
  const cwd = tempDirs.make("openclaw-edit-legacy-");
  const filePath = path.join(cwd, "example.txt");
  await fs.writeFile(filePath, original);
  const tool = createEditTool(cwd);
  return {
    tool,
    filePath,
    apply: (input: object) => tool.execute("edit", prepare(tool, { path: filePath, ...input })),
    expectFile: (text = original) => expect(fs.readFile(filePath, "utf8")).resolves.toBe(text),
  };
}

function prepare(tool: ReturnType<typeof createEditTool>, input: unknown) {
  const prepared = tool.prepareArguments?.(input);
  if (!Value.Check(tool.parameters, prepared)) {
    throw new Error("Prepared replacements did not satisfy the edit schema");
  }
  return prepared;
}

describe("legacy edit input", () => {
  it.each([
    { edits: "[{bad json" },
    { edits: '[{"oldText":"before","newText":"after"}' },
    { edits: "[{bad json", oldText: "before" },
    { edits: "[{bad json", oldText: 42, newText: "after" },
  ])("reports unparseable edits before execution: %j", async (args) => {
    const { tool, filePath, expectFile } = await createFixture();
    const execute = vi.spyOn(tool, "execute");
    const invocation = runAgentHarnessToolInvocation({
      tool,
      call: {
        toolCallId: "malformed-edits",
        toolName: "edit",
        arguments: { path: filePath, ...args },
      },
      signal: new AbortController().signal,
      boundaries: createAgentHarnessToolExecutionBoundaryRegistry(),
      applyMiddleware: async (event) => event.result,
      onResult: ({ result }) => result,
      onError: ({ error }) => {
        throw error;
      },
    });

    await expect(invocation).rejects.toThrow(
      "Could not parse edits as JSON. Provide a complete JSON array of replacements.",
    );
    expect(execute).not.toHaveBeenCalled();
    await expectFile();
  });

  it.each(["after", ""])(
    "falls back from malformed edits to legacy newText %j",
    async (newText) => {
      const { apply, expectFile } = await createFixture();
      await apply({ edits: "[{bad json", ...pair, newText });
      await expectFile(`alpha\n${newText}\nomega\n`);
    },
  );

  it.each(["array", "serialized", "distinct"] as const)(
    "applies the batch and legacy pair once with %s edits",
    async (shape) => {
      const { apply, expectFile } = await createFixture();
      const edits = [
        { oldText: "alpha", newText: "ALPHA" },
        ...(shape === "distinct" ? [] : [{ ...pair, reason: "extra model metadata" }]),
      ];
      await apply({
        edits: shape === "serialized" ? JSON.stringify(edits) : edits,
        ...pair,
      });
      await expectFile("ALPHA\nafter\nomega\n");
    },
  );

  it.each(["conflicting legacy pair", "duplicate batch entries"] as const)(
    "continues rejecting %s without writing",
    async (scenario) => {
      const { apply, expectFile } = await createFixture();
      await expect(
        apply({
          edits: scenario === "duplicate batch entries" ? [pair, pair] : [pair],
          ...pair,
          newText: scenario === "conflicting legacy pair" ? "different" : "after",
        }),
      ).rejects.toThrow(/overlap/);
      await expectFile();
    },
  );

  it("rejects malformed entries despite a valid legacy pair", async () => {
    const { tool, filePath } = await createFixture();
    const prepared = tool.prepareArguments?.({
      path: filePath,
      edits: [{ oldText: "before" }],
      ...pair,
    });
    expect(Value.Check(tool.parameters, prepared)).toBe(false);
  });
});
