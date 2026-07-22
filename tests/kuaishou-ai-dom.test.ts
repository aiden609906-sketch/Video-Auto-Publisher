import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { Publisher } from "../src/server/publisher.js";

test("kuaishou AI declaration selects the AI generated option in a real dropdown DOM", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div class="publish-row" style="display:flex;align-items:center;gap:24px;font-size:16px;">
            <div class="label">可见范围</div>
            <select id="unrelated-select" style="width:400px;height:52px;">
              <option value="public">公开</option>
              <option value="ai">内容由AI生成</option>
            </select>
          </div>
          <div contenteditable="true" style="width: 600px; height: 80px;">body</div>
          <div style="height: 600px;"></div>
          <div class="publish-row" style="display:flex;align-items:center;gap:24px;font-size:16px;">
            <div class="label">作者声明</div>
            <div class="ant-select" role="combobox" aria-haspopup="listbox" style="width:820px;height:52px;border:1px solid #ddd;display:flex;align-items:center;padding:0 16px;">
              <div class="ant-select-selector" style="width:100%;display:flex;justify-content:space-between;">
                <span class="ant-select-selection-placeholder">为作品添加补充说明</span>
                <span>⌄</span>
              </div>
            </div>
          </div>
          <script>
            const select = document.querySelector('.ant-select');
            const selector = document.querySelector('.ant-select-selector');
            function openMenu() {
              if (document.querySelector('.ant-select-dropdown')) return;
              const menu = document.createElement('div');
              menu.className = 'ant-select-dropdown';
              menu.setAttribute('role', 'listbox');
              menu.style.cssText = 'position:absolute;left:120px;top:720px;width:400px;background:white;border:1px solid #ddd;';
              const option = document.createElement('div');
              option.className = 'ant-select-item-option';
              option.setAttribute('role', 'option');
              option.textContent = '内容为 AI 生成';
              option.style.cssText = 'padding:12px;';
              option.addEventListener('click', () => {
                selector.textContent = '内容由AI生成';
                menu.remove();
              });
              menu.appendChild(option);
              select.appendChild(menu);
            }
            select.addEventListener('mousedown', openMenu);
            select.addEventListener('click', openMenu);
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    hooks.closeTransientMenus = async () => undefined;
    const selected = await (hooks.trySelectAiDeclaration as (page: unknown, platform: string) => Promise<boolean>)(
      page,
      "kuaishou"
    );

    assert.equal(selected, true);
    assert.equal(await page.locator("#unrelated-select").inputValue(), "public");
    assert.match(await page.locator(".ant-select-selector").innerText(), /AI.*生成/);
  } finally {
    await browser.close();
  }
});

test("kuaishou AI declaration does not succeed when the author row value is unchanged", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div style="height: 600px;"></div>
          <div class="publish-row" style="display:flex;align-items:center;gap:24px;font-size:16px;">
            <div class="label">作者声明</div>
            <div class="ant-select" role="combobox" aria-haspopup="listbox" style="width:820px;height:52px;border:1px solid #ddd;display:flex;align-items:center;padding:0 16px;">
              <div class="ant-select-selector" style="width:100%;">
                <span class="ant-select-selection-placeholder">为作品添加补充说明</span>
              </div>
            </div>
          </div>
          <script>
            const select = document.querySelector('.ant-select');
            function openMenu() {
              if (document.querySelector('.ant-select-dropdown')) return;
              const menu = document.createElement('div');
              menu.className = 'ant-select-dropdown';
              menu.setAttribute('role', 'listbox');
              menu.style.cssText = 'position:absolute;left:120px;top:720px;width:400px;background:white;border:1px solid #ddd;';
              const option = document.createElement('div');
              option.className = 'ant-select-item-option';
              option.setAttribute('role', 'option');
              option.textContent = '内容由 AI 生成';
              option.style.cssText = 'padding:12px;';
              option.addEventListener('click', () => menu.remove());
              menu.appendChild(option);
              select.appendChild(menu);
            }
            select.addEventListener('mousedown', openMenu);
            select.addEventListener('click', openMenu);
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    hooks.closeTransientMenus = async () => undefined;
    hooks.waitForKuaishouAiDeclarationSelected = async () => false;
    const selected = await (hooks.trySelectAiDeclaration as (page: unknown, platform: string) => Promise<boolean>)(
      page,
      "kuaishou"
    );

    assert.equal(selected, false);
    assert.match(await page.locator(".ant-select-selector").innerText(), /为作品添加补充说明/);
  } finally {
    await browser.close();
  }
});

