import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { Publisher } from "../src/server/publisher.js";
import type { PlatformPost } from "../src/shared/types.js";

function makePost(): PlatformPost {
  return {
    id: "post-1",
    videoId: "video-1",
    platform: "douyin",
    accountId: "default-douyin",
    enabled: true,
    title: "苹果泄密炸翻印度工厂一梦！",
    body: "正文内容应该写到作品简介里",
    hashtags: ["苹果供应链", "印度工厂"],
    status: "ready",
    lastError: null
  };
}

test("douyin fills intro and creates topic chips in the current creator layout", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1710, height: 1278 } });
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <section class="basic-card" style="width: 980px; padding: 48px;">
            <h2>基础信息</h2>
            <div class="row">
              <label>作品描述</label>
              <div class="description-box" style="width: 828px; height: 320px;">
                <input maxlength="30" value="苹果泄密炸翻印度工厂一梦！" style="display:block;width:780px;height:48px;" />
                <div class="intro-wrap">
                  <div class="placeholder">添加作品简介</div>
                  <div id="intro" contenteditable="true" style="width:780px;height:120px;outline:none;"></div>
                </div>
                <div class="topic-row">
                  <button id="add-topic" type="button">#添加话题</button>
                  <button type="button">@好友</button>
                  <div id="topics"></div>
                </div>
              </div>
            </div>
          </section>
          <script>
            const intro = document.querySelector('#intro');
            intro.addEventListener('input', () => {
              document.querySelector('.placeholder').style.display = intro.textContent.trim() ? 'none' : 'block';
            });
            document.querySelector('#add-topic').addEventListener('click', () => {
              if (document.querySelector('#topic-input')) return;
              const input = document.createElement('input');
              input.id = 'topic-input';
              input.placeholder = '输入话题';
              input.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' || !input.value.trim()) return;
                const chip = document.createElement('span');
                chip.className = 'topic-chip';
                chip.textContent = '#' + input.value.trim().replace(/^#/, '');
                document.querySelector('#topics').appendChild(chip);
                input.value = '';
                event.preventDefault();
              });
              document.querySelector('.topic-row').appendChild(input);
              input.focus();
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const filled = await (hooks.tryFillBody as (page: unknown, platform: string, post: PlatformPost, timeoutMs: number) => Promise<boolean>)(
      page,
      "douyin",
      makePost(),
      10_000
    );

    assert.equal(filled, true);
    assert.equal(await page.locator("#intro").innerText(), "正文内容应该写到作品简介里");
    assert.match(await page.locator("#topics").innerText(), /#苹果供应链/);
    assert.match(await page.locator("#topics").innerText(), /#印度工厂/);
  } finally {
    await browser.close();
  }
});
