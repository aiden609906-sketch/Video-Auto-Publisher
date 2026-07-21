import type { BrowserContext, Page } from "playwright-core";

export async function createWorkflowPage(
  context: Pick<BrowserContext, "newPage" | "pages">,
  targetUrl?: string
) {
  if (!targetUrl) {
    const page = await context.newPage();
    await page.bringToFront();
    return page;
  }

  const targetOrigin = new URL(targetUrl).origin;
  const existing = context.pages();
  const pageUrl = (page: Page) => typeof page.url === "function" ? page.url() : "";
  const platformPages = existing.filter((page) => {
    try {
      return new URL(pageUrl(page)).origin === targetOrigin;
    } catch {
      return false;
    }
  });
  const blankPages = existing.filter((page) => pageUrl(page) === "about:blank");
  const page = platformPages.at(-1) || blankPages[0] || await context.newPage();
  const stalePages = [...platformPages, ...blankPages].filter((candidate) => candidate !== page);
  await Promise.all(stalePages.map((candidate) => candidate.close().catch(() => undefined)));
  await page.bringToFront();
  return page;
}
