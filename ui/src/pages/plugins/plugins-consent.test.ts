/* @vitest-environment jsdom */

import { createRoot, onCleanup } from "solid-js";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventListener,
} from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { PluginRowMessage } from "./plugin-row-message.tsx";
import { createPluginsConsent } from "./plugins-consent.ts";
import {
  createClient,
  createContext,
  createGateway,
  createPlugin,
  createResult,
} from "./plugins-page.test-support.ts";

beforeEach(() => i18n.setLocale("en"));

function createConsentHarness(
  client: GatewayBrowserClient,
  refreshConfig: ReturnType<typeof createContext>["runtimeConfig"]["refresh"] = async () =>
    undefined,
) {
  const { gateway: applicationGateway } = createGateway(client);
  const gateway = new GatewayPageBinding(vi.fn(), {
    getGateway: () => applicationGateway,
  });
  gateway.connect();
  let result = createResult(available);
  let messages: Record<string, PluginRowMessage> = {};
  const busy = new Set<string>();
  const context = createContext(applicationGateway, refreshConfig);
  const applyMutationResult = vi.fn();
  const refreshCatalog = async (): Promise<void> => {
    let next: PluginListResult;
    try {
      next = await client.request<PluginListResult>("plugins.list", {});
    } catch {
      return;
    }
    messages = consent.reconcileInstallMessages(next);
    result = next;
  };
  const consent: ReturnType<typeof createPluginsConsent> = createRoot((dispose) => {
    onTestFinished(dispose);
    onCleanup(() => gateway.dispose());
    return createPluginsConsent({
      gateway,
      getContext: () => context,
      getResult: () => result,
      canMutate: () => true,
      isBusy: (key) => busy.has(key),
      setBusy: (key, action) => {
        if (action) {
          busy.add(key);
        } else {
          busy.delete(key);
        }
      },
      setMessage: (key, message) => {
        if (message) {
          messages[key] = message;
        } else {
          delete messages[key];
        }
      },
      getMessages: () => messages,
      clearPageNotice: () => {},
      closeDetails: () => {},
      applyMutationResult,
      refreshCatalogAfterMutation: refreshCatalog,
      onChange: () => {},
    });
  });
  return {
    consent,
    get progress() {
      return consent.read().installProgress;
    },
    get messages() {
      return messages;
    },
    refreshCatalog,
    applyMutationResult,
  };
}

const available = createPlugin({
  id: "calendar-runtime",
  packageName: "community-calendar",
  installed: false,
  state: "not-installed",
});
const installed = { ...available, installed: true, enabled: true, state: "error" as const };
const installRequest: PluginInstallRequest = {
  source: "clawhub",
  packageName: "community-calendar",
};
const rowKey = "plugin:calendar-runtime";
const activity = (requestId: string, status = "started") => ({
  requestId,
  activityId: "activity",
  stage: "dependencies",
  status,
});

