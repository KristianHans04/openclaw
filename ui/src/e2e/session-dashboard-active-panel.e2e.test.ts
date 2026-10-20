import { expect, it } from "vitest";
import type { UiSettings } from "../app/settings-contract.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { board } from "./chat-layout-fixtures.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard side-panel selection",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard";
const boardSnapshot = board(sessionKey);

suite.define(() => {
  it.each([
    { main: "Chat", side: "Side chat", view: "split" },
    { main: "Chat", side: "Files", view: "split" },
    { main: "Dashboard", side: "Side chat", view: "split" },
    { main: "Dashboard", side: "Files", view: "split" },
    { main: "Chat", side: "Files", view: "closed side" },
    { main: "Chat", side: "Files", view: "focused Chat" },
  ])(
    "retains $main main and $side in $view after dashboard reload",
    async ({ main, side, view }) => {
      await suite.withPage({ viewport: { height: 900, width: 1440 } }, async ({ page }) => {
        await installMockGateway(page, {
          sessionKey,
          sessions: [
            {
              key: sessionKey,
              agentId: "main",
              sessionId: "dashboard-active-panel",
              kind: "direct",
              updatedAt: 1,
              boardFace: "dashboard",
              boardPresentation: "split",
            },
          ],
          featureMethods: ["board.get", "chat.metadata", "chat.startup"],
          methodResponses: {
            "board.get": boardSnapshot,
            "sessions.companion.state": {
              exchanges: [
                {
                  question: "What should I check?",
                  answer: "Keep this side conversation visible.",
                  ts: 1_000,
                },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        await page.locator(".board-session-surface").waitFor();
        if (main === "Dashboard") {
          await selectChatLayoutAction(page, /^Swap /);
        }
        const mainPanel = page.locator(
          main === "Dashboard"
            ? '[data-panel-slot="dashboard"][data-region="main"]'
            : '.sidebar-region__primary[data-region="main"]',
        );
        await mainPanel.waitFor();
        await openChatSidePanelType(page, side);
        const selectedTab = page.getByRole("tab", { name: side, exact: true });
        const answer = page
          .locator("openclaw-chat-session-rail")
          .getByText("Keep this side conversation visible.", { exact: true });
        const expectSelection = async () => {
          await selectedTab.waitFor();
          await expect.poll(() => selectedTab.getAttribute("aria-selected")).toBe("true");
          if (side === "Side chat") {
            await answer.waitFor();
          }
        };
        await expectSelection();
        if (view === "closed side") {
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        } else if (view === "focused Chat") {
          await selectChatLayoutAction(page, "Focus");
        }

        await page.reload();
        await mainPanel.waitFor();
        if (view === "closed side") {
          await expect.poll(() => page.locator(".sidebar-region--open").count()).toBe(0);
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        } else if (view === "focused Chat") {
          await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
          await selectChatLayoutAction(page, "Restore split");
        }
        await expectSelection();
      });
    },
  );

  it("restores the saved main and side selection on ordinary dashboard revisits", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storageKey }) => {
          const settings: Partial<UiSettings> = JSON.parse(
            localStorage.getItem(storageKey) ?? "{}",
          );
          settings.boardSessionViews = { [key]: { activeTabId: "main" } };
          const layouts = (settings.sidebarSessionLayouts ??= {});
          layouts[key] ??= {
            columns: [
              {
                id: "side-panel-column",
                side: "right",
                panels: (["terminal", "dashboard", "conversation"] as const).map((slot) => ({
                  id: slot,
                  slot,
                })),
                activePanelId: "dashboard",
                height: 360,
                width: 480,
              },
            ],
            dock: "right",
            mainPanelId: "terminal",
            open: true,
          };
          localStorage.setItem(storageKey, JSON.stringify(settings));
        },
        { key: sessionKey, storageKey: settingsKey },
      );
      await installMockGateway(page, {
        sessionKey,
        featureMethods: ["board.get", "chat.metadata", "chat.startup", "terminal.open"],
        methodResponses: { "board.get": boardSnapshot },
        terminalEnabled: true,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      await page.locator(".board-session-surface").waitFor();
      const terminal = page.locator('[data-panel-slot="terminal"][data-region="main"]');
      const dashboard = page.getByRole("tab", { name: "Dashboard", exact: true });
      await expect.poll(() => dashboard.getAttribute("aria-selected")).toBe("true");
      await terminal.waitFor();
      await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);

      await page.reload();
      await page.locator(".board-session-surface").waitFor();
      await expect.poll(() => dashboard.getAttribute("aria-selected")).toBe("true");
      await terminal.waitFor();
    });
  });
});
