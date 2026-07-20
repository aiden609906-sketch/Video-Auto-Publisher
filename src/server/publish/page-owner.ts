import type { BrowserContext } from "playwright-core";

export async function createWorkflowPage(context: Pick<BrowserContext, "newPage">) {
  const page = await context.newPage();
  await page.bringToFront();
  return page;
}
