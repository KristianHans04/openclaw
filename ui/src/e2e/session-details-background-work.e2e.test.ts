import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { SessionProcessSummary } from "../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { expectAttribute, expectCount, expectText } from "./activity-assertions.test-support.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { emptyCronList } from "./session-dashboard.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session Details background work" });
const now = 1_800_000_000_000;
const parentKey = "agent:main:details-background";

type SessionFixture = GatewaySessionRow & { updatedAt: number };

function child(
  slug: string,
  label: string,
  state: Partial<GatewaySessionRow>,
  offsetMs: number,
): SessionFixture {
  const key = `agent:main:subagent:${slug}`;
  return {
    key,
    sessionId: slug,
    kind: "direct",
    classification: "subagent",
    label,
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
    createdAt: now - offsetMs,
    startedAt: now - offsetMs,
    ...state,
    updatedAt: now - 1_000,
  };
}

function running(runId: string, headline: string) {
  return {
    status: "running" as const,
    hasActiveRun: true,
    activeRunIds: [runId],
    observerDigest: {
      runId,
      revision: 1,
      updatedAt: now - 2_000,
      headline,
      health: "on-track" as const,
    },
  };
}

function ended(status: GatewaySessionRow["status"], durationMs: number, offsetMs: number) {
  return {
    status,
    hasActiveRun: false,
    activeRunIds: [],
    runtimeMs: durationMs,
    endedAt: now - offsetMs + durationMs,
  };
}

const children: SessionFixture[] = [
  child("ui-review", "UI review", running("run-ui", "Comparing light and dark Details"), 252_000),
  child("api-audit", "Gateway API audit", running("run-api", "Reading the process owner"), 95_000),
  child("docs-check", "Docs check", ended("done", 61_000, 600_000), 600_000),
  child("lint-pass", "Lint pass", ended("done", 38_000, 540_000), 540_000),
  child("bench", "Cold-load benchmark", ended("failed", 132_000, 480_000), 480_000),
  child("i18n", "Locale baseline", ended("done", 12_000, 700_000), 700_000),
];

function processRow(
  processId: string,
  name: string,
  offset: number,
  tail: string,
  result?: { status: "completed" | "failed"; endedAt: number; exitCode: number },
): SessionProcessSummary {
  return {
    processId,
    instanceId: `${processId}-1`,
    name,
    startedAt: now - offset,
    tail,
    truncated: false,
    status: "running",
    canStop: !result,
    ...result,
  };
}
const processes = [
  processRow("dev-server", "pnpm ui:dev --port 5173", 1_380_000, "ready in 412 ms"),
  processRow("watch-tests", "node scripts/run-vitest.mjs run ui/src/pages/chat", 74_000, ""),
  processRow("build", "pnpm ui:build", 900_000, "built in 53.2s", {
    status: "completed",
    endedAt: now - 846_000,
    exitCode: 0,
  }),
  processRow("typecheck", "pnpm tsgo:ui", 820_000, "error TS2322", {
    status: "failed",
    endedAt: now - 790_000,
    exitCode: 2,
  }),
];

