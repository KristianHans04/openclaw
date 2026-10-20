/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { startGatewayPresenceActivity } from "./gateway-presence-activity.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "./gateway-store.test-support.ts";

const disposers: Array<() => void> = [];
const inputTypes = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"];
afterEach(() => {
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose();
  }
  vi.restoreAllMocks();
});

function setup(visibility: DocumentVisibilityState = "visible") {
  const target = document.implementation.createHTMLDocument();
  const visible = vi.spyOn(target, "visibilityState", "get").mockReturnValue(visibility);
  const added = vi.spyOn(target, "addEventListener");
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  disposers.push(() => store.gateway.stop());
  store.current().request.mockResolvedValue({ ok: true });
  const stop = startGatewayPresenceActivity(store.gateway, target);
  disposers.push(stop);
  const ready = (scopes = ["operator.read"]) =>
    store.current().opts.onHello?.({
      ...GATEWAY_STORE_TEST_HELLO,
      auth: { role: "operator", scopes },
    });
  const activityCalls = () =>
    store.current().request.mock.calls.filter(([method]) => method === "presence.activity");
  const input = (type: string, trusted = true) => {
    const callback = added.mock.calls.find(([event]) => event === type)?.[1];
    if (typeof callback === "function") {
      // jsdom cannot create trusted browser input; exercise the installed listener.
      callback.call(target, { isTrusted: trusted } as Event);
    }
  };
  return { ...store, target, visible, ready, input, stop, activityCalls };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

it("does not report visits or input without operator read access", async () => {
  const store = setup();
  store.ready(["operator.sessions.read", "operator.sessions.write"]);
  store.input("keydown");
  await settle();
  expect(store.current().request).not.toHaveBeenCalledWith("presence.activity", {});
});

it.each(["visible", "hidden"] as const)(
  "reports one genuine visit per initially %s document",
  async (visibility) => {
    const store = setup(visibility);
    expect(store.activityCalls()).toHaveLength(0);
    store.ready();
    if (visibility === "hidden") {
      store.input("keydown");
      store.visible.mockReturnValue("visible");
      store.target.dispatchEvent(new Event("visibilitychange"));
      store.target.dispatchEvent(new Event("scroll"));
      store.input("pointerdown", false);
      store
        .current()
        .opts.onEvent?.({ type: "event", event: "chat", payload: { text: "agent output" } });
      store.current().opts.onEvent?.({ type: "event", event: "tick" });
      expect(store.activityCalls()).toHaveLength(0);
      store.input("wheel");
    }
    await settle();
    expect(store.activityCalls()).toEqual([["presence.activity", {}]]);
    store.gateway.connect();
    store.current().request.mockResolvedValue({ ok: true });
    store.ready();
    expect(store.activityCalls()).toHaveLength(0);
    store.stop();
    disposers.push(startGatewayPresenceActivity(store.gateway, store.target));
    expect(store.activityCalls()).toHaveLength(0);
  },
);

it("throttles continuous trusted input and reports immediately after idle without trailing work", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
  const store = setup("hidden");
  store.ready();
  store.visible.mockReturnValue("visible");
  for (const [index, type] of inputTypes.entries()) {
    clock.mockReturnValue(1_000 + index * 30_000);
    store.input(type);
    await settle();
    store.input(type);
    expect(store.activityCalls()).toHaveLength(index + 1);
  }
  clock.mockReturnValue(500_000);
  await settle();
  expect(store.activityCalls()).toHaveLength(5);
  store.input("pointerdown");
  await settle();
  expect(store.activityCalls()).toHaveLength(6);
});

it("drops disconnected and hidden input and retires listeners on disposal", async () => {
  const store = setup("hidden");
  store.input("keydown");
  store.ready();
  store.visible.mockReturnValue("visible");
  store.current().opts.onClose?.({ code: 1006, reason: "closed", willRetry: true });
  store.input("pointerdown");
  store.ready();
  expect(store.activityCalls()).toHaveLength(0);
  store.stop();
  store.input("keydown");
  store.ready();
  expect(store.activityCalls()).toHaveLength(0);
  const removed = vi.spyOn(store.target, "removeEventListener");
  const stop = startGatewayPresenceActivity(store.gateway, store.target);
  stop();
  expect(removed.mock.calls.map(([type]) => type)).toEqual(inputTypes);
});

it("keeps one request in flight and never retries a failed interaction without new input", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
  const store = setup();
  const pending = createDeferredCore();
  store
    .current()
    .request.mockImplementation((method) =>
      method === "users.self" ? Promise.resolve({ profile: null }) : pending.promise,
    );
  store.ready();
  clock.mockReturnValue(61_000);
  store.input("keydown");
  expect(store.activityCalls()).toHaveLength(1);
  pending.reject(new Error("offline"));
  await settle();
  expect(store.activityCalls()).toHaveLength(1);
  store.current().request.mockResolvedValue({ ok: true });
  store.input("keydown");
  await settle();
  expect(store.activityCalls()).toHaveLength(2);
});
