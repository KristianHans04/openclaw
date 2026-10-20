/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import type { PluginsInspectResult } from "../../lib/plugins/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(resetPluginsPageTestState);

const inspectionWithAuth = (state: "requires-authorization" | "authorized" | "unauthenticated") =>
  createInspectResult({ mcpAuth: [{ serverName: "workboard-mcp", state }] });
const connectButton = (page: ParentNode) =>
  page.querySelector<HTMLButtonElement>('[aria-label="Connect workboard-mcp"]');
const calls = (request: ReturnType<typeof createClient>["request"], method: string) =>
  request.mock.calls.filter(([name]) => name === method);

async function setup(handlers: Record<string, () => unknown>, advertiseMcpLogin = true) {
  const { client, request } = createClient(async (method) => {
    if (!Object.hasOwn(handlers, method)) {
      throw new Error(`Unexpected method ${method}`);
    }
    return handlers[method]!();
  });
  const harness = createGateway(client);
  if (advertiseMcpLogin) {
    harness.emit(client, true, {
      hello: gatewayHelloForMethods([
        ...(harness.gateway.snapshot.hello?.features?.methods ?? []),
        "mcp.authLogin",
      ]),
    });
  }
  const result = createResult(createPlugin({ enabled: true, state: "enabled" }));
  const route = createPluginsRouteData(
    harness.gateway,
    result,
    createPluginsRouteLocation("/settings/plugins/workboard"),
  );
  const context = createContext(harness.gateway);
  const mounted = await mountPage(context, route, "settings");
  await waitForSolid(() =>
    expect(mounted.page.querySelector(".plugin-capabilities")).not.toBeNull(),
  );
  await mounted.page.updateComplete;
  return { ...mounted, ...harness, client, request, route, context };
}

it("shows configured credentials and opens existing Settings", async () => {
  const inspection = createInspectResult({
    credentials: [
      {
        path: ["plugins", "entries", "workboard", "config", "apiKey"],
        label: "Workboard API key",
        envVars: ["WORKBOARD_API_KEY"],
        status: "configured",
      },
    ],
    overview: {
      capabilities: {
        providers: [],
        channels: [],
        contracts: { webSearchProviders: ["workboard"] },
      },
    },
  });
  const { page, context } = await setup({ "plugins.inspect": () => inspection });
  const sections = [...page.querySelectorAll(".plugin-capabilities")];
  expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
    "Credentials1",
    "Capabilities1",
  ]);
  expect(sections[0]?.textContent).toContain("WORKBOARD_API_KEY");
  expect(sections[0]?.querySelector('[role="status"]')?.textContent?.trim() ?? null).toBe(
    "Configured",
  );
  expect(sections[0]?.querySelector("button")?.textContent?.trim()).toBe("Edit");
  sections[0]?.querySelector<HTMLButtonElement>("button")?.click();
  expect(context.navigate).toHaveBeenCalledWith(
    "plugin-settings",
    expect.objectContaining({ search: "?view=settings" }),
  );
});

it("starts the server's existing OAuth flow and waits for authoritative status after completion", async () => {
  const refreshed = createDeferred<PluginsInspectResult>();
  let completed = false;
  const { page, context, request } = await setup({
    "plugins.inspect": () =>
      completed ? refreshed.promise : inspectionWithAuth("requires-authorization"),
    "mcp.authLogin": () => {
      completed = true;
      return { done: true, status: "done" };
    },
  });
  connectButton(page)!.click();
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith(
      "mcp.authLogin",
      { serverName: "workboard-mcp", sessionId: expect.any(String) },
      { timeoutMs: null },
    ),
  );
  await waitForSolid(() => expect(calls(request, "plugins.inspect")).toHaveLength(2));
  expect(connectButton(page)).not.toBeNull();
  refreshed.resolve(inspectionWithAuth("authorized"));
  await waitForSolid(() => expect(connectButton(page)).toBeNull());
  expect(page.querySelector(".plugin-capabilities")?.textContent).toContain("Connected");
  page.querySelector<HTMLButtonElement>('[aria-label="Edit workboard-mcp connection"]')!.click();
  expect(context.navigate).toHaveBeenCalledWith("mcp");
});

it("disables Connect and refuses sign-in when the gateway does not advertise MCP OAuth", async () => {
  const { page, request } = await setup(
    {
      "mcp.authLogin": () => ({ done: true, status: "done" }),
      "plugins.inspect": () => inspectionWithAuth("requires-authorization"),
    },
    false,
  );
  const button = connectButton(page)!;
  expect.soft(button.disabled).toBe(true);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await page.updateComplete;
  expect(calls(request, "mcp.authLogin")).toHaveLength(0);
  expect(window.open).not.toHaveBeenCalled();
});

it.each(["navigation", "reconnect"])(
  "cancels pending sign-in on %s without opening a late authorization URL",
  async (change) => {
    const admission = createDeferred<unknown>();
    const { page, request, route, emit, client } = await setup({
      "plugins.inspect": () => inspectionWithAuth("unauthenticated"),
      "mcp.authLogin": () => admission.promise,
      "wizard.cancel": () => ({ status: "cancelled" }),
      "plugins.list": () => createResult(createPlugin({ enabled: true, state: "enabled" })),
    });
    connectButton(page)!.click();
    const start = request.mock.calls.find(([method]) => method === "mcp.authLogin")!;
    if (change === "navigation") {
      page.routeData = { ...route, location: createPluginsRouteLocation("/settings/plugins") };
      await page.updateComplete;
    } else {
      emit(client, false);
      emit(client, true);
    }
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.cancel",
        { sessionId: (start[1] as { sessionId: string }).sessionId, closeInput: true },
        expect.anything(),
      ),
    );
    admission.resolve({ done: false, status: "running" });
    await waitForSolid(() => expect(calls(request, "wizard.cancel")).toHaveLength(2));
    expect(calls(request, "wizard.next")).toHaveLength(0);
    expect(window.open).toHaveBeenCalledTimes(1);
  },
);
