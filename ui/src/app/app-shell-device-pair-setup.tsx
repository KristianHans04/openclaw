import type { JSX as SolidJSX } from "@solidjs/web";
import { Errored, lazy, Loading, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";

type DevicePairSetupModule = typeof import("../pages/devices/view-pairing.tsx");
type DevicePairSetupProps = Parameters<DevicePairSetupModule["DevicePairSetup"]>[0];

// Keep the pairing runtime lazy so opening the shell never fetches this chunk.
export function DevicePairSetup(props: { props: DevicePairSetupProps }): SolidJSX.Element {
  const Pairing = lazy(() => import("../pages/devices/view-pairing.tsx"), {
    export: "DevicePairSetup",
  });
  return (
    <Show when={props.props.open}>
      <Errored
        fallback={(_error, reset) => (
          <DevicePairSetupFallback onClose={props.props.onClose} retry={reset} />
        )}
      >
        <Loading fallback={<DevicePairSetupFallback onClose={props.props.onClose} />}>
          <Pairing {...props.props} />
        </Loading>
      </Errored>
    </Show>
  );
}

function DevicePairSetupFallback(props: { onClose: () => void; retry?: () => void }) {
  return (
    <openclaw-modal-dialog
      label={t("devices.pairing.title")}
      description={t(props.retry ? "devices.pairing.loadFailed" : "common.loading")}
      onModal-cancel={() => props.onClose()}
    >
      <section class="device-pair-setup" aria-busy={props.retry ? undefined : "true"}>
        <header class="device-pair-setup__header">
          <div>
            <h2>{t("devices.pairing.title")}</h2>
            <p role={props.retry ? undefined : "status"}>
              {t(props.retry ? "devices.pairing.loadFailed" : "common.loading")}
            </p>
          </div>
        </header>
        <openclaw-modal-actions class="device-pair-setup__footer">
          <Show when={props.retry}>
            <button class="btn btn--primary" type="button" onClick={() => props.retry?.()}>
              {t("common.retry")}
            </button>
          </Show>
          <button class="btn btn--ghost" type="button" onClick={() => props.onClose()}>
            {t("common.close")}
          </button>
        </openclaw-modal-actions>
      </section>
    </openclaw-modal-dialog>
  );
}
