import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Client-side video compression" });
const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url));
// ISO BMFF padding crosses the limit while preserving real samples and quick encoding.
const oversized = Buffer.concat([video, Buffer.alloc(256 * 1024)]);
const limit = 128 * 1024;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const upload = (page: Page, name: string, buffer = oversized) =>
  page
    .locator(".agent-chat__file-input")
    .first()
    .setInputFiles({ name, mimeType: "video/mp4", buffer });

suite.define(() => {
  it.each([
    { theme: "dark", viewport: { width: 1280, height: 900 } },
    { theme: "light", viewport: { width: 1280, height: 900 } },
    { theme: "dark", viewport: { width: 390, height: 844 } },
    { theme: "light", viewport: { width: 390, height: 844 } },
  ] as const)(
    "keeps the compression offer compact and aligned in $theme at $viewport.width",
    ({ theme, viewport }) =>
      suite.withPage({ viewport, colorScheme: theme }, async ({ page }) => {
        await installMockGateway(page, {
          attachmentMaxBytes: limit,
          agentModel: "demo/model",
          models: [{ id: "model", name: "Demo", provider: "demo" }],
          historyMessages: [{ role: "assistant", content: "Review these recordings." }],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Compare the two recordings.");
        await upload(page, "clip.mp4", video);
        const normal = page
          .locator(".chat-attachment-thumb")
          .filter({ has: button(page, "Remove clip.mp4") });
        await normal.locator(".chat-attachment-file").waitFor();
        await upload(page, "presentation.mp4");
        const offer = page
          .locator(".chat-attachment-thumb")
          .filter({ has: button(page, "Compress to fit") });
        await offer.waitFor();
        if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
          const rail = page.locator(".chat-attachments-preview");
          const frame = await takeControlUiScreenshotFrame(page, rail, [normal, offer], {
            elements: [rail],
            animations: "disabled",
          });
          const prefix = path.join(suite.artifactDir, `offer-${theme}-${viewport.width}`);
          writeFileSync(`${prefix}.png`, frame.png);
          writeFileSync(`${prefix}-detail.png`, frame.elements[0]!.png);
        }
        const normalBox = (await normal.boundingBox())!;
        const offerBox = (await offer.boundingBox())!;
        expect(normalBox.height).toBe(56);
        expect(offerBox.height).toBe(normalBox.height);
        expect(offerBox.width).toBeLessThan(normalBox.width);
        expect(offerBox.y).toBe(normalBox.y);
        const preview = offer.locator(".chat-attachment-file__preview");
        const previewBox = (await preview.boundingBox())!;
        const normalPreviewBox = (await normal
          .locator(".chat-attachment-file__preview")
          .boundingBox())!;
        expect(previewBox.width).toBeLessThan(normalPreviewBox.width);
        expect(previewBox.height).toBe(previewBox.width);
        expect(
          await preview.evaluate((element) => getComputedStyle(element).backgroundColor),
        ).not.toBe("rgba(0, 0, 0, 0)");
        const play = preview.locator("svg");
        expect(await play.evaluate((element) => getComputedStyle(element).fill)).toBe(
          await play.evaluate((element) => getComputedStyle(element).color),
        );
        expect(await play.evaluate((element) => getComputedStyle(element).stroke)).toBe("none");
        const action = button(page, "Compress to fit");
        const icon = (await action.locator("svg").boundingBox())!;
        expect(icon.width).toBeGreaterThanOrEqual(12);
        expect(icon.width).toBeLessThanOrEqual(14);
        expect(icon.height).toBe(icon.width);
        expect(
          await action.locator("svg").evaluate((element) => getComputedStyle(element).color),
        ).toBe(await action.evaluate((element) => getComputedStyle(element).color));
        expect(
          await action.evaluate((element) => getComputedStyle(element).textDecorationLine),
        ).toBe("none");
        expect(await action.evaluate((element) => getComputedStyle(element).color)).toBe(
          await offer.evaluate((element) => {
            const probe = document.createElement("span");
            probe.style.color = "var(--accent)";
            element.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          }),
        );
        await button(page, "Remove presentation.mp4").click();
        expect(await normal.count()).toBe(1);
      }),
  );

  it("loads the encoder only after consent and sends a playable bounded copy", () =>
    suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      const encoderRequests = () =>
        requests.filter((url) => /chat-attachment-video|mediabunny/u.test(url));
      const gateway = await installMockGateway(page, { attachmentMaxBytes: limit });
      await page.goto(suite.server.baseUrl + "chat");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const send = button(page, "Send message");
      await composer.fill("A synthetic screen recording.");
      await upload(page, "small.mp4", video);
      await button(page, "Remove small.mp4").waitFor();
      expect(encoderRequests()).toEqual([]);
      await button(page, "Remove small.mp4").click();
      await upload(page, "screen.mp4");
      const compress = button(page, "Compress to fit");
      await compress.waitFor();
      expect(await send.isDisabled()).toBe(true);
      expect(encoderRequests()).toEqual([]);
      await compress.click();
      const draft = "Editable during preparation.";
      await composer.fill(draft);
      await composer.press("End");
      await composer.press("!");
      expect(await composer.inputValue()).toBe(draft + "!");
      const ime = await page.context().newCDPSession(page);
      await ime.send("Input.imeSetComposition", {
        text: "入力",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await page.locator(".chat-attachment-thumb--preparation").waitFor({ state: "detached" });
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await composer.inputValue()).toBe(draft + "!入力");
      await ime.send("Input.insertText", { text: "入力" });
      await ime.detach();
      expect(encoderRequests().length).toBeGreaterThan(0);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      await send.click();
      const request = await gateway.waitForRequest("chat.send");
      const params = request.params as {
        attachments: Array<{ content: string; mimeType: string; fileName: string }>;
      };
      const output = params.attachments[0]!;
      expect(output.fileName).toMatch(/^screen-compressed\.(mp4|webm)$/u);
      const bytes = Buffer.from(output.content, "base64");
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThanOrEqual(limit);
      const playback = await page.evaluate(async (attachment) => {
        const decoded = Uint8Array.from(atob(attachment.content), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([decoded], { type: attachment.mimeType }));
        const player = document.createElement("video");
        player.muted = true;
        player.src = url;
        try {
          await player.play();
          const { videoWidth: width, videoHeight: height, duration } = player;
          return { width, height, duration };
        } finally {
          player.pause();
          player.removeAttribute("src");
          player.load();
          URL.revokeObjectURL(url);
        }
      }, output);
      expect(playback).toMatchObject({ width: 320, height: 180 });
      expect(playback.duration).toBeCloseTo(1, 1);
    }));

  it("explains invalid media and unavailable browser codecs without sending", () =>
    suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page, context }) => {
      const gateway = await installMockGateway(page, { attachmentMaxBytes: limit });
      // Remove WebCodecs from the real worker before its script is cached.
      await context.route("**/chat-attachment-video.worker-*.js", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: "globalThis.VideoEncoder = undefined;\n" + (await response.text()),
        });
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page.locator(".agent-chat__composer-combobox textarea").fill("Keep this draft.");
      const status = page.locator(".chat-attachment-thumb").getByRole("status");
      const expectError = async (error: string) => {
        await status.filter({ hasText: error }).waitFor();
        await page.getByRole("alert").getByText(error, { exact: true }).waitFor();
      };
      await upload(page, "invalid.mp4", Buffer.alloc(256 * 1024));
      await button(page, "Compress to fit").click();
      const invalidError = "Could not compress this video. Try again or choose a smaller file.";
      await expectError(invalidError);
      await button(page, "Remove invalid.mp4").click();
      await upload(page, "unsupported.mp4");
      await button(page, "Compress to fit").click();
      const unsupportedError =
        "This browser cannot compress this video with its audio. Try another browser or a smaller file.";
      await expectError(unsupportedError);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      expect(await button(page, "Send message").isEnabled()).toBe(true);
    }));

  it("offers the same cancelable preparation in New Session", () =>
    suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      await installMockGateway(page, { attachmentMaxBytes: limit });
      await page.goto(suite.server.baseUrl + "new");
      await upload(page, "screen.mp4");
      await button(page, "Compress to fit").click();
      const preparing = page.locator('.chat-attachment-thumb[aria-busy="true"]');
      await preparing.waitFor();
      expect((await preparing.boundingBox())?.height).toBe(56);
      await button(page, "Remove screen.mp4").click();
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
    }));
});
