import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { installControlUiE2eRendererStallProbe } from "../test-helpers/control-ui-e2e-renderer-stall.ts";
import {
  installMockGateway,
  navigateToControlUiSession,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createMarginImage,
  marginCases,
  marginScenario,
  measureMargin,
  resizeMarginViewport,
} from "./chat-mobile-bubble-margin.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = (id: string) => `agent:main:margin-${id}`;
const sessionRow = (id: string) => ({
  key: sessionKey(id),
  sessionId: `session:${sessionKey(id)}`,
  label: "Main",
  kind: "direct",
  updatedAt: 1_800_000_000_000,
});
let marginFixture: {
  page: Page;
  gateway: Awaited<ReturnType<typeof installMockGateway>>;
  image: Buffer;
  images: { small: Buffer; large: Buffer };
};
const suite = createControlUiE2eSuite({
  name: "Mobile transcript bubble gutters",
  startServerBeforeBrowser: true,
  resources: {
    run: async () => {
      const context = await suite.newBrowserContext({
        viewport: { width: 1440, height: 1200 },
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await installControlUiE2eRendererStallProbe(page);
      const images = {
        small: await createMarginImage(page, { width: 320, height: 180 }),
        large: await createMarginImage(page),
      };
      const video = await readFile(new URL("./fixtures/video-poster.mp4", import.meta.url));
      const audio = createPlaybackMediaFixture("mp3");
      await page.route("https://media.example/**", (route) => {
        const request = route.request();
        if (request.url().endsWith("png")) {
          return route.fulfill({ contentType: "image/png", body: marginFixture.image });
        }
        if (!request.url().endsWith("mp4")) {
          return route.fulfill({
            contentType: "audio/mpeg",
            headers: { "access-control-allow-origin": "*" },
            body: audio,
          });
        }
        const start = Number(request.headers().range?.match(/bytes=(\d+)/)?.[1] ?? 0);
        return route.fulfill({
          status: 206,
          contentType: "video/mp4",
          headers: {
            "access-control-allow-origin": "*",
            "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${video.length - 1}/${video.length}`,
          },
          body: video.subarray(start),
        });
      });
      const first = marginCases[0];
      const gateway = await installMockGateway(page, {
        ...marginScenario(first),
        sessionKey: sessionKey(first.id),
        sessions: [sessionRow(first.id)],
        sessionTranscripts: Object.fromEntries(
          marginCases.map((testCase) => [
            sessionKey(testCase.id),
            { messages: [...testCase.messages] },
          ]),
        ),
      });
      marginFixture = { page, gateway, image: images.large, images };
      await page.goto(`${suite.server.baseUrl}settings/about`, { waitUntil: "domcontentloaded" });
      await waitForControlUiRoute(page, { routeId: "about" });
    },
  },
});

type Margin = Awaited<ReturnType<typeof measureMargin>>;
function expectMediaInside({ media }: Margin, label: string) {
  expect(
    media.filter((item) => item.width > 0 && !(Math.min(item.left, item.right) >= -1)),
    `${label} media stays inside its surface`,
  ).toEqual([]);
}
function expectActivityEdges(margin: Margin, label: string) {
  expect(margin, label).toMatchObject({ closed: expect.closeTo(0, 0), open: expect.closeTo(0, 0) });
}

suite.define(() => {
  it.for(marginCases)(
    "preserves $id gutters across viewports and themes, restoring desktop geometry",
    async (testCase, testContext) => {
      const { page, gateway, images } = marginFixture;
      let failedClose: Promise<void> | undefined;
      const closeAfterFailure = (error: unknown) => {
        failedClose ??= (async () => {
          await captureControlUiE2eFailureDiagnostics(page, {
            error: error instanceof Error ? error : new Error(String(error)),
            label: "Mobile transcript bubble gutters",
          });
          await suite.closeBrowserContext(page.context());
        })();
        return failedClose;
      };
      // The suite owns this page; a canceled case must still close its pending work.
      const onAbort = () => void closeAfterFailure(testContext.signal.reason).catch(() => {});
      testContext.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await suite.runScenario(testContext, {
          run: async () => {
            try {
              await evaluateControlUiContext(page, (context) => context.navigate("about"));
              await waitForControlUiRoute(page, { routeId: "about" });
              await page.emulateMedia({ colorScheme: "light" });
              await page.setViewportSize({ width: 1440, height: 1200 });
              await page.mouse.move(0, 0);
              const imageSize = "imageSize" in testCase ? testCase.imageSize : undefined;
              marginFixture.image = imageSize?.width === 320 ? images.small : images.large;
              await gateway.setSessionsListResponse({ sessions: [sessionRow(testCase.id)] });
              await evaluateControlUiContext(page, (context) =>
                context.sessions.refresh({ agentId: "main", force: true }),
              );
              await page.bringToFront();
              await navigateToControlUiSession(page, sessionKey(testCase.id));
              const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
              const measure = () => measureMargin(page, testCase);
              for (const theme of ["light", "dark"] as const) {
                await page.emulateMedia({ colorScheme: theme });
                await expectBrowser(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
                if (testCase.id === "user-video" || testCase.id === "user-mixed") {
                  const poster = pane.locator(".chat-video-preview img");
                  await expectBrowser(poster).toBeVisible();
                  await expect
                    .poll(() =>
                      poster.evaluate(
                        (element) =>
                          element instanceof HTMLImageElement &&
                          element.complete &&
                          element.naturalWidth > 0,
                      ),
                    )
                    .toBe(true);
                }
                const desktop = await measure();
                for (const width of [390, 430]) {
                  const label = `${testCase.id} at ${width} px in ${theme}`;
                  const pollMargin = <T>(project: (margin: Margin) => T) =>
                    expect.poll(async () => project(await measure()), { message: label });
                  await resizeMarginViewport(page, width);
                  if (testCase.selector === ".chat-session-activity") {
                    const activity = pane.locator(".chat-thread .chat-session-activity");
                    const chevron = activity.locator("summary .chat-session-activity__chevron");
                    await expectBrowser(activity.locator("summary"), label).toBeVisible();
                    await expectBrowser(activity.locator(".chat-bubble"), label).toHaveCount(0);
                    const collapsed = await measure();
                    expectActivityEdges(collapsed, label);
                    await chevron.click();
                    await expectBrowser(activity.locator(".chat-bubble"), label).toBeVisible();
                    await expectBrowser(
                      activity.locator(".chat-message-disclosure__toggle"),
                      label,
                    ).toHaveCount(0);
                    const expanded = await measure();
                    expectActivityEdges(expanded, label);
                    expect(expanded.height, label).toBeGreaterThan(collapsed.height);
                    expect(expanded.overflow, label).toBe(0);
                    expectMediaInside(expanded, label);
                    await chevron.click();
                    await expectBrowser(activity, label).toHaveJSProperty("open", false);
                    await expectBrowser(activity.locator(".chat-bubble"), label).toHaveCount(0);
                  } else if (!("excluded" in testCase)) {
                    await pollMargin(
                      (box) => box.open - box.columnWidth * 0.1,
                    ).toBeGreaterThanOrEqual(-1);
                    await pollMargin((box) => box.closed).toBeCloseTo(
                      testCase.id === "user-audio" ? 17 : 0,
                      0,
                    );
                    const mobile = await measure();
                    if (imageSize) {
                      const expectedWidth = Math.min(imageSize.width, mobile.columnWidth * 0.9);
                      expect(mobile, label).toMatchObject({
                        width: expect.closeTo(expectedWidth, 1),
                        height: expect.closeTo(
                          (expectedWidth * imageSize.height) / imageSize.width,
                          1,
                        ),
                      });
                    }
                    expectMediaInside(mobile, label);
                    const toggle = pane.locator(".chat-message-disclosure__toggle");
                    if (await toggle.count()) {
                      await toggle.first().click();
                      const expanded = await measure();
                      expect(expanded.open, label).toBeGreaterThanOrEqual(
                        expanded.columnWidth * 0.1 - 1,
                      );
                      await toggle.first().click();
                    }
                  }
                  await resizeMarginViewport(page, 1440);
                  await pollMargin((restored) =>
                    Math.max(
                      ...(["x", "y", "width", "height"] as const).map((key) =>
                        Math.abs(restored[key] - desktop[key]),
                      ),
                    ),
                  ).toBeLessThanOrEqual(0.5);
                }
              }
            } catch (error) {
              void closeAfterFailure(error).catch(() => {});
              throw error;
            }
          },
          close: async () => {
            await failedClose;
          },
        });
      } finally {
        testContext.signal.removeEventListener("abort", onAbort);
      }
    },
  );
});
