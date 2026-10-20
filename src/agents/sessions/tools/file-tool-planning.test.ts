import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createAgentToolExecutionBudget } from "../../agent-tool-source-execution-guard.js";
import { isTrustedToolInputError } from "../../tool-input-error.js";
import { createEditTool } from "./edit.js";
import * as planning from "./file-tool-planning.js";
import { createWriteTool } from "./write.js";

afterEach(() => vi.restoreAllMocks());

function storage(initial = "target\ntarget\n") {
  let content = initial;
  const operations = {
    resolveQueueKey: (target: string) => target,
    access: async () => {},
    readFile: async () => Buffer.from(content),
    writeFile: vi.fn(async (_path: string, value: string) => {
      content = value;
    }),
    statFile: async () => ({ type: "file" as const, size: Buffer.byteLength(content), mtimeMs: 1 }),
  };
  return { operations, content: () => content };
}
const fileError = new Error("Synthetic storage unavailable");
it.each([
  ["absent", "Could not find the exact text", false],
  ["target", "Found 2 occurrences", false],
  ["", "oldText must not be empty", false],
  ["target", "Synthetic storage unavailable", true],
] as const)("classifies edit failure for %j (%s)", async (oldText, message, storageError) => {
  const content = storageError ? "target\n" : "target\ntarget\n";
  const { operations } = storage(content);
  const tool = createEditTool("/workspace", {
    operations: {
      ...operations,
      ...(storageError
        ? {
            access: async () => {
              throw fileError;
            },
            statFile: async () => null,
          }
        : {}),
    },
  });
  const error = await tool
    .execute("edit", {
      path: "example.txt",
      edits: [{ oldText, newText: "replacement" }],
    })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(isTrustedToolInputError(error)).toBe(!storageError);
  if (storageError) {
    expect(error).toHaveProperty("cause", fileError);
  } else {
    expect(error).toMatchObject({ message: expect.stringContaining(message) });
    if (oldText === "absent") {
      expect(error).toMatchObject({
        message: expect.stringContaining(content),
        cause: { message: expect.not.stringContaining(content) },
      });
    }
    expect(operations.writeFile).not.toHaveBeenCalled();
  }
});

it.each(
  (["edit", "write"] as const).flatMap((kind) =>
    (["active", "revoked", "aborted"] as const).map((authority) => ({ kind, authority })),
  ),
)(
  "rechecks $authority authority after $kind planning before mutation",
  async ({ kind, authority }) => {
    const prepared = createDeferredCore();
    const release = createDeferredCore();
    const delayResult = async <T>(pending: Promise<T>): Promise<T> => {
      const result = await pending;
      prepared.resolve();
      await release.promise;
      return result;
    };
    if (kind === "edit") {
      const plan = planning.planFileEdit;
      vi.spyOn(planning, "planFileEdit").mockImplementation((...args) =>
        delayResult(plan(...args)),
      );
    } else {
      const plan = planning.planFileWriteDiff;
      vi.spyOn(planning, "planFileWriteDiff").mockImplementation((...args) =>
        delayResult(plan(...args)),
      );
    }

    const fixture = storage("before\n");
    const content = fixture.content;
    const operations = { ...fixture.operations, mkdir: vi.fn(async () => {}) };
    const { mkdir, writeFile } = operations;
    const controller = new AbortController();
    let current = true;
    const budget = createAgentToolExecutionBudget({
      signal: controller.signal,
      abort: (error) => controller.abort(error),
      isCurrent: () => current,
    });
    const pending = budget.run(() =>
      kind === "edit"
        ? createEditTool("/workspace", { operations }).execute(
            "planning",
            { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] },
            controller.signal,
          )
        : createWriteTool("/workspace", { operations }).execute(
            "planning",
            { path: "example.txt", content: "after\n" },
            controller.signal,
          ),
    );
    void pending.catch(prepared.reject);
    try {
      await prepared.promise;
      expect(mkdir).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(content()).toBe("before\n");
      if (authority === "revoked") {
        current = false;
      } else if (authority === "aborted") {
        controller.abort(new Error("Planning cancelled"));
      }
      release.resolve();
      if (authority === "active") {
        await expect(pending).resolves.toMatchObject({ details: { changed: true } });
        expect(writeFile).toHaveBeenCalledOnce();
        expect(content()).toBe("after\n");
      } else {
        const abortedMessage = kind === "write" ? "Operation aborted" : "Planning cancelled";
        await expect(pending).rejects.toThrow(
          authority === "aborted" ? abortedMessage : "execution scope is no longer active",
        );
        expect(mkdir).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(content()).toBe("before\n");
      }
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  },
);