suite.define(() => {
  it("visualizes subagents and background processes in Details", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      await suite.withPage(
        { colorScheme, locale: "en-US", viewport: { width: 1728, height: 1100 } },
        async ({ page }) => {
          await page.clock.setFixedTime(now);
          await page.addInitScript(
            ([key, themeMode]) => localStorage.setItem(key, JSON.stringify({ themeMode })),
            [controlUiBundledSettingsStorageKey(suite.server.baseUrl), colorScheme] as const,
          );
          const parent: SessionFixture = {
            key: parentKey,
            sessionId: "details-background",
            kind: "direct",
            sharingRole: "owner",
            label: "Visualize background work",
            status: "running",
            hasActiveRun: true,
            hasActiveSubagentRun: true,
            activeRunIds: ["parent-run"],
            startedAt: now - 300_000,
            updatedAt: now - 1_000,
            childSessions: children.map((row) => row.key),
          };
          const gateway = await installMockGateway(page, {
            sessionKey: parentKey,
            sessions: [parent, ...children],
            featureMethods: [...defaultControlUiFeatureMethods, "sessions.processes.list"],
            methodResponses: {
              "cron.list": cronListResponseFixture(emptyCronList("details-background")),
              "sessions.processes.list": {
                sessionId: "details-background",
                processes,
                truncated: false,
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
          const pane = page.locator(".chat-pane-cache__pane--active");
          const details = await openChatDetails(pane);
          const subagents = details.locator('[data-details-group="subagents"]');
          const processGroup = details.locator('[data-details-group="processes"]');
          const capture = (content: Locator, elements = [details]) =>
            takeControlUiScreenshotFrame(page, details, [content], {
              animations: "disabled",
              elements,
            });
          await expect
            .poll(() =>
              details
                .locator("[data-details-group] > summary .chat-details__tally-summary")
                .allTextContents(),
            )
            .toEqual(["2 running · 3 done · 1 failed", "2 running · 1 done · 1 failed"]);
          await subagents.locator(".chat-subagent-activity__status").first().waitFor();
          expect(
            await subagents.locator(".chat-subagent-activity__status").allTextContents(),
          ).toEqual(["Comparing light and dark Details", "Reading the process owner", "Failed"]);
          expect(
            await processGroup
              .locator("[data-process-id]")
              .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-process-id"))),
          ).toEqual(["dev-server", "watch-tests", "typecheck"]);
          // Session rows omit plan steps; the live observer stream reports them.
          await gateway.emitGatewayEvent("session.observer", {
            sessionKey: "agent:main:subagent:ui-review",
            sessionId: "ui-review",
            runId: "run-ui",
            revision: 2,
            updatedAt: now,
            health: "on-track",
            headline: "Comparing light and dark Details",
            planProgress: { completed: 2, total: 4 },
          });
          await expectText(subagents.locator(".chat-subagent-activity__steps")).toBe("2/4");

          for (const width of [1728, 1100, 390]) {
            await page.setViewportSize({ width, height: 1100 });
            await expectAttribute(pane.locator(".chat-details"), "role").toBe(
              width === 1728 ? "complementary" : "dialog",
            );
            await openChatDetails(pane);
            const controls = details.locator(
              ".chat-subagent-activity__row, .chat-details__process, .chat-details__more, .chat-details__navigation",
            );
            const rowInsets = await controls.evaluateAll((rows) =>
              rows.map((row) => {
                const bounds = row.getBoundingClientRect();
                const content = Array.from(row.childNodes).flatMap((node) => {
                  if (node instanceof Element) {
                    return [node.getBoundingClientRect()];
                  }
                  if (!node.textContent?.trim()) {
                    return [];
                  }
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  return [range.getBoundingClientRect()];
                });
                return {
                  label: row.className,
                  left: Math.min(...content.map((box) => box.left)) - bounds.left,
                  right: bounds.right - Math.max(...content.map((box) => box.right)),
                  top: Math.min(...content.map((box) => box.top)) - bounds.top,
                  bottom: bounds.bottom - Math.max(...content.map((box) => box.bottom)),
                };
              }),
            );
            for (const inset of rowInsets) {
              expect(Math.min(inset.left, inset.right), inset.label).toBeGreaterThanOrEqual(7.5);
              expect(Math.min(inset.top, inset.bottom), inset.label).toBeGreaterThanOrEqual(5.5);
            }
            const firstRow = subagents.locator("button.chat-subagent-activity__row").first();
            await firstRow.hover({ position: { x: 4, y: 10 } });
            expect(
              await firstRow.evaluate((row) => {
                const bounds = row.getBoundingClientRect();
                return row.contains(document.elementFromPoint(bounds.left + 4, bounds.top + 10));
              }),
            ).toBe(true);
            await capture(firstRow, [details, subagents, processGroup]);
          }
          await page.setViewportSize({ width: 1728, height: 1100 });
          await openChatDetails(pane);
          await subagents.getByRole("button", { name: "Show 3 more" }).click();
          await expectCount(subagents.locator("[data-subagent-session-key]")).toBe(6);
          await processGroup.locator("summary").click();
          await expectAttribute(processGroup, "open").toBeNull();
          expect(await processGroup.locator("summary .chat-details__tally").isVisible()).toBe(true);
          await capture(details);
          await processGroup.locator("summary").click();
          await processGroup.getByRole("button", { name: "All processes" }).click();
          await page.locator("openclaw-chat-processes-panel").first().waitFor();
        },
      );
    }
  });
});
