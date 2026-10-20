import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayCloseCodes } from "../internal/gateway.js";
import type { waitForDiscordGatewayStop } from "../monitor.gateway.js";
import {
  DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT,
  type MutableDiscordGateway,
} from "./gateway-handle.js";
import type { DiscordGatewayEvent } from "./gateway-supervisor.js";

type LifecycleParams = Parameters<
  typeof import("./provider.lifecycle.js").runDiscordGatewayLifecycle
>[0];

const { stopLogging, unregisterGateway, waitForStop } = vi.hoisted(() => ({
  stopLogging: vi.fn(),
  unregisterGateway: vi.fn(),
  waitForStop: vi.fn<typeof waitForDiscordGatewayStop>(async () => {}),
}));
vi.mock("../gateway-logging.js", () => ({ attachDiscordGatewayLogging: () => stopLogging }));
vi.mock("../monitor.gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../monitor.gateway.js")>()),
  waitForDiscordGatewayStop: waitForStop,
}));
vi.mock("./gateway-registry.js", () => ({ registerGateway: vi.fn(), unregisterGateway }));

describe("runDiscordGatewayLifecycle", () => {
  let runDiscordGatewayLifecycle: typeof import("./provider.lifecycle.js").runDiscordGatewayLifecycle;
  beforeAll(async () => {
    ({ runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js"));
  });
  beforeEach(() => {
    stopLogging.mockClear();
    unregisterGateway.mockClear();
    waitForStop.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  function gatewayEvent(type: DiscordGatewayEvent["type"], message: string): DiscordGatewayEvent {
    const err = new Error(message);
    return { type, err, message: String(err), shouldStopLifecycle: type !== "other" };
  }

  function createHarness({
    ready = true,
    pending = [],
  }: {
    ready?: boolean;
    pending?: DiscordGatewayEvent[];
  } = {}) {
    const emitter = new EventEmitter();
    const gateway = {
      isConnected: ready,
      options: { intents: 0 },
      disconnect: vi.fn<() => void>(),
      connect: vi.fn<(resume?: boolean) => void>(),
      emitter,
    };
    const threadStop = vi.fn();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const gatewaySupervisor = {
      attachLifecycle: vi.fn(),
      detachLifecycle: vi.fn(),
      drainPending: vi.fn((handler: (event: DiscordGatewayEvent) => "continue" | "stop") => {
        const queued = pending.splice(0);
        for (const event of queued) {
          if (handler(event) === "stop") {
            return "stop";
          }
        }
        return "continue";
      }),
      dispose: vi.fn(),
      emitter,
    };
    const statusSink = vi.fn<NonNullable<LifecycleParams["statusSink"]>>();
    const params: LifecycleParams = {
      accountId: "default",
      gateway: gateway as unknown as MutableDiscordGateway,
      runtime,
      isDisallowedIntentsError: () => false,
      voiceManager: null,
      voiceManagerRef: { current: null },
      threadBindings: { stop: threadStop },
      gatewaySupervisor,
      statusSink,
    };
    return { params, gateway, emitter, threadStop, runtime, gatewaySupervisor, statusSink };
  }

  function expectCleanup(h: ReturnType<typeof createHarness>, waits: number, detaches = 1) {
    expect(waitForStop).toHaveBeenCalledTimes(waits);
    expect(unregisterGateway).toHaveBeenCalledWith("default");
    expect(stopLogging).toHaveBeenCalledOnce();
    expect(h.threadStop).toHaveBeenCalledOnce();
    expect(h.gatewaySupervisor.detachLifecycle).toHaveBeenCalledTimes(detaches);
  }

  function expectStatus(
    h: ReturnType<typeof createHarness>,
    patch: Record<string, unknown>,
    last = false,
  ) {
    const assertion = expect(h.statusSink);
    if (last) {
      assertion.toHaveBeenLastCalledWith(expect.objectContaining(patch));
    } else {
      assertion.toHaveBeenCalledWith(expect.objectContaining(patch));
    }
  }

  function expectError(h: ReturnType<typeof createHarness>, message: string) {
    expect(h.runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
  }

  it.each([false, true])("joins bindings after voice cleanup fails=%s", async (fails) => {
    waitForStop.mockRejectedValueOnce(new Error("gateway wait failed"));
    const h = createHarness();
    const autoJoin = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => {
      if (fails) {
        throw new Error("voice destroy failed");
      }
    });
    const voiceManager = { autoJoin, destroy } as unknown as NonNullable<
      LifecycleParams["voiceManager"]
    >;
    h.params.voiceManager = h.params.voiceManagerRef.current = voiceManager;
    const entered = createDeferred<void>();
    const ready = createDeferred<void>();
    h.threadStop.mockImplementationOnce(async () => {
      entered.resolve();
      await ready.promise;
    });
    let settled = false;
    const lifecycle = runDiscordGatewayLifecycle(h.params).finally(() => {
      settled = true;
    });
    const outcome = expect(lifecycle).rejects.toThrow(
      fails ? "voice destroy failed" : "gateway wait failed",
    );
    try {
      await entered.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      ready.resolve();
      await outcome;
    }
    expectCleanup(h, 1);
    expect(autoJoin).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(h.params.voiceManagerRef.current).toBe(fails ? voiceManager : null);
  });

  it("throttles transport liveness and removes its listener on shutdown", async () => {
    const h = createHarness();
    const entered = createDeferred<void>();
    const stopped = createDeferred<void>();
    waitForStop.mockImplementationOnce(() => {
      entered.resolve();
      return stopped.promise;
    });
    const lifecycle = runDiscordGatewayLifecycle(h.params);
    await entered.promise;
    expectStatus(h, { connected: true, lifecycle: "ready", lastDisconnect: null });
    const baseline = h.statusSink.mock.calls.length;
    for (const at of [100_000, 101_000, 131_000]) {
      h.emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at });
    }
    const now = vi.spyOn(Date, "now").mockReturnValue(200_000);
    try {
      h.emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: Number.MAX_SAFE_INTEGER });
    } finally {
      now.mockRestore();
    }
    expect(h.statusSink.mock.calls.slice(baseline).map(([patch]) => patch)).toEqual([
      { lastTransportActivityAt: 100_000 },
      { lastTransportActivityAt: 131_000 },
      { lastTransportActivityAt: 200_000 },
    ]);
    stopped.resolve();
    await lifecycle;
    const calls = h.statusSink.mock.calls.length;
    h.emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: Date.now() });
    expect(h.statusSink).toHaveBeenCalledTimes(calls);
  });

  it("aborts during READY retry backoff without reconnecting again", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const h = createHarness({ ready: false });
    h.params.abortSignal = abort.signal;
    const lifecycle = runDiscordGatewayLifecycle(h.params);
    await vi.advanceTimersByTimeAsync(15_250);
    expect(h.gateway.disconnect).toHaveBeenCalledOnce();
    expect(h.gateway.connect).toHaveBeenCalledOnce();
    expect(waitForStop).not.toHaveBeenCalled();
    abort.abort(new Error("shutdown"));
    await vi.advanceTimersByTimeAsync(0);
    await lifecycle;
    expectCleanup(h, 1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.gateway.connect).toHaveBeenCalledOnce();
  });

  it("keeps retrying startup readiness and publishes recovery once READY", async () => {
    vi.useFakeTimers();
    const h = createHarness({ ready: false });
    const lifecycle = runDiscordGatewayLifecycle(h.params);
    await vi.advanceTimersByTimeAsync(34_000);
    expect(h.gateway.disconnect).toHaveBeenCalledTimes(2);
    expect(h.gateway.connect).toHaveBeenCalledTimes(2);
    expect(h.gateway.connect).toHaveBeenCalledWith(false);
    expect(waitForStop).not.toHaveBeenCalled();
    expectError(h, "gateway READY wait timed out after 15000ms");
    expectStatus(h, { connected: false, lifecycle: "recovering" });
    h.gateway.isConnected = true;
    await vi.advanceTimersByTimeAsync(2_500);
    await lifecycle;
    expectStatus(h, { connected: true, lifecycle: "ready", lastDisconnect: null, lastError: null });
    expectCleanup(h, 1);
  });

  it("handles queued disallowed intents without waiting for gateway events", async () => {
    const h = createHarness({
      pending: [gatewayEvent("disallowed-intents", "Fatal Gateway error: 4014")],
    });
    await runDiscordGatewayLifecycle(h.params);
    expectError(h, "discord: gateway closed with code 4014");
    expectCleanup(h, 0);
  });

  it("logs queued non-fatal startup errors and continues", async () => {
    const h = createHarness({ pending: [gatewayEvent("other", "transient startup error")] });
    await runDiscordGatewayLifecycle(h.params);
    expectError(h, "discord gateway error: Error: transient startup error");
    expectCleanup(h, 1);
  });

  it("treats abort-time live reconnect exhaustion as expected shutdown", async () => {
    const abort = new AbortController();
    const h = createHarness();
    h.params.abortSignal = abort.signal;
    h.gatewaySupervisor.attachLifecycle.mockImplementation(
      (handler: (event: DiscordGatewayEvent) => void) => {
        abort.signal.addEventListener(
          "abort",
          () =>
            handler(
              gatewayEvent(
                "reconnect-exhausted",
                "Max reconnect attempts (50) reached after close code 1005",
              ),
            ),
          { once: true },
        );
      },
    );
    waitForStop.mockImplementationOnce(async (params) => {
      const actual =
        await vi.importActual<typeof import("../monitor.gateway.js")>("../monitor.gateway.js");
      const waiting = actual.waitForDiscordGatewayStop(params);
      abort.abort(new Error("shutdown"));
      return await waiting;
    });
    await runDiscordGatewayLifecycle(h.params);
    expect(h.gatewaySupervisor.attachLifecycle).toHaveBeenCalledOnce();
    expect(h.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("treating reconnect-exhausted during expected shutdown as clean"),
    );
    expect(h.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Max reconnect attempts (50) reached after close code 1005"),
    );
    expect(h.runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("discord gateway reconnect-exhausted"),
    );
    expectCleanup(h, 1, 2);
  });

  it("surfaces fatal startup errors while waiting for READY", async () => {
    vi.useFakeTimers();
    const pending: DiscordGatewayEvent[] = [];
    const h = createHarness({ ready: false, pending });
    setTimeout(() => pending.push(gatewayEvent("fatal", "Fatal Gateway error: 4001")), 1_000);
    const lifecycle = runDiscordGatewayLifecycle(h.params);
    const outcome = expect(lifecycle).rejects.toThrow(
      "discord gateway fatal: Error: Fatal Gateway error: 4001",
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await outcome;
    expectError(h, "discord gateway fatal: Error: Fatal Gateway error: 4001");
    expect(h.gateway.disconnect).not.toHaveBeenCalled();
    expect(h.gateway.connect).not.toHaveBeenCalled();
    expectCleanup(h, 0);
  });

  it("publishes blocked lifecycle for a fatal authentication close", async () => {
    const h = createHarness();
    const code = GatewayCloseCodes.AuthenticationFailed;
    waitForStop.mockImplementationOnce(async () => {
      h.emitter.emit("debug", `Gateway websocket closed: ${code}`);
    });
    await runDiscordGatewayLifecycle(h.params);
    expectStatus(h, {
      connected: false,
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: `Gateway websocket closed: ${code}`,
      lastDisconnect: expect.objectContaining({ status: code }),
    });
  });

  it("publishes recovery through socket close, scheduled reconnect, and READY", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    waitForStop.mockImplementationOnce(async () => {
      h.gateway.isConnected = false;
      h.emitter.emit("debug", "Gateway websocket closed: 1006");
      expectStatus(
        h,
        {
          connected: false,
          lifecycle: "recovering",
          lastDisconnect: expect.objectContaining({ status: 1006 }),
        },
        true,
      );
      const reconnect = "Gateway reconnect scheduled in 1000ms (zombie, resume=true)";
      h.emitter.emit("debug", reconnect);
      expectStatus(h, { connected: false, lifecycle: "recovering", lastError: reconnect }, true);
      h.emitter.emit("debug", "Gateway websocket opened");
      expectStatus(h, { connected: false }, true);
      setTimeout(() => {
        h.gateway.isConnected = true;
      }, 1_000);
      await vi.advanceTimersByTimeAsync(1_500);
      expectStatus(h, { connected: true, lifecycle: "ready", lastDisconnect: null }, true);
    });
    await runDiscordGatewayLifecycle(h.params);
  });
});
