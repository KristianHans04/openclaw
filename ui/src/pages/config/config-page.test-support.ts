import { createComponent, createSignal } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { completeConfigContext } from "./config-page-state.test-support.ts";
import { ConfigPage, type ConfigPageId } from "./config-page.tsx";
import type { ConfigRouteData } from "./route-data.ts";

export function mountConfigPage(
  initialContext: ApplicationContext,
  initial: { pageId?: ConfigPageId; routeData?: ConfigRouteData | null } = {},
) {
  const provider = createSolidApplicationContextProvider(completeConfigContext(initialContext));
  const [props, setProps] = createSignal(initial);
  const view = mountSolid(
    () => {
      const result = createComponent(ConfigPage, {
        get pageId() {
          return props().pageId ?? "advanced";
        },
        get routeData() {
          return props().routeData ?? null;
        },
      });
      return result;
    },
    { wrapper: provider.wrapper },
  );
  flush();
  return {
    container: view.container,
    get page() {
      return view.container.querySelector<HTMLElement>("openclaw-config-page")!;
    },
    setContext(next: ApplicationContext) {
      provider.setContext(completeConfigContext(next));
      flush();
    },
    update(next: Partial<typeof initial>) {
      setProps((previous) => ({ ...previous, ...next }));
      flush();
    },
    dispose: view.unmount,
  };
}
