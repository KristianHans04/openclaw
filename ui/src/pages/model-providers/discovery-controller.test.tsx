/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createModelProviderDiscovery } from "./discovery-controller.tsx";

const moduleGate = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
});

// mock-isolation: Hold the module import without starting the setup page's Gateway owners.
vi.mock("../model-setup/model-setup-page.tsx", async () => {
  await moduleGate.promise;
  return {
    ModelSetupPage: (props: { agentLabel: string; onClose: () => void }) => (
      <button data-setup onClick={() => props.onClose()}>
        {props.agentLabel}
      </button>
    ),
  };
});

it("retires a cancelled lazy setup and opens the current agent with live presentation data", async () => {
  let agentId = "first";
  const client = createTestGatewayClient(async () => ({}));
  const onClose = vi.fn();
  const onError = vi.fn();
  let discovery!: ReturnType<typeof createModelProviderDiscovery>;
  let updateLabel!: (label: string) => void;
  const view = mountSolid(() => {
    const [label, setLabel] = createSignal("First agent");
    updateLabel = setLabel;
    discovery = createModelProviderDiscovery({
      canOpen: () => true,
      getOwner: () => ({ client, agentId }),
      onClose,
      onError,
    });
    return discovery.render(() => ({ agentLabel: label(), credentialChoices: [] }));
  });

  discovery.open();
  await waitForSolid(() => expect(view.container.querySelector('[role="status"]')).not.toBeNull());
  discovery.cancelLoading();
  // A replacement can open before the cancelled view commits its removal.
  agentId = "second";
  updateLabel("Second agent");
  discovery.open();
  moduleGate.resolve();
  await vi.dynamicImportSettled();
  expect(onError).not.toHaveBeenCalled();
  await waitForSolid(() =>
    expect(view.container.querySelector("[data-setup]")?.textContent).toBe("Second agent"),
  );
  // Once the module is mounted, reconnect belongs to setup rather than its launcher.
  discovery.cancelLoading();
  updateLabel("Renamed agent");
  flush();
  expect(view.container.querySelector("[data-setup]")?.textContent).toBe("Renamed agent");
  view.container.querySelector<HTMLButtonElement>("[data-setup]")!.click();
  flush();
  expect(onClose).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(view.container.textContent).toBe("");
});
