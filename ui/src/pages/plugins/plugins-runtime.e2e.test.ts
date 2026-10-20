import { afterAll, beforeAll, expect, it } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  calendarInspection,
  calendarPlugin,
  captureScreenshot,
  describeControlUiE2e,
  enabledWorkboardCapabilities,
  installMockGateway,
  inventory,
  mobileViewport,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

describeControlUiE2e("Control UI plugin runtime actions", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("reviews enablement, applies it without reconnecting, and preserves removal at mobile width", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": inventory([{ ...calendarPlugin, enabled: false, state: "disabled" }]),
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins/calendar-plus#lifecycle`);
      const row = page.locator(".plugin-catalog-detail");
      const button = (name: string, within = row) =>
        within.getByRole("button", { name, exact: true });
      const setEnabled = "plugins.setEnabled";
      const enableParams = { pluginId: "calendar-plus", enabled: true };
      await row.waitFor({ state: "visible" });
      const connects = (await gateway.getRequests("connect")).length;
      await captureScreenshot(page, "runtime-01-before-desktop.png");
      await gateway.deferNext(setEnabled);
      await button("Enable Calendar Plus").click();
      expect((await gateway.waitForRequest(setEnabled)).params).toEqual(enableParams);
      await gateway.rejectDeferred(setEnabled, {
        code: "INVALID_REQUEST",
        message: "Changed capabilities need review",
        details: buildCapabilityConsentErrorDetails({
          pluginId: "calendar-plus",
          reviewToken: calendarInspection.reviewToken,
        }),
      });
      const consent = page.locator('[data-plugin-consent="enable"]');
      const accept = button("Enable Calendar Plus", consent);
      await accept.waitFor({ state: "visible" });
      await expect.poll(() => accept.isEnabled()).toBe(true);
      await captureScreenshot(page, "runtime-02-consent-desktop.png");
      await gateway.deferNext(setEnabled);
      await accept.click();
      const retry = await gateway.waitForRequest(setEnabled, { after: 1 });
      expect(retry.params).toEqual({
        ...enableParams,
        acknowledgeCapabilities: { reviewToken: calendarInspection.reviewToken },
      });
      await gateway.setMethodResponse("plugins.list", inventory([calendarPlugin], 2));
      await gateway.setMethodResponse("plugins.uiDescriptors", {
        ...enabledWorkboardCapabilities(),
        generation: 2,
        controlUiTabs: [],
      });
      await gateway.emitGatewayEvent("plugins.changed", { generation: 2 });
      await gateway.resolveDeferred(setEnabled, {
        ok: true,
        plugin: calendarPlugin,
        restartRequired: false,
        runtime: { operationId: "enable-calendar", generation: 2, pluginIds: ["calendar-plus"] },
      });
      await expect.poll(() => button("Disable Calendar Plus").isEnabled()).toBe(true);
      expect(await row.locator('.plugins-row-message[role="status"]').count()).toBe(0);
      await captureScreenshot(page, "runtime-03-after-desktop.png");
      await page.setViewportSize(mobileViewport);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              innerWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      for (const action of ["Disable Calendar Plus", "Uninstall Calendar Plus"]) {
        const control = button(action);
        await control.waitFor({ state: "visible" });
        // A resize can replace the control after a separate visibility check.
        await expect
          .poll(async () => {
            const box = await control.boundingBox();
            expect(box).not.toBeNull();
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(mobileViewport.width);
            return true;
          })
          .toBe(true);
      }
      await captureScreenshot(page, "runtime-04-after-mobile.png");
      const loadError =
        "Plugin operation failed during prepare: SyntaxError in " +
        "/synthetic/var/folders/aa/0123456789abcdef0123456789abcd/T/openclaw-plugin-build/" +
        "package-0/node_modules/calendar-plus/helper.ts:1:30\n" +
        "Gateway generation 2: replacement not applied.";
      await gateway.deferNext(setEnabled);
      await button("Disable Calendar Plus").click();
      await gateway.waitForRequest(setEnabled, { after: 2 });
      await gateway.rejectDeferred(setEnabled, {
        code: "UNAVAILABLE",
        message: loadError,
        details: {
          runtime: {
            operationId: "disable-rejected",
            generation: 2,
            pluginIds: ["calendar-plus"],
            phase: "prepare",
            committed: false,
          },
        },
      });
      const failure = page.locator('.plugins-row-message[role="alert"]');
      await failure.getByText(`${loadError}\nRuntime phase: prepare.`, { exact: true }).waitFor();
      await captureScreenshot(page, "runtime-05-error-mobile.png");
      expect(
        await failure.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      const failureBounds = await failure.boundingBox();
      expect(failureBounds!.x + failureBounds!.width).toBeLessThanOrEqual(mobileViewport.width);
      await gateway.setMethodResponse("plugins.list", inventory([], 3));
      await button("Uninstall Calendar Plus").click();
      const confirmation = page.locator("openclaw-modal-dialog");
      await confirmation.waitFor();
      expect(await confirmation.textContent()).toContain("all of its entries");
      expect(await gateway.getRequests("plugins.uninstall")).toHaveLength(0);
      await button("Cancel", confirmation).click();
      await confirmation.waitFor({ state: "detached" });
      expect(await gateway.getRequests("plugins.uninstall")).toHaveLength(0);
      await button("Uninstall Calendar Plus").click();
      await button("Remove", confirmation).click();
      await row.waitFor({ state: "detached" });
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
      expect(await page.locator('[data-plugin-id="calendar-plus"]').count()).toBe(0);
      expect((await gateway.waitForRequest("plugins.uninstall")).params).toEqual({
        pluginId: "calendar-plus",
      });
      expect(await gateway.getRequests(setEnabled)).toHaveLength(3);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
      await captureScreenshot(page, "runtime-06-removed-mobile.png");
    } finally {
      await context.close();
    }
  });
});
