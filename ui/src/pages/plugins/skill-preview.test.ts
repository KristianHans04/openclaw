/* @vitest-environment jsdom */
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { PluginsSkillsReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { createPluginPreview } from "./skill-preview.tsx";

afterEach(() => vi.restoreAllMocks());

async function setup(open = false) {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request");
  const gateway = createGatewayConnectionLifecycle({ client, phase: "connected" });
  onTestFinished(gateway.dispose);
  const preview = createRoot((dispose) => {
    onTestFinished(dispose);
    return createPluginPreview(gateway, () => {});
  });
  if (open) {
    request.mockResolvedValueOnce(lazyResult);
    await preview.open(params);
  }
  return {
    preview,
    request,
    reconnect: () => {
      gateway.transition({ client, phase: "reconnecting" });
      gateway.transition({ client, phase: "connected" });
    },
  };
}

const params = { source: "installed", pluginId: "example", skillName: "guide" } as const;
const lazyResult: PluginsSkillsReadResult = {
  name: "guide",
  rootPath: "skills/guide",
  entryPath: "SKILL.md",
  directories: [],
  inventoryComplete: true,
  version: "1.0.0",
  files: [
    { path: "SKILL.md", sizeBytes: 5, status: "ready", content: "entry" },
    { path: "a.md", sizeBytes: 1, status: "deferred" },
    { path: "b.md", sizeBytes: 1, status: "deferred" },
  ],
};
const result = { ...lazyResult, version: undefined };
const selectedResult = (path: string): PluginsSkillsReadResult => ({
  ...lazyResult,
  files: [{ path, sizeBytes: 1, status: "ready", content: path }],
});
const selectedParams = (path: string) => ({ ...params, version: "1.0.0", path });

it("fetches only selected bodies, deduplicates pending reads and retains late sibling bodies without changing selection", async () => {
  const { preview, request } = await setup(true);
  const a = createDeferred<PluginsSkillsReadResult>();
  const b = createDeferred<PluginsSkillsReadResult>();
  request.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  expect(request).toHaveBeenCalledTimes(1);
  const pendingA = preview.select("a.md");
  await preview.select("a.md");
  const pendingB = preview.select("b.md");
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith("plugins.skills.read", selectedParams("b.md"));
  b.resolve(selectedResult("b.md"));
  await pendingB;
  a.resolve(selectedResult("a.md"));
  await pendingA;
  expect(preview.state?.activePath).toBe("b.md");
  const bodies = preview.state?.result?.files.map((file) => file.content);
  expect(bodies).toEqual(["entry", "a.md", "b.md"]);
  await preview.select("SKILL.md");
  await preview.select("a.md");
  expect(request).toHaveBeenCalledTimes(3);
});

it("keeps selected-file failures retryable without refetching the entry or losing the inventory", async () => {
  const { preview, request } = await setup(true);
  request
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValueOnce(selectedResult("a.md"));
  await preview.select("a.md");
  expect(preview.state?.fileErrors.get("a.md")).toBe("Read failed");
  expect(preview.state?.result?.files[0]?.content).toBe("entry");
  await preview.select("a.md");
  expect(preview.state?.fileErrors.size).toBe(0);
  expect(preview.state?.pendingPaths.size).toBe(0);
  expect(request).toHaveBeenLastCalledWith("plugins.skills.read", selectedParams("a.md"));
});

it.each<[boolean, string]>([
  [false, "selection"],
  [false, "reconnect"],
  [true, "reopen"],
  [true, "reconnect"],
])(
  "retires late preview responses (selected file: %s, change: %s)",
  async (selectedFile, change) => {
    const { preview, request, reconnect } = await setup(selectedFile);
    const response = createDeferred<PluginsSkillsReadResult>();
    const next = selectedFile ? { ...lazyResult, version: "2.0.0" } : { ...result, name: "other" };
    request.mockReturnValueOnce(response.promise).mockResolvedValueOnce(next);
    const pending = selectedFile ? preview.select("a.md") : preview.open(params);
    if (change === "reconnect") {
      reconnect();
    } else {
      await preview.open(change === "reopen" ? params : { ...params, skillName: "other" });
    }
    response.resolve(selectedFile ? selectedResult("a.md") : result);
    await pending;
    if (selectedFile) {
      const selected = preview.state?.result?.files.find((file) => file.path === "a.md");
      expect(selected?.content).toBeUndefined();
    } else {
      expect(preview.state?.result?.name).not.toBe("guide");
    }
  },
);
