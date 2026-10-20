/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { startGatewayPageActivation } from "./gateway-page-activation.ts";
import type { ApplicationGatewayPhase } from "./gateway.ts";
import { refreshControlUiServiceWorker } from "./sw-refresh.runtime.ts";

vi.mock("./sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.mocked(refreshControlUiServiceWorker).mockClear();
  vi.restoreAllMocks();
});

function setup(phase: ApplicationGatewayPhase, stale = true, hidden = false) {
  const connect = vi.fn();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue(hidden ? "hidden" : "visible");
  const dispose = startGatewayPageActivation(
    { snapshot: { phase, client: { needsWakeReconnect: stale } }, connect },
    document,
    window,
  );
  disposers.push(dispose);
  const foreground = () => {
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { connect, visibility, dispose, foreground };
}
const online = () => window.dispatchEvent(new Event("online"));
const pageshow = (persisted: boolean) =>
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));

describe("Gateway page activation", () => {
  it.each(["stopped", "offline", "reload-required"] as const)(
    "preserves %s across page restoration, online, and visibility signals",
    async (phase: ApplicationGatewayPhase) => {
      const { connect, visibility, foreground } = setup(phase);
      for (const activate of [
        () => pageshow(true),
        online,
        () => {
          visibility.mockReturnValue("hidden");
          document.dispatchEvent(new Event("visibilitychange"));
          foreground();
        },
      ]) {
        const refreshed = new Promise<void>((resolve) => {
          vi.mocked(refreshControlUiServiceWorker).mockImplementationOnce(async () => {
            resolve();
            return false;
          });
        });
        activate();
        await refreshed;
      }
      expect(connect).not.toHaveBeenCalled();
      expect(refreshControlUiServiceWorker).toHaveBeenCalledTimes(3);
    },
  );

  it("coalesces foreground signals into one stale-client recovery", async () => {
    const { connect, foreground } = setup("reconnecting", true, true);
    foreground();
    online();
    await Promise.resolve();

    expect(connect).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
  });

  it("keeps a healthy client mounted when the browser reports online", async () => {
    const { connect } = setup("connected", false);
    online();
    await Promise.resolve();

    expect(connect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
  });

  it("ignores initial pageshow and removes every listener on dispose", async () => {
    const { connect, dispose } = setup("connecting");
    pageshow(false);
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();

    dispose();
    pageshow(true);
    online();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(connect).not.toHaveBeenCalled();
    expect(refreshControlUiServiceWorker).not.toHaveBeenCalled();
  });
});
