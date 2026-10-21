import { definePage } from "@openclaw/uirouter";
import { lazy, Loading } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.ts";

const CronPage = lazy(() => import("./cron-page.tsx"), { export: "CronPage" });

export const page = definePage({
  ...routePageSpec("cron"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: async () => {
    // The route still owns import timing, including navigation preloads.
    await CronPage.preload();
    return {
      header: true,
      renderSolid: (props: SolidRouteProps) => (
        <Loading>
          <CronPage routeSearch={typeof props.data === "string" ? props.data : ""} />
        </Loading>
      ),
    };
  },
});
