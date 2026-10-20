import photon from "@silvia-odwyer/photon-node";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectAttribute } from "./activity-assertions.test-support.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { emptyCronList } from "./session-dashboard.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session context meter colors" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewports = captureProof
  ? [
      { width: 1440, height: 900 },
      { width: 1366, height: 768 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]
  : [{ width: 1440, height: 900 }];

suite.define(() => {
  it.each(viewports)(
    "paints context stages as the session updates ($width px)",
    async (viewport) => {
      await suite.withPage(
        { colorScheme: viewport.width === 768 ? "light" : "dark", viewport },
        async ({ page }) => {
          const sessionKey = "agent:main:context-meter";
          const session = {
            key: sessionKey,
            kind: "direct" as const,
            contextTokens: 100_000,
            totalTokens: 14_000,
            totalTokensFresh: true,
            updatedAt: 1,
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [session],
            methodResponses: {
              "cron.list": emptyCronList("context-meter-empty"),
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await gateway.waitForRequest("chat.startup");
          const context = page.locator(".chat-details .chat-details__context");
          const meter = context.locator("meter");
          await openChatDetails(page);
          await meter.waitFor();

          for (const [percent, fresh, token] of [
            [14, true, "--ok"],
            [64, true, "--ok"],
            [65, true, "--warn"],
            [84, true, "--warn"],
            [85, true, "--danger"],
            [100, true, "--danger"],
            [95, false, "--muted"],
            [14, true, "--ok"],
          ] as const) {
            Object.assign(session, {
              totalTokens: percent * 1000,
              totalTokensFresh: fresh,
              updatedAt: session.updatedAt + 1,
            });
            await gateway.emitGatewayEvent("sessions.changed", {
              ...session,
              sessionKey,
              reason: "patch",
            });
            await expectAttribute(meter, "aria-valuetext").toContain(
              `${fresh ? "" : "~"}${percent}%`,
            );
            await expectAttribute(meter, "value").toBe(String(percent));
            const meterBounds = await meter.boundingBox();
            expect([meterBounds, await context.boundingBox()]).not.toContain(null);
            // Playwright flushes painting; raw CDP can return the previous meter frame.
            const screenshot = await page.screenshot({ animations: "disabled" });
            const frame = photon.PhotonImage.new_from_byteslice(screenshot);
            const bounds = meterBounds!;
            const image = photon.crop(
              frame,
              Math.floor(bounds.x),
              Math.floor(bounds.y),
              Math.ceil(bounds.x + bounds.width),
              Math.ceil(bounds.y + bounds.height),
            );
            frame.free();
            const expected = await meter.evaluate((element, property) => {
              const canvas = document.createElement("canvas");
              const drawing = canvas.getContext("2d")!;
              drawing.fillStyle = getComputedStyle(element).getPropertyValue(property).trim();
              drawing.fillRect(0, 0, 1, 1);
              return [...drawing.getImageData(0, 0, 1, 1).data].slice(0, 3);
            }, token);
            // Assert shadow-DOM fill pixels, not an ignored host style.
            try {
              const pixels = image.get_raw_pixels();
              const matches = pixels.some(
                (_, offset) =>
                  offset % 4 === 0 &&
                  expected.every(
                    (channel, index) => Math.abs(channel - pixels[offset + index]!) <= 1,
                  ),
              );
              expect
                .soft(matches, `${percent}% ${fresh ? "fresh" : "stale"} fill uses ${token}`)
                .toBe(true);
            } finally {
              image.free();
            }
          }
        },
      );
    },
  );
});
