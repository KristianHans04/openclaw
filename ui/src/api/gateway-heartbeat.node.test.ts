/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "./gateway.ts";
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
beforeEach(() => {
  const storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
  stubWindowGlobals(storage);
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("document", {
    documentElement: { getAttribute: () => null },
    visibilityState: "visible",
  });
  // The heartbeat contract does not require device signing.
  vi.stubGlobal("crypto", { randomUUID: () => "heartbeat-request" });
  wsInstances.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function startConnect(client: GatewayBrowserClient, tickIntervalMs = 30_000) {
  client.start();
  const ws = getLatestWebSocket();
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "heartbeat-challenge", ts: 1_800_000_000_000 },
  });
  await vi.advanceTimersByTimeAsync(0);
  const connectFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string };
  ws.emitMessage({
    type: "res",
    id: connectFrame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["health"] },
      policy: { tickIntervalMs },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  return ws;
}

function probes(ws: MockWebSocket): { id: string; method: string; params: unknown }[] {
  return ws.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.method === "health");
}

describe("GatewayBrowserClient heartbeat recovery", () => {
  it.each([true, false])(
    "keeps an idle socket open when its silence probe answers (ok=%s)",
    async (ok) => {
      useNodeFakeTimers();
      const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
      try {
        const ws = await startConnect(client);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(probes(ws)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(probes(ws)).toHaveLength(1);
        expect(probes(ws)[0].params).toEqual({ probe: false });
        ws.emitMessage({ type: "res", id: probes(ws)[0].id, ok, payload: {} });
        await vi.advanceTimersByTimeAsync(59_999);
        expect(ws.lastClose).toBeNull();
        expect(probes(ws)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(probes(ws)).toHaveLength(2);
        expect(wsInstances).toHaveLength(1);
      } finally {
        client.stop();
      }
    },
  );

  it("reconnects only after an idle silence probe receives no inbound frame for ten seconds", async () => {
    useNodeFakeTimers();
    const onClose = vi.fn();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL, onClose });
    try {
      const ws = await startConnect(client);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probes(ws)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(ws.lastClose).toBeNull();
      expect(probes(ws)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.lastClose).toEqual({ code: 4000, reason: "inbound silence probe timeout" });
      ws.emitClose(4000, "inbound silence probe timeout");
      expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ willRetry: true }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(wsInstances).toHaveLength(2);
    } finally {
      client.stop();
    }
  });

  it.each([
    { type: "event", event: "tick", seq: 1, payload: {} },
    { type: "res", id: "unrelated-response", ok: true, payload: {} },
  ])("accepts other inbound traffic during the probe: $type", async (frame) => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(probes(ws)).toHaveLength(1);
      ws.emitMessage(frame);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(ws.lastClose).toBeNull();
      expect(probes(ws)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(probes(ws)).toHaveLength(2);
    } finally {
      client.stop();
    }
  });

  it("probes fifteen seconds after a sent request even if it timed out after ten seconds", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client);
      await vi.advanceTimersByTimeAsync(5_000);
      const onSent = vi.fn();
      const request = client
        .request("sessions.list", {}, { timeoutMs: 10_000, onSent })
        .catch((error: unknown) => error);
      expect(onSent).toHaveBeenCalledOnce();
      expect(JSON.parse(ws.sent.at(-1)!).method).toBe("sessions.list");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await request).toMatchObject({
        code: "CLIENT_TIMEOUT",
        timeoutMs: 10_000,
        requestSent: true,
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(probes(ws)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(probes(ws)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ws.lastClose).toEqual({ code: 4000, reason: "inbound silence probe timeout" });
    } finally {
      client.stop();
    }
  });

  it("does not probe early after a sent request is answered quickly", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client);
      await vi.advanceTimersByTimeAsync(5_000);
      const request = client.request("sessions.list", {}, { timeoutMs: 10_000 });
      const frame = JSON.parse(ws.sent.at(-1)!) as { id: string };
      await vi.advanceTimersByTimeAsync(1_000);
      ws.emitMessage({ type: "res", id: frame.id, ok: true, payload: {} });
      await expect(request).resolves.toEqual({});
      await vi.advanceTimersByTimeAsync(59_000);
      expect(probes(ws)).toEqual([]);
      expect(ws.lastClose).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(probes(ws)).toHaveLength(1);
    } finally {
      client.stop();
    }
  });

  it("does not probe a hidden document or reconnect when it hides during a probe", async () => {
    useNodeFakeTimers();
    const visibility = document;
    Object.defineProperty(visibility, "visibilityState", { value: "hidden", writable: true });
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(probes(ws)).toEqual([]);
      expect(ws.lastClose).toBeNull();
      Object.defineProperty(visibility, "visibilityState", { value: "visible" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(probes(ws)).toHaveLength(1);
      Object.defineProperty(visibility, "visibilityState", { value: "hidden" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probes(ws)).toHaveLength(1);
      expect(ws.lastClose).toBeNull();
    } finally {
      client.stop();
    }
  });

  it("cleans up an in-flight silence probe on stop and ignores its late response", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probes(ws)).toHaveLength(1);
      client.stop();
      ws.emitMessage({ type: "res", id: probes(ws)[0].id, ok: true, payload: {} });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ws.lastClose).toEqual({ code: undefined, reason: undefined });
      expect(wsInstances).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.stop();
    }
  });

  it("retires a closed socket's probe before the replacement connection is ready", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probes(ws)).toHaveLength(1);
      ws.emitClose(1006, "lost connection");
      await vi.advanceTimersByTimeAsync(1_000);
      const replacement = await startConnect(client);
      ws.emitMessage({ type: "res", id: probes(ws)[0].id, ok: true, payload: {} });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(replacement.lastClose).toBeNull();
      expect(probes(replacement)).toEqual([]);
      expect(wsInstances).toHaveLength(2);
    } finally {
      client.stop();
    }
  });

  it("preserves a live transport through delayed application heartbeats and still detects a stale tab", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client, 1_000);
      const request = client.request("wizard.next", {}, { timeoutMs: null });
      void request.catch(() => undefined);
      const requestFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string };

      await vi.advanceTimersByTimeAsync(1_999);
      expect(ws.lastClose).toBeNull();
      expect(client.needsWakeReconnect).toBe(false);
      await vi.advanceTimersByTimeAsync(501);

      expect(ws.lastClose).toBeNull();
      expect(client.needsWakeReconnect).toBe(true);
      for (let round = 0; round < 3; round += 1) {
        await vi.advanceTimersByTimeAsync(round === 0 ? 2_500 : 5_000);
        expect(probes(ws)).toHaveLength(round + 1);
        ws.emitMessage({ type: "res", id: probes(ws).at(-1)!.id, ok: true, payload: {} });
      }
      expect(ws.lastClose).toBeNull();
      expect(wsInstances).toHaveLength(1);
      ws.emitMessage({ type: "event", event: "tick", seq: 1, payload: {} });
      expect(client.needsWakeReconnect).toBe(false);
      ws.emitMessage({ type: "res", id: requestFrame.id, ok: true, payload: { done: true } });
      await expect(request).resolves.toEqual({ done: true });
    } finally {
      client.stop();
    }
  });

  it("keeps an in-flight upgrade through tab wake while the Gateway is stalled", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      client.start();
      const ws = getLatestWebSocket();
      // A stalled Gateway main thread has not answered the HTTP upgrade yet.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.needsWakeReconnect).toBe(false);

      ws.emitClose(1006, "");
      // Waiting out reconnect backoff is a valid wake reason.
      expect(client.needsWakeReconnect).toBe(true);
    } finally {
      client.stop();
    }
  });

  it.each([Number.MAX_SAFE_INTEGER, 2 ** 32 + 1])(
    "clamps the advertised heartbeat %d when deciding whether a tab is stale",
    async (advertisedTickIntervalMs) => {
      useNodeFakeTimers();
      const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });

      try {
        const ws = await startConnect(client, advertisedTickIntervalMs);
        await vi.advanceTimersByTimeAsync(0);

        vi.setSystemTime(Date.now() + 4_294_967_293);
        expect(ws.lastClose).toBeNull();
        expect(client.needsWakeReconnect).toBe(false);
        vi.setSystemTime(Date.now() + 1);
        expect(client.needsWakeReconnect).toBe(true);
      } finally {
        client.stop();
      }
    },
  );

  it("keeps a healthy heartbeat and explicitly unbounded request alive", async () => {
    useNodeFakeTimers();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL });
    try {
      const ws = await startConnect(client, 1_000);
      const request = client.request("wizard.next", {}, { timeoutMs: null });
      const requestFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string };

      for (let seq = 1; seq <= 4; seq += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        ws.emitMessage({ type: "event", event: "tick", seq, payload: {} });
      }

      expect(ws.lastClose).toBeNull();
      ws.emitMessage({ type: "res", id: requestFrame.id, ok: true, payload: { done: true } });
      await expect(request).resolves.toEqual({ done: true });
      client.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ws.lastClose).toEqual({ code: undefined, reason: undefined });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.stop();
    }
  });
});