test("bilibili AI declaration opens the creation declaration dropdown and verifies the selected row", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div contenteditable="true" style="width: 600px; height: 80px;">body</div>
          <div style="height: 600px;"></div>
          <div class="publish-row" style="display:flex;align-items:center;gap:24px;font-size:16px;">
            <div class="label">\u521b\u4f5c\u58f0\u660e</div>
            <div class="bcc-select" role="combobox" aria-haspopup="listbox" style="width:540px;height:54px;border:1px solid #c9ccd0;display:flex;align-items:center;justify-content:space-between;padding:0 18px;">
              <span class="bcc-select-placeholder">\u8bf7\u9009\u62e9\u7b26\u5408\u60a8\u89c6\u9891\u5185\u5bb9\u7684\u521b\u4f5c\u58f0\u660e</span>
              <span>v</span>
            </div>
          </div>
          <script>
            const select = document.querySelector('.bcc-select');
            function openMenu() {
              if (document.querySelector('.bcc-select-dropdown')) return;
              const menu = document.createElement('div');
              menu.className = 'bcc-select-dropdown';
              menu.setAttribute('role', 'listbox');
              menu.style.cssText = 'position:absolute;left:160px;top:720px;width:520px;background:white;border:1px solid #ddd;';
              for (const text of ['\u65e0\u9700\u58f0\u660e', '\u5185\u5bb9\u7531AI\u751f\u6210']) {
                const option = document.createElement('div');
                option.className = 'bcc-select-option';
                option.setAttribute('role', 'option');
                option.textContent = text;
                option.style.cssText = 'padding:12px;';
                option.addEventListener('click', () => {
                  select.querySelector('.bcc-select-placeholder').textContent = text;
                  menu.remove();
                });
                menu.appendChild(option);
              }
              document.body.appendChild(menu);
            }
            select.addEventListener('mousedown', openMenu);
            select.addEventListener('click', openMenu);
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    hooks.closeTransientMenus = async () => undefined;
    hooks.saveBilibiliDeclarationScreenshot = async () => undefined;
    const selected = await (hooks.trySelectAiDeclaration as (page: unknown, platform: string) => Promise<boolean>)(
      page,
      "bilibili"
    );

    assert.equal(selected, true);
    assert.match(await page.locator(".bcc-select").innerText(), /AI/);
  } finally {
    await browser.close();
  }
});

test("bilibili AI declaration ignores the artificial-intelligence category below an unselected declaration", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div style="display:flex;align-items:center;gap:24px;height:54px;font-size:16px;">
        <div>创作声明</div>
        <div class="bcc-select" role="combobox" style="width:540px;height:52px;display:flex;align-items:center;">
          请选择符合您视频内容的创作声明
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:24px;height:54px;font-size:16px;">
        <div>分区</div>
        <div class="bcc-select" role="combobox" style="width:260px;height:52px;display:flex;align-items:center;">
          人工智能
        </div>
      </div>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const selected = await (
      hooks.hasBilibiliAiDeclarationSelected as (page: unknown) => Promise<boolean>
    )(page);

    assert.equal(selected, false);
  } finally {
    await browser.close();
  }
});

test("bilibili AI declaration accepts the actual selected text outside generic select wrappers", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div style="display:flex;align-items:center;gap:24px;height:54px;font-size:16px;">
        <div>创作声明</div>
        <div class="bilibili-current-value" style="width:540px;height:52px;display:flex;align-items:center;">
          含AI生成内容
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:24px;height:54px;font-size:16px;">
        <div>分区</div>
        <div class="bcc-select" role="combobox" style="width:260px;height:52px;display:flex;align-items:center;">
          人工智能
        </div>
      </div>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const selected = await (
      hooks.hasBilibiliAiDeclarationSelected as (page: unknown) => Promise<boolean>
    )(page);

    assert.equal(selected, true);
  } finally {
    await browser.close();
  }
});

test("bilibili AI declaration accepts its unique selected value when the page layout separates it from the label box", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div>创作声明</div>
      <div style="height:180px;"></div>
      <div style="display:flex;align-items:center;gap:24px;height:54px;font-size:16px;">
        <div class="bilibili-current-value" style="width:540px;height:52px;display:flex;align-items:center;">
          含AI生成内容
        </div>
      </div>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const selected = await (
      hooks.hasBilibiliAiDeclarationSelected as (page: unknown) => Promise<boolean>
    )(page);

    assert.equal(selected, true);
  } finally {
    await browser.close();
  }
});

test("bilibili AI declaration reads the selected value rendered by an input control", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div style="display:flex;align-items:center;gap:24px;height:54px;font-size:16px;">
        <div>创作声明</div>
        <input class="bilibili-declaration-input" value="含AI生成内容" style="width:540px;height:52px;" />
      </div>
      <div style="display:flex;align-items:center;gap:24px;height:54px;font-size:16px;">
        <div>分区</div>
        <input value="人工智能" style="width:260px;height:52px;" />
      </div>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const selected = await (
      hooks.hasBilibiliAiDeclarationSelected as (page: unknown) => Promise<boolean>
    )(page);

    assert.equal(selected, true);
  } finally {
    await browser.close();
  }
});
