import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../../../src/config/sessions/session-system-prompt-report.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectText, showText } from "./activity-assertions.test-support.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { emptyCronList } from "./session-dashboard.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar context breakdown" });
const sessionKey = "agent:main:context-breakdown";
function workspaceFile(
  name: string,
  rootPath: string,
  kind: "agent-workspace" | "execution-project",
  chars: number,
) {
  return {
    name,
    path: `${rootPath}/${name}`,
    origin: { kind, rootPath },
    missing: false,
    rawChars: chars,
    injectedChars: chars,
    truncated: false,
  };
}
const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 1,
  sessionId: "context-instance",
  sessionKey,
  workspaceDir: "/projects/openclaw",
  systemPrompt: { chars: 40000, projectContextChars: 16000, nonProjectContextChars: 24000 },
  injectedWorkspaceFiles: [
    workspaceFile("AGENTS.md", "/workspace", "agent-workspace", 12000),
    workspaceFile("USER.md", "/workspace", "agent-workspace", 2000),
    workspaceFile("AGENTS.md", "/projects/openclaw", "execution-project", 2000),
  ],
  skills: { promptChars: 8000, entries: [{ name: "code-review", blockChars: 8000 }] },
  tools: {
    listChars: 0,
    schemaChars: 12000,
    entries: [
      { name: "exec", source: "openclaw", summaryChars: 800, schemaChars: 8000 },
      {
        name: "read_docs",
        source: "mcp",
        serverName: "Docs",
        summaryChars: 100,
        schemaChars: 4000,
      },
    ],
    deferred: {
      schemaChars: 30000,
      entries: [{ name: "search_docs", source: "mcp", serverName: "Docs", schemaChars: 30000 }],
    },
  },
};

suite.define(() => {
  it.each([
    { width: 1440, height: 1000, mode: "dark" as const },
    { width: 390, height: 844, mode: "light" as const },
  ])("shows a scoped, non-overlapping breakdown ($width px)", async ({ width, height, mode }) => {
    await suite.withPage({ viewport: { width, height }, colorScheme: mode }, async ({ page }) => {
      const breakdownModule = controlUiE2eBuiltModuleRequest(
        "ui/src/pages/chat/components/chat-context-breakdown.tsx",
      );
      const breakdownRequests: string[] = [];
      page.on("request", (request) => {
        if (breakdownModule.test(request.url())) {
          breakdownRequests.push(request.url());
        }
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [
          {
            key: sessionKey,
            sessionId: "context-instance",
            kind: "direct",
            model: "demo-model",
            modelProvider: "example",
            contextTokens: 100000,
            totalTokens: 50000,
            totalTokensFresh: true,
          },
        ],
        methodResponses: {
          "sessions.compact": { ok: true, compacted: true },
          "sessions.usage": {
            sessions: [{ key: sessionKey, sessionId: "context-instance", contextWeight: report }],
          },
          "cron.list": emptyCronList("empty"),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      await openChatDetails(page);
      const panel = page.locator(".chat-details");
      const context = panel.locator(".chat-details__context");
      const category = (id: string) => context.locator(`[data-context-category="${id}"]`);
      const capture = (content: Locator) =>
        takeControlUiScreenshotFrame(page, panel, [content], {
          elements: [panel],
          animations: "disabled",
        });
      expect(breakdownRequests).toHaveLength(0);
      await context.locator(":scope > summary").click();
      await capture(context);
      await showText(context, "Workspace files");
      expect(breakdownRequests).toHaveLength(1);
      const request = await gateway.waitForRequest("sessions.usage");
      expect(request.params).toMatchObject({
        key: sessionKey,
        includeContextWeight: true,
        limit: 1,
      });
      await expectText(category("system")).toContain("4k");
      await expectText(category("messages")).toContain("37k");
      await context.locator('[data-context-details="files"] > summary').click();
      await context.getByText("AGENTS.md", { exact: true }).first().waitFor();
      expect(await context.getByText("AGENTS.md", { exact: true }).count()).toBe(2);
      for (const text of [
        "Agent workspace",
        "Project · openclaw",
        "/projects/openclaw/AGENTS.md",
        "Available on demand",
      ]) {
        await showText(context, text);
      }
      await context.getByRole("button", { name: "Compact session", exact: true }).waitFor();
      await capture(context.getByText("AGENTS.md", { exact: true }).first());
      expect(await context.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await context.locator('[data-context-details="files"] > summary').click();
      await context.locator('[data-context-details="tools"] > summary').click();
      await showText(context, "System tools");
      await showText(context.locator('[data-context-details="tools"]'), "MCP tools · Docs");
      await context.locator('[data-context-details="deferred"] > summary').click();
      await showText(context, "search_docs");
      expect(await category("tools").textContent()).toContain("3k");
      if (width > 900) {
        const draft = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox > textarea',
        );
        await draft.fill("Keep this unsent draft");
        await context.getByRole("button", { name: "Compact session", exact: true }).click();
        const compact = await gateway.waitForRequest("sessions.compact");
        expect(compact.params).toMatchObject({ key: sessionKey });
        expect(await draft.inputValue()).toBe("Keep this unsent draft");
        await gateway.setMethodResponse("sessions.usage", { sessions: [] });
        await context.getByRole("button", { name: "Refresh", exact: true }).click();
        await showText(context, "No matching context report.", false);
        await capture(context);
        const nativeReport: SessionSystemPromptReport = {
          ...report,
          injectedWorkspaceFiles: [
            {
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              missing: false,
              rawChars: 16000,
              injectionStatus: "native_unverified",
              injectedChars: null,
              truncated: null,
            },
          ],
        };
        await gateway.setMethodResponse("sessions.usage", {
          sessions: [
            { key: sessionKey, sessionId: "context-instance", contextWeight: nativeReport },
          ],
        });
        await context.getByRole("button", { name: "Refresh", exact: true }).click();
        await showText(context, "Workspace files");
        await context.locator('[data-context-details="files"] > summary').click();
        await showText(context, "Unverified");
        await expectText(category("messages")).toContain("—");
        await capture(context.getByText("Unverified", { exact: true }));
      }
    });
  });
});
