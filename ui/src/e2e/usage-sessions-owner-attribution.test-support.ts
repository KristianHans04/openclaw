import type { Page } from "playwright";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";

export async function dragTimelineRange(page: Page, fraction: number) {
  const panel = page.locator(".session-detail-panel");
  const handle = panel.locator(".chart-handle-right");
  await handle.scrollIntoViewIfNeeded();
  const handleBox = await handle.boundingBox();
  const chartBox = await panel.locator(".timeseries-svg").boundingBox();
  if (!handleBox || !chartBox) {
    throw new Error("Timeline drag handles did not render");
  }
  const y = handleBox.y + handleBox.height / 2;
  const x = chartBox.x + (chartBox.width * (30 + 366 * fraction)) / 400;
  await page.mouse.move(handleBox.x + handleBox.width / 2, y);
  await page.mouse.down();
  const move = () => page.mouse.move(x, y, { steps: 8 });
  await move();
  return move;
}

export async function requestGateway<T>(
  page: Page,
  methodName: string,
  requestParams: Record<string, unknown>,
) {
  return await evaluateControlUiContext(
    page,
    async (context, { method, params }) => {
      const client = context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Usage proof has no connected Gateway client");
      }
      return await client.request<T>(method, params);
    },
    { method: methodName, params: requestParams },
  );
}