it("correlates concurrent install progress and retires listeners on success and failure", async () => {
  const listeners = new Set<GatewayEventListener>();
  const firstResponse = deferred<PluginMutationResult>();
  const secondResponse = deferred<PluginMutationResult>();
  let nextRequest = 0;
  const request = createGatewayRequestMock(async (method, _params, options) => {
    if (method === "plugins.install") {
      const index = nextRequest++;
      options?.onSent?.(`request-${index}`);
      return index === 0 ? firstResponse.promise : secondResponse.promise;
    }
    if (method === "plugins.list") {
      return createResult(available);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  client.addEventListener = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const fixture = createConsentHarness(client);
  const firstIdentity = "npm:one";
  const secondIdentity = "npm:two";
  const one = fixture.consent.install({ source: "npm", spec: "one" }, firstIdentity);
  const two = fixture.consent.install({ source: "npm", spec: "two" }, secondIdentity);
  const emit = (requestId: string, status = "started") => {
    for (const listener of listeners) {
      listener({
        type: "event",
        event: "plugins.install.progress",
        payload: activity(requestId, status),
      });
    }
  };
  emit("request-1");
  expect(fixture.progress.get(firstIdentity)?.activities).toEqual([]);
  expect(fixture.progress.get(secondIdentity)?.activities).toEqual([activity("request-1")]);
  emit("request-0");
  emit("request-0", "invented");
  expect(fixture.progress.get(firstIdentity)?.activities).toEqual([activity("request-0")]);
  const result: PluginMutationResult = {
    ok: true,
    plugin: createPlugin({ id: "one" }),
    restartRequired: false,
  };
  firstResponse.resolve(result);
  await one;
  expect(fixture.applyMutationResult).toHaveBeenCalledWith(result);
  emit("request-0", "completed");
  expect(fixture.progress.has(firstIdentity)).toBe(false);
  expect(listeners.size).toBe(1);
  secondResponse.reject(new Error("registry unavailable"));
  await two;
  expect(fixture.messages[secondIdentity]?.text).toContain("registry unavailable");
  expect(listeners.size).toBe(0);
});

it("blocks repeat install when saved-state reads fail, then reconciles aliases and later removal", async () => {
  let inventoryFails = true;
  let present = true;
  const otherInstall = deferred<never>();
  const otherRequest: PluginInstallRequest = { source: "npm", spec: "another-plugin" };
  const { client, request: gatewayRequest } = createClient(async (method, params) => {
    if (method === "plugins.install") {
      if (params === otherRequest) {
        return otherInstall.promise;
      }
      throw new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Plugin startup failed",
        details: {
          persistence: { operation: "install", pluginId: available.id },
          runtime: { phase: "activate", committed: false },
          installPolicyCode: "install_policy_warning_acknowledgement_required",
          targetName: "community-calendar",
          targetType: "plugin",
          requestMode: "install",
          reason: "Do not retry a saved installation",
        },
      });
    }
    if (method === "plugins.list") {
      if (inventoryFails) {
        throw new Error("Catalog refresh unavailable");
      }
      return createResult(present ? installed : available);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const fixture = createConsentHarness(
    client,
    vi.fn(async () => {
      throw new Error("Config refresh unavailable");
    }),
  );
  const { consent } = fixture;
  const installCalls = () =>
    gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install");
  const alias = "clawhub:community-calendar";
  await consent.install(installRequest, alias);
  expect(fixture.messages[rowKey]?.text).toContain("Plugin startup failed");
  expect(fixture.messages[rowKey]?.text).toContain("Config refresh unavailable");
  expect(fixture.messages[alias]?.savedInstall).toBe(available.id);
  expect(fixture.messages[alias]?.installPolicyWarning).toBeUndefined();
  await consent.install(installRequest, alias);
  await consent.install(installRequest, rowKey);
  expect(installCalls()).toHaveLength(1);
  const otherIdentity = "npm:another-plugin";
  const installingOther = consent.install(otherRequest, otherIdentity);
  await waitForSolid(() => expect(fixture.progress.has(otherIdentity)).toBe(true));
  expect(fixture.progress.get(alias)).toMatchObject({
    finishedAt: expect.any(Number),
    canRetry: false,
  });
  inventoryFails = false;
  await fixture.refreshCatalog();
  flush();
  expect(fixture.progress.has(alias)).toBe(false);
  expect(fixture.progress.has(otherIdentity)).toBe(true);
  expect(fixture.progress.get(otherIdentity)?.finishedAt).toBeUndefined();
  expect(fixture.messages[alias]).toBeUndefined();
  expect(fixture.messages[rowKey]?.text).toContain("Plugin startup failed");
  present = false;
  await fixture.refreshCatalog();
  flush();
  expect(fixture.messages[rowKey]).toBeUndefined();
  await consent.install(installRequest, alias);
  expect(installCalls()).toHaveLength(3);
  otherInstall.reject(new Error("Another registry is unavailable"));
  await installingOther;
  flush();
  expect(fixture.messages[otherIdentity]?.text).toContain("Another registry is unavailable");
  expect(fixture.messages[otherIdentity]?.text).toContain("Reconnect and check installed plugins");
  expect(fixture.progress.get(otherIdentity)).toMatchObject({
    failure: { title: "Installation status unknown" },
    canRetry: false,
    finishedAt: expect.any(Number),
  });
});
