/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createComponent, createSignal, flush } from "solid-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import { ShellLayoutOwner } from "../../../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../../../app/shell-layout-traits-solid.tsx";
import { showConfirmDialog } from "../../../components/confirm-dialog.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createAgentMemory,
  type AgentMemoryState,
  type AgentMemoryTarget,
} from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";
import { AgentMemoryPanel } from "./memory-panel.tsx";
import { installDreamingViewTestTranslations } from "./view.test-helpers.ts";

vi.mock("../../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
let restoreTranslations = () => {};
beforeAll(() => {
  restoreTranslations = installDreamingViewTestTranslations();
});
afterAll(() => restoreTranslations());
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

function contextWithRequest(request: Parameters<typeof createTestGatewayClient>[0]) {
  let snapshot: ApplicationGatewaySnapshot = {
    client: createTestGatewayClient(request),
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(["config.patch"]),
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gatewayListeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const configListeners = new Set<() => void>();
  const context = {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: (listener: (value: ApplicationGatewaySnapshot) => void) => {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
    },
    agents: { state: { agentsList: null }, subscribe: () => () => {} },
    runtimeConfig: {
      state: { configForm: null, configSnapshot: null },
      ensureLoaded: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      removeFormValue: vi.fn(),
      waitForPendingWrites: vi.fn(async () => undefined),
      save: vi.fn(async () => true),
      patch: vi.fn(async () => true),
      subscribe: (listener: () => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      },
    },
  } as unknown as ApplicationContext;
  return Object.assign(context, {
    emit(patch: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of gatewayListeners) {
        listener(snapshot);
      }
    },
    setConfig(config: Record<string, unknown>) {
      context.runtimeConfig.state.configForm = config;
      context.runtimeConfig.state.configSnapshot = { config };
      for (const listener of configListeners) {
        listener();
      }
    },
  });
}

function requestFor(
  replies: Record<string, () => unknown>,
  fallback: (method: string) => unknown = emptyReply,
) {
  return vi.fn((method: string) => replies[method]?.() ?? fallback(method));
}

function diary(content: string) {
  return { found: true, path: "DREAMS.md", content };
}

function emptyClient() {
  return createTestGatewayClient(vi.fn(emptyReply));
}

function emptyReply(method: string) {
  return method === "doctor.memory.status"
    ? { dreaming: null }
    : { found: false, path: "DREAMS.md" };
}
function createAgentTarget(initialAgentId: string | null) {
  let agentId = initialAgentId;
  const listeners = new Set<() => void>();
  return {
    read: () => agentId,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    set: (next: string | null) => {
      agentId = next;
      for (const notify of listeners) {
        notify();
      }
    },
    subscriberCount: () => listeners.size,
  } satisfies AgentMemoryTarget & {
    set(next: string | null): void;
    subscriberCount(): number;
  };
}

async function createPage(context: ApplicationContext, agentId = "main") {
  const container = document.createElement("div");
  document.body.append(container);
  const agentTarget = createAgentTarget(agentId);
  let state: AgentMemoryState;
  const mounted = mountSolid(
    () => {
      state = createAgentMemory(context, () => agentTarget);
      return AgentMemoryView({ state });
    },
    { container },
  );
  await waitForSolid(() => expect(state.view().header.refreshLoading).toBe(false));
  return {
    get state() {
      return state;
    },
    get dreaming() {
      return state.view().dreaming;
    },
    get toggle() {
      return state.view().toggle;
    },
    query: <T extends Element = HTMLElement>(selector: string) =>
      container.querySelector<T>(selector),
    text: (selector: string) => container.querySelector(selector)?.textContent,
    waitText: (selector: string, text: string) =>
      waitForSolid(() => expect(container.querySelector(selector)?.textContent).toBe(text)),
    container,
    setAgentId: agentTarget.set,
    unmount: mounted.unmount,
  };
}

function click(container: HTMLElement, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
  flush();
}

const wikiPage = {
  pagePath: "syntheses/example.md",
  title: "Original title",
  kind: "synthesis" as const,
  claimCount: 1,
  questionCount: 0,
  contradictionCount: 0,
  claims: ["A supported claim"],
  questions: [],
  contradictions: [],
};
function wikiOverview(title = wikiPage.title) {
  return {
    totalItems: 1,
    totalPages: 1,
    truncated: false,
    pageCounts: { synthesis: 1, entity: 0, concept: 0, source: 0, report: 0 },
    totalClaims: 1,
    totalQuestions: 0,
    totalContradictions: 0,
    clusters: [
      {
        key: "synthesis",
        label: "Syntheses",
        itemCount: 1,
        claimCount: 1,
        questionCount: 0,
        contradictionCount: 0,
        items: [{ ...wikiPage, title }],
      },
    ],
  };
}

describe("AgentMemoryPanel gateway lifecycle", () => {
  it("scopes native memory requests to the current agent and releases shell layout", async () => {
    const request = vi.fn(emptyReply);
    const context = contextWithRequest(request);
    const unsubscribe = vi.fn();
    context.gateway.subscribe = () => unsubscribe;
    const content = document.createElement("main");
    content.className = "content";
    document.body.append(content);
    const owner = new ShellLayoutOwner();
    owner.contentRef(content);
    const provider = createSolidApplicationContextProvider(context);
    const originalTarget = createAgentTarget("support");
    const replacementTarget = createAgentTarget("ignored");
    const [agentTarget, setAgentTarget] = createSignal<AgentMemoryTarget>(originalTarget);
    const view = mountSolid(
      () =>
        createComponent(ShellLayoutProvider, {
          value: { owner, host: content },
          get children() {
            return createComponent(AgentMemoryPanel, {
              get initialAgentTarget() {
                return agentTarget();
              },
            });
          },
        }),
      { container: content, wrapper: provider.wrapper },
    );
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "support" }),
    );
    const host = content.querySelector<HTMLElement>("openclaw-agent-memory-panel")!;
    expect(host.querySelector(".agent-memory-panel__header")).not.toBeNull();
    expect(owner.current.toolbarHeader).toBe(true);

    click(host, "#dreams-tab-diary");
    expect(originalTarget.subscriberCount()).toBe(1);
    setAgentTarget(replacementTarget);
    flush();
    expect(replacementTarget.subscriberCount()).toBe(0);
    originalTarget.set(" support ");
    expect(request).toHaveBeenCalledTimes(2);

    originalTarget.set("main");
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "main" }),
    );
    expect(content.querySelector("openclaw-agent-memory-panel")).toBe(host);
    expect(host.querySelector("#dreams-tab-diary")?.getAttribute("aria-selected")).toBe("true");
    view.unmount();
    expect(originalTarget.subscriberCount()).toBe(0);
    expect(owner.current.toolbarHeader).toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("acquires the initial target at settlement before starting scoped requests", async () => {
    const request = vi.fn(emptyReply);
    const context = contextWithRequest(request);
    const target = createAgentTarget("main");
    const getInitialTarget = vi.fn(() => target);
    mountSolid(() => {
      const state = createAgentMemory(context, getInitialTarget);
      expect(getInitialTarget).not.toHaveBeenCalled();
      target.set("support");
      return AgentMemoryView({ state });
    });
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    expect(getInitialTarget).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "support" });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "support" });
  });

  it("waits for a committed agent before loading agent-scoped memory", async () => {
    const request = vi.fn(emptyReply);
    const page = await createPage(contextWithRequest(request), "");
    await page.dreaming.onOpenWikiPage("unowned.md");
    expect(request).not.toHaveBeenCalled();
    page.setAgentId("support");
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "support" });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "support" });
  });

  it.each([false, true])(
    "keeps confirmed dreaming actions scoped to their agent (changed: %s)",
    async (changed) => {
      const confirmation = deferred<boolean>();
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
      const method = "doctor.memory.repairDreamingArtifacts";
      const request = vi.fn(emptyReply);
      const context = contextWithRequest(request);
      context.emit({ hello: gatewayHelloForMethods([method], ["operator.write"]) });
      const page = await createPage(context);
      page.dreaming.onRepairDreamingArtifacts();
      expect(showConfirmDialog).toHaveBeenCalledOnce();
      if (changed) {
        page.setAgentId("support");
      }
      confirmation.resolve(true);
      await waitForSolid(() => expect(page.dreaming.dreamDiaryActionLoading).toBe(false));
      if (changed) {
        expect(request.mock.calls.some(([name]) => name === method)).toBe(false);
      } else {
        await waitForSolid(() => expect(request).toHaveBeenCalledWith(method, { agentId: "main" }));
      }
    },
  );

  it.each(["", "main"])(
    "resets stale panel data after switching through support to %s",
    async (agentId) => {
      const reply = deferred<unknown>();
      const request = vi.fn((method: string, params?: unknown) =>
        method === "doctor.memory.dreamDiary"
          ? asOptionalRecord(params)?.agentId === "main"
            ? Promise.resolve(diary("main-only"))
            : reply.promise
          : Promise.resolve(emptyReply(method)),
      );
      const page = await createPage(contextWithRequest(request));
      await waitForSolid(() => expect(page.dreaming.dreamDiaryContent).toBe("main-only"));
      page.setAgentId("support");
      expect(page.dreaming.selectedAgentId).toBe("support");
      expect(page.dreaming.dreamDiaryContent).toBeNull();
      await waitForSolid(() =>
        expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "support" }),
      );
      page.setAgentId(agentId);
      await waitForSolid(() => expect(page.dreaming.selectedAgentId).toBe(agentId));
      if (agentId) {
        await waitForSolid(() => expect(page.dreaming.dreamDiaryContent).toBe("main-only"));
      }
      reply.resolve(diary("support-only"));
      await reply.promise;
      flush();
      expect(page.dreaming.dreamDiaryContent).toBe(agentId ? "main-only" : null);
    },
  );

  it.each([false, true])(
    "preserves the outcome of an interrupted memory action (confirmed: %s)",
    async (confirmed) => {
      const action = deferred<unknown>();
      const refresh = deferred<unknown>();
      let statusReads = 0;
      const method = "doctor.memory.repairDreamingArtifacts";
      const request = vi.fn((name: string) => {
        if (name === method) {
          return action.promise;
        }
        if (name === "doctor.memory.status" && ++statusReads === 2) {
          return refresh.promise;
        }
        return Promise.resolve(emptyReply(name));
      });
      const context = contextWithRequest(request);
      const hello = gatewayHelloForMethods([method], ["operator.read", "operator.write"]);
      context.emit({ hello });
      const page = await createPage(context);
      click(page.container, "#dreams-tab-advanced");
      vi.mocked(showConfirmDialog).mockResolvedValueOnce(true);
      page.dreaming.onRepairDreamingArtifacts();
      await waitForSolid(() => expect(request).toHaveBeenCalledWith(method, { agentId: "main" }));
      const result = { archivedDreamsDiary: true, archiveDir: "/tmp/dreaming-repair" };
      if (confirmed) {
        action.resolve(result);
        await waitForSolid(() => expect(statusReads).toBe(2));
      }

      context.emit({ phase: "reconnecting", hello: null });
      flush();
      const message = confirmed
        ? "Dream cache repair complete"
        : "Connection lost before the memory action was confirmed. It may have completed.";
      expect(page.text("[role='status']")).toContain(message);
      expect(page.dreaming.dreamDiaryActionLoading).toBe(false);
      expect(page.dreaming.access.canRepairDreamingArtifacts).toBe(false);

      context.emit({ phase: "connected", hello });
      action.resolve(result);
      refresh.resolve(emptyReply("doctor.memory.status"));
      await waitForSolid(() => expect(statusReads).toBe(confirmed ? 3 : 2));
      await waitForSolid(() => expect(page.state.view().header.refreshLoading).toBe(false));
      expect(page.text("[role='status']")).toContain(message);
      expect(request.mock.calls.filter(([name]) => name === method)).toHaveLength(1);
      expect(page.dreaming.dreamDiaryActionArchivePath).toBe(
        confirmed ? "/tmp/dreaming-repair" : null,
      );

      context.emit({ client: emptyClient() });
      flush();
      expect(page.dreaming.dreamDiaryActionMessage).toBeNull();
      expect(page.dreaming.dreamDiaryActionArchivePath).toBeNull();
    },
  );

  it("retains diary, preview and toggle drafts through reconnect while rejecting old reads", async () => {
    const stale = deferred<unknown>();
    let refresh = false;
    const fresh = deferred<unknown>();
    const freshPreview = deferred<unknown>();
    const request = requestFor({
      "doctor.memory.dreamDiary": () => (refresh ? fresh.promise : diary("Retained diary")),
      "wiki.get": () => (refresh ? freshPreview.promise : stale.promise),
    });
    const context = contextWithRequest(request);
    const hello = context.gateway.snapshot.hello;
    const page = await createPage(context);
    await waitForSolid(() => expect(page.dreaming.dreamDiaryContent).toBe("Retained diary"));
    click(page.container, "#dreams-tab-diary");
    const preview = page.dreaming.onOpenWikiPage("retained.md");
    page.state.setEnabled(false);
    flush();
    const previewDialog = page.query(".dreams-diary__preview-panel");
    expect(previewDialog).not.toBeNull();
    context.emit({ phase: "reconnecting", hello: null });
    flush();
    expect(page.dreaming.dreamDiaryContent).toBe("Retained diary");
    expect(page.dreaming.wikiPreview?.page.path).toBe("retained.md");
    expect(page.dreaming.wikiPreview?.loading).toBe(true);
    expect(page.toggle).toMatchObject({ open: true, disabled: true });
    expect(page.query<HTMLButtonElement>(".exec-approval-actions button")?.disabled).toBe(true);
    refresh = true;
    context.emit({ phase: "connected", hello });
    await waitForSolid(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "doctor.memory.dreamDiary"),
      ).toHaveLength(2),
    );
    expect(page.dreaming.dreamDiaryContent).toBe("Retained diary");
    expect(request.mock.calls.filter(([method]) => method === "wiki.get")).toHaveLength(2);
    stale.resolve({ title: "Old", path: "retained.md", content: "Stale preview" });
    await preview;
    expect(page.dreaming.wikiPreview?.page.content).toBe("");
    expect(page.dreaming.wikiPreview?.loading).toBe(true);
    expect(page.toggle.open).toBe(true);
    freshPreview.resolve({ title: "Fresh", path: "retained.md", content: "Fresh preview" });
    await page.waitText(".dreams-diary__preview-pre", "Fresh preview");
    expect(page.query(".dreams-diary__preview-panel")).toBe(previewDialog);
    fresh.resolve(diary("Fresh diary"));
    await waitForSolid(() => expect(page.dreaming.dreamDiaryContent).toBe("Fresh diary"));

    context.emit({ client: emptyClient() });
    flush();
    expect(page.dreaming.dreamDiaryContent).toBeNull();
    expect(page.dreaming.wikiPreview).toBeNull();
    expect(page.toggle.open).toBe(false);
  });

  it.each(["agent", "client", "access", "unmount"] as const)(
    "retires pending wiki requests and modal state on %s replacement",
    async (replacement) => {
      const pending = deferred<unknown>();
      const request = requestFor({ "wiki.get": () => pending.promise });
      const context = contextWithRequest(request);
      const page = await createPage(context, "support");
      click(page.container, "#dreams-tab-diary");
      const preview = page.dreaming.onOpenWikiPage("support.md");
      page.state.setEnabled(false);
      await waitForSolid(() => expect(page.query(".dreams-diary__preview-panel")).not.toBeNull());
      expect(page.toggle.open).toBe(true);
      if (replacement === "agent") {
        page.setAgentId("marketing");
      } else if (replacement === "client") {
        context.emit({
          client: emptyClient(),
        });
      } else if (replacement === "access") {
        context.emit({ hello: gatewayHelloForMethods([], []) });
      } else {
        page.unmount();
      }
      pending.resolve({ title: "Support", path: "support.md", content: "stale" });
      await preview;
      flush();
      expect(page.query(".dreams-diary__preview-panel")).toBeNull();
      expect(page.query("openclaw-modal-dialog")).toBeNull();
      if (replacement !== "unmount") {
        expect(page.toggle.open).toBe(false);
        expect(page.dreaming.wikiPreview).toBeNull();
      }
    },
  );

  it("loads wiki previews for the selected agent and keeps the dialog while content arrives", async () => {
    const response = deferred<unknown>();
    const request = requestFor({ "wiki.get": () => response.promise });
    const page = await createPage(contextWithRequest(request), "support");
    click(page.container, "#dreams-tab-diary");
    const pending = page.dreaming.onOpenWikiPage("support.md");
    flush();
    const dialog = page.query("openclaw-modal-dialog");
    expect(dialog).not.toBeNull();
    expect(request).toHaveBeenCalledWith("wiki.get", {
      lookup: "support.md",
      fromLine: 1,
      lineCount: 5000,
      agentId: "support",
    });
    response.resolve({
      title: "Support",
      path: "support.md",
      content: "support-only",
      totalLines: 6001,
      truncated: true,
    });
    await pending;
    await page.waitText(".dreams-diary__preview-pre", "support-only");
    expect(page.query("openclaw-modal-dialog")).toBe(dialog);
    expect(page.text(".dreams-diary__preview-hint")).toContain("6001");
    click(page.container, ".dreams-diary__preview-footer button");
    expect(page.dreaming.wikiPreview).toBeNull();
  });

  it("uses localized empty content for wiki previews", async () => {
    const request = requestFor({
      "wiki.get": () => ({ title: "Empty", path: "empty.md", content: "" }),
    });
    const page = await createPage(contextWithRequest(request));
    await page.dreaming.onOpenWikiPage("empty.md");
    expect(page.dreaming.wikiPreview?.page.content).toBe("No wiki content available.");
  });

  it("updates the mounted view across tab selection and owner notifications", async () => {
    let promotedToday = 2;
    let title = wikiPage.title;
    const request = requestFor(
      {
        "doctor.memory.status": () => ({
          dreaming: {
            enabled: true,
            promotedToday,
            phases: { light: { enabled: true }, deep: { enabled: false }, rem: { enabled: false } },
          },
        }),
        "doctor.memory.dreamDiary": () =>
          diary("*April 4, 2026*\nFirst dream.\n---\n*April 5, 2026*\nSecond dream."),
        "wiki.overview": () => wikiOverview(title),
      },
      () => ({ clusters: [], totalItems: 0 }),
    );
    const context = contextWithRequest(request);
    const page = await createPage(context);
    const scene = page.query(".dreams");
    promotedToday = 9;
    await page.state.loadResources();
    await waitForSolid(() => expect(page.text(".dreams__status-detail")).toContain("9 promoted"));
    expect(page.query(".dreams")).toBe(scene);
    expect(page.container.querySelectorAll(".dreams__phase--off")).toHaveLength(2);
    click(page.container, "#dreams-tab-diary");
    const dayChip =
      page.container.querySelectorAll<HTMLButtonElement>(".dreams-diary__day-chip")[1]!;
    dayChip.focus();
    dayChip.click();
    flush();
    await page.state.loadResources();
    flush();
    expect(page.container.querySelectorAll(".dreams-diary__day-chip")[1]).toBe(dayChip);
    expect(document.activeElement).toBe(dayChip);
    expect(dayChip.classList.contains("dreams-diary__day-chip--active")).toBe(true);
    click(page.container, "#dream-diary-tab-insights");
    expect(page.text("#dream-diary-panel")).toContain("memory-wiki");
    expect(page.query("#dream-diary-panel")?.getAttribute("aria-labelledby")).toBe(
      "dream-diary-tab-insights",
    );
    context.setConfig({ plugins: { entries: { "memory-wiki": { enabled: true } } } });
    context.emit({
      hello: gatewayHelloForMethods(["config.patch", "wiki.overview", "wiki.importInsights"]),
    });
    await page.state.loadResources("wikiOverview");
    click(page.container, "#dream-diary-tab-wiki");
    const card = page.query("[data-wiki-page]")!;
    const details = card.querySelector<HTMLButtonElement>("button")!;
    details.focus();
    details.click();
    flush();
    title = "Refreshed title";
    await page.state.loadResources("wikiOverview");
    await waitForSolid(() =>
      expect(card.querySelector(".dreams-diary__insight-title")?.textContent).toBe(title),
    );
    expect(page.query("[data-wiki-page]")).toBe(card);
    expect(card.querySelector("button")).toBe(details);
    expect(document.activeElement).toBe(details);
  });

  it.each([false, true])(
    "renders engine Off without presenting a cached runtime payload (latent override: %s)",
    async (override) => {
      const request = requestFor({
        "doctor.memory.status": () => ({
          dreaming: {
            enabled: true,
            promotedToday: 7,
            timezone: "Mars/Base",
            phases: { light: { enabled: true }, deep: { enabled: true }, rem: { enabled: true } },
          },
        }),
      });
      const context = contextWithRequest(request);
      const page = await createPage(context);
      await waitForSolid(() => expect(page.container.textContent).toContain("7 promoted"));
      context.setConfig({
        plugins: {
          slots: { memory: "none" },
          ...(override
            ? { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } }
            : {}),
        },
      });
      await waitForSolid(() =>
        expect(page.container.textContent).toContain("Memory engine is Off"),
      );
      const toggle = page.query<HTMLButtonElement>(".dreams__phase-toggle")!;
      expect(toggle.disabled).toBe(true);
      expect(toggle.classList.contains("dreams__phase-toggle--on")).toBe(false);
      expect(page.container.textContent).not.toContain("Using default: Enabled");
      expect(page.container.textContent).toContain("0 promoted");
      expect(page.container.textContent).not.toContain("7 promoted");
      expect(page.container.textContent).not.toContain("Mars/Base");
      toggle.click();
      expect(page.toggle.open).toBe(false);
    },
  );
});
describe.runIf(process.env.OPENCLAW_UI_MEMORY_CHROMIUM_E2E === "1")(
  "agent memory real Chromium owner proof",
  () => {
    let browser: import("playwright").Browser;
    let server: import("../../../test-helpers/control-ui-e2e.ts").ControlUiE2eServer;
    let e2e: typeof import("../../../test-helpers/control-ui-e2e.ts");

    beforeAll(async () => {
      const { chromium } = await import("playwright");
      e2e = await import("../../../test-helpers/control-ui-e2e.ts");
      const executablePath = e2e.resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
      if (!e2e.canRunPlaywrightChromium(executablePath)) {
        throw new Error(`Real Chromium required but unavailable: ${executablePath}`);
      }
      server = await e2e.startControlUiE2eServer();
      browser = await chromium.launch({ executablePath, headless: true });
    }, 90_000);

    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });

    it("preserves both routes, agent ownership, wiki gating, and reconnects", async () => {
      const status = (agentId: string, promotedToday: number) => ({
        agentId,
        provider: "builtin",
        embedding: { ok: true, checked: true },
        dreaming: {
          enabled: true,
          verboseLogging: false,
          storageMode: "inline" as const,
          separateReports: false,
          shortTermCount: promotedToday,
          recallSignalCount: 0,
          dailySignalCount: 0,
          groundedSignalCount: 0,
          totalSignalCount: 0,
          phaseSignalCount: 0,
          lightPhaseHitCount: 0,
          remPhaseHitCount: 0,
          promotedTotal: promotedToday,
          promotedToday,
          shortTermEntries: [],
          signalEntries: [],
          promotedEntries: [],
          phases: {
            light: {
              enabled: true,
              cron: "0 * * * *",
              managedCronPresent: true,
              lookbackDays: 2,
              limit: 10,
            },
            deep: {
              enabled: true,
              cron: "0 3 * * *",
              managedCronPresent: true,
              limit: 10,
              minScore: 0.8,
              minRecallCount: 2,
              minUniqueQueries: 2,
              recencyHalfLifeDays: 14,
            },
            rem: {
              enabled: false,
              cron: "0 5 * * 0",
              managedCronPresent: false,
              lookbackDays: 7,
              limit: 10,
              minPatternStrength: 0.75,
            },
          },
        },
      });
      const agentDiary = (agentId: string) => ({
        agentId,
        found: true,
        path: "DREAMS.md",
        content: `# Dream Diary\n\n*April 5, 2026, 3:00 AM*\n\n${agentId} owns this dream.`,
      });
      const config = {
        agents: { entries: { main: {}, support: {} } },
        plugins: {
          entries: {
            "memory-core": { enabled: true, config: { dreaming: { enabled: true } } },
          },
        },
      };
      const roster = {
        agents: [
          { id: "main", name: "Main" },
          { id: "support", name: "Support" },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      };
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      const gateway = await e2e.installMockGateway(page, {
        webSocketPassthroughPrefixes: [`${e2e.controlUiBundledGatewayUrl(server.baseUrl)}/?token=`],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "doctor.memory.status",
          "doctor.memory.dreamDiary",
        ],
        methodResponses: {
          "agents.list": roster,
          "config.get": {
            config,
            sourceConfig: config,
            runtimeConfig: config,
            hash: "memory-proof-1",
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
          "plugins.list": {
            plugins: [
              {
                id: "memory-core",
                name: "OpenClaw Memory",
                installed: true,
                enabled: true,
                state: "enabled",
                kind: ["memory"],
              },
            ],
            diagnostics: [],
            mutationAllowed: true,
          },
          "doctor.memory.status": {
            cases: [
              { match: { agentId: "main" }, response: status("main", 11) },
              { match: { agentId: "support" }, response: status("support", 22) },
            ],
          },
          "doctor.memory.dreamDiary": {
            cases: [
              { match: { agentId: "main" }, response: agentDiary("main") },
              { match: { agentId: "support" }, response: agentDiary("support") },
            ],
          },
        },
      });
      const detail = () => page.locator("openclaw-agent-memory-panel .dreams__status-detail");
      const requestCount = () =>
        gateway.getRequests("doctor.memory.status").then((requests) => requests.length);
      const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 15_000 });
      const expectPromoted = (count: number) =>
        poll(() => detail().textContent()).toContain(`${count} promoted`);
      const expectWikiUnused = async () => {
        expect(await gateway.getRequests("wiki.importInsights")).toHaveLength(0);
        expect(await gateway.getRequests("wiki.overview")).toHaveLength(0);
      };
      const waitRoute = (routeId: string, pathname: string) =>
        e2e.waitForControlUiRoute(page, { routeId, pathname });
      const chooseAgent = async (name: string) => {
        const picker = page.locator(".settings-sidebar openclaw-agent-select");
        await picker.locator(".agent-select__trigger").click();
        await picker
          .locator(".agent-select__option[data-agent-option]")
          .filter({ hasText: name })
          .evaluate((item) => (item as HTMLElement).click());
      };

      try {
        expect((await page.goto(`${server.baseUrl}settings/agents/main/memory`))?.status()).toBe(
          200,
        );
        await waitRoute("agents", "/settings/agents/main/memory");
        await expectPromoted(11);
        await expectWikiUnused();

        const beforeFirstMain = await requestCount();
        await gateway.deferNext("doctor.memory.status");
        await page.evaluate(() => {
          history.pushState(null, "", "/settings/memory/dreams");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await waitRoute("memory", "/settings/memory/dreams");
        await poll(requestCount).toBeGreaterThan(beforeFirstMain);

        const beforeSupport = await requestCount();
        await gateway.deferNext("doctor.memory.status");
        await chooseAgent("Support");
        await poll(requestCount).toBeGreaterThan(beforeSupport);
        await gateway.setMethodResponse("doctor.memory.status", {
          cases: [
            { match: { agentId: "main" }, response: status("main", 33) },
            { match: { agentId: "support" }, response: status("support", 22) },
          ],
        });
        await chooseAgent("Main");
        await expectPromoted(33);
        await gateway.resolveDeferred("doctor.memory.status", status("main", 11));
        await gateway.resolveDeferred("doctor.memory.status", status("support", 22));
        await expectPromoted(33);
        await expectWikiUnused();

        await gateway.setMethodResponse("doctor.memory.status", status("main", 44));
        const beforeReconnect = await requestCount();
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1001, "proxy idle timeout");
        await gateway.setOnline(false);
        await expect
          .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase), {
            timeout: 15_000,
          })
          .toBe("reconnecting");
        await poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await gateway.setOnline(true);
        await poll(requestCount).toBeGreaterThan(beforeReconnect);
        await expectPromoted(44);
        await waitRoute("memory", "/settings/memory/dreams");
      } finally {
        await context.close();
      }
    }, 120_000);
  },
);
