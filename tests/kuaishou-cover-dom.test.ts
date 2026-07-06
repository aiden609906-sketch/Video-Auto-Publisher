import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { Publisher } from "../src/server/publisher.js";

test("kuaishou cover dialog detection includes the upload-cover tab", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div class="semi-modal-content" style="display:block;width:900px;height:520px;">
            <div class="tabs">
              <span>\u4e0a\u4f20\u5c01\u9762</span>
            </div>
            <div style="height:360px;">\u5c01\u9762\u56fe\u7247\u9884\u89c8</div>
            <div class="semi-modal-footer">
              <button type="button">\u786e\u8ba4</button>
              <button type="button">\u53bb\u7f16\u8f91</button>
            </div>
          </div>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const visible = await (hooks.hasKuaishouCoverDialog as (page: unknown) => Promise<boolean>)(page);

    assert.equal(visible, true);
  } finally {
    await browser.close();
  }
});

test("kuaishou cover confirmation clicks the upload-cover modal confirm button", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span>\u5c01\u9762\u622a\u53d6</span>
                <span>\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <div style="height:360px;text-align:center;">
                <img src="data:image/png;base64,iVBORw0KGgo=" style="display:block;width:420px;height:240px;" />
              </div>
            </div>
            <div class="semi-modal-footer" style="position:absolute;right:32px;bottom:24px;display:flex;gap:16px;">
              <div class="semi-button" role="button" style="width:88px;height:40px;line-height:40px;text-align:center;border:1px solid #ddd;">\u786e\u8ba4</div>
              <div class="semi-button" role="button" style="width:88px;height:40px;line-height:40px;text-align:center;background:#ff2d55;color:white;">\u53bb\u7f16\u8f91</div>
            </div>
          </div>
          <script>
            document.querySelector('.semi-button').addEventListener('click', () => {
              document.querySelector('.semi-modal').remove();
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const confirmed = await (hooks.confirmKuaishouCoverDialog as (page: unknown) => Promise<boolean>)(page);

    assert.equal(confirmed, true);
    assert.equal(await (hooks.hasKuaishouCoverDialog as (page: unknown) => Promise<boolean>)(page), false);
  } finally {
    await browser.close();
  }
});

test("kuaishou cover confirmation does not click confirm without an uploaded image preview", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div id="clicks">0</div>
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span>\u5c01\u9762\u622a\u53d6</span>
                <span>\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <canvas width="900" height="360" style="display:block;width:900px;height:360px;"></canvas>
            </div>
            <div class="semi-modal-footer" style="position:absolute;right:32px;bottom:24px;display:flex;gap:16px;">
              <div id="confirm" class="semi-button" role="button" style="width:88px;height:40px;line-height:40px;text-align:center;border:1px solid #ddd;">\u786e\u8ba4</div>
              <div class="semi-button" role="button" style="width:88px;height:40px;line-height:40px;text-align:center;background:#ff2d55;color:white;">\u53bb\u7f16\u8f91</div>
            </div>
          </div>
          <script>
            document.querySelector('#confirm').addEventListener('click', () => {
              const clicks = document.querySelector('#clicks');
              clicks.textContent = String(Number(clicks.textContent) + 1);
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const confirmed = await (hooks.confirmKuaishouCoverDialog as (page: unknown) => Promise<boolean>)(page);

    assert.equal(confirmed, false);
    assert.equal(await page.locator("#clicks").innerText(), "0");
  } finally {
    await browser.close();
  }
});

test("kuaishou upload preview detection ignores capture-tab canvas frames", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span>\u5c01\u9762\u622a\u53d6</span>
                <span>\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <canvas width="900" height="360" style="display:block;width:900px;height:360px;"></canvas>
            </div>
            <div class="semi-modal-footer">
              <button type="button">\u786e\u8ba4</button>
            </div>
          </div>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const hasPreview = await (hooks.waitForKuaishouCoverUploadPreview as (page: unknown, timeoutMs: number) => Promise<boolean>)(
      page,
      1
    );

    assert.equal(hasPreview, false);
  } finally {
    await browser.close();
  }
});

test("kuaishou upload preview detection accepts the clear-upload marker after file upload", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span>\u5c01\u9762\u622a\u53d6</span>
                <span>\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <div style="height:360px;padding:24px;">
                <canvas width="900" height="360" style="display:block;width:900px;height:360px;"></canvas>
                <a>\u6e05\u7a7a \u4e0a\u4f20</a>
              </div>
            </div>
          </div>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const signature = await (hooks.kuaishouCoverDialogPreviewSignature as (page: unknown) => Promise<string | null>)(page);

    assert.equal(signature, "kuaishou-uploaded-cover-marker");
  } finally {
    await browser.close();
  }
});

test("kuaishou upload-cover tab click reveals the image input", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span>\u5c01\u9762\u622a\u53d6</span>
                <span id="upload-tab">\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <canvas width="900" height="360" style="display:block;width:900px;height:360px;"></canvas>
              <div id="upload-panel" style="display:none;">
                <input type="file" accept="image/png,image/jpeg" />
              </div>
            </div>
          </div>
          <script>
            document.querySelector('#upload-tab').addEventListener('click', () => {
              document.querySelector('#upload-panel').style.display = 'block';
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const clicked = await (hooks.clickKuaishouUploadCoverTab as (page: unknown, timeoutMs: number) => Promise<boolean>)(
      page,
      1_000
    );

    assert.equal(clicked, true);
    assert.equal(await page.locator('input[type="file"][accept*="image"]').isVisible(), true);
  } finally {
    await browser.close();
  }
});

test("kuaishou upload-cover tab click works when the tab is outside modal content", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div role="dialog" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
              <span>\u5c01\u9762\u622a\u53d6</span>
              <span id="upload-tab">\u4e0a\u4f20\u5c01\u9762</span>
            </div>
            <div class="semi-modal-content" style="height:520px;">
              <canvas width="900" height="360" style="display:block;width:900px;height:360px;"></canvas>
              <div id="upload-panel" style="display:none;">
                <input type="file" accept="image/png,image/jpeg" />
              </div>
            </div>
          </div>
          <script>
            document.querySelector('#upload-tab').addEventListener('click', () => {
              document.querySelector('#upload-panel').style.display = 'block';
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const clicked = await (hooks.clickKuaishouUploadCoverTab as (page: unknown) => Promise<boolean>)(page);

    assert.equal(clicked, true);
    assert.equal(await page.locator('input[type="file"][accept*="image"]').isVisible(), true);
  } finally {
    await browser.close();
  }
});

test("kuaishou upload-cover tab click targets the right half when capture and upload labels share one element", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body data-active-tab="capture">
          <div class="ant-modal" role="document" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="ant-modal-content" style="height:520px;">
              <div class="header" style="padding:24px 32px;font-size:18px;">
                <span id="merged-tabs" style="display:inline-block;width:192px;">\u5c01\u9762\u622a\u53d6\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <canvas width="900" height="360" style="display:block;width:900px;height:360px;"></canvas>
            </div>
          </div>
          <script>
            document.querySelector('#merged-tabs').addEventListener('click', (event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              document.body.dataset.activeTab = event.clientX - rect.left > rect.width / 2 ? 'upload' : 'capture';
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const clicked = await (hooks.clickKuaishouUploadCoverTab as (page: unknown) => Promise<boolean>)(page);

    assert.equal(clicked, true);
    assert.equal(await page.locator("body").getAttribute("data-active-tab"), "upload");
  } finally {
    await browser.close();
  }
});

test("kuaishou cover upload leaves the dialog open when upload cannot complete", async () => {
  const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
  const calls: string[] = [];
  const page = {
    waitForTimeout: async () => undefined
  };

  hooks.scrollCoverSectionIntoView = async () => undefined;
  hooks.kuaishouMainCoverSignature = async () => "before";
  hooks.openKuaishouCoverDialog = async () => true;
  hooks.uploadKuaishouCoverFile = async () => false;
  hooks.saveKuaishouCoverDebugSnapshot = async () => undefined;
  hooks.closeKuaishouCoverDialog = async () => {
    calls.push("close-cover-dialog");
  };

  const uploaded = await (hooks.uploadKuaishouCover as (page: unknown, coverPath: string) => Promise<boolean>)(
    page,
    "cover.png"
  );

  assert.equal(uploaded, false);
  assert.deepEqual(calls, []);
});

test("kuaishou cover upload uses filechooser when upload-cover tab opens a native picker", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span>\u5c01\u9762\u622a\u53d6</span>
                <span id="upload-tab">\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <input id="cover-input" type="file" accept="image/png,image/jpeg" style="display:none;" />
            </div>
          </div>
          <script>
            document.querySelector('#upload-tab').addEventListener('click', () => {
              document.querySelector('#cover-input').click();
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const uploaded = await (hooks.uploadKuaishouCoverFile as (page: unknown, coverPath: string) => Promise<boolean>)(
      page,
      "package.json"
    );

    assert.equal(uploaded, true);
    assert.equal(await page.locator("#cover-input").evaluate((input) => (input as HTMLInputElement).files?.length), 1);
  } finally {
    await browser.close();
  }
});

test("kuaishou cover upload waits for a delayed upload-cover filechooser", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span>\u5c01\u9762\u622a\u53d6</span>
                <span id="upload-tab">\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <input id="cover-input" type="file" accept="image/png,image/jpeg" style="display:none;" />
            </div>
          </div>
          <script>
            document.querySelector('#upload-tab').addEventListener('click', () => {
              setTimeout(() => document.querySelector('#cover-input').click(), 4500);
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const uploaded = await (hooks.uploadKuaishouCoverFile as (page: unknown, coverPath: string) => Promise<boolean>)(
      page,
      "package.json"
    );

    assert.equal(uploaded, true);
    assert.equal(await page.locator("#cover-input").evaluate((input) => (input as HTMLInputElement).files?.length), 1);
  } finally {
    await browser.close();
  }
});

test("kuaishou cover upload clicks only the upload panel trigger when the tab does not open a picker", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body data-capture-clicks="0">
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span id="capture-tab">\u5c01\u9762\u622a\u53d6</span>
                <span id="upload-tab">\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <div id="capture-panel">
                <canvas width="900" height="260" style="display:block;width:900px;height:260px;"></canvas>
              </div>
              <div id="upload-panel" style="display:none;padding-top:120px;text-align:center;">
                <button id="upload-trigger" type="button">\u4e0a\u4f20\u56fe\u7247</button>
                <input id="cover-input" type="file" accept="image/png,image/jpeg" style="display:none;" />
              </div>
            </div>
          </div>
          <script>
            document.querySelector('#capture-tab').addEventListener('click', () => {
              document.body.dataset.captureClicks = String(Number(document.body.dataset.captureClicks || '0') + 1);
            });
            document.querySelector('#upload-tab').addEventListener('click', () => {
              document.querySelector('#capture-panel').style.display = 'none';
              document.querySelector('#upload-panel').style.display = 'block';
              document.body.dataset.activeTab = 'upload';
            });
            document.querySelector('#upload-trigger').addEventListener('click', () => {
              document.body.dataset.panelClicks = String(Number(document.body.dataset.panelClicks || '0') + 1);
              document.querySelector('#cover-input').click();
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const uploaded = await (hooks.uploadKuaishouCoverFile as (page: unknown, coverPath: string) => Promise<boolean>)(
      page,
      "package.json"
    );

    assert.equal(uploaded, true);
    assert.equal(await page.locator("body").getAttribute("data-active-tab"), "upload");
    assert.equal(await page.locator("body").getAttribute("data-panel-clicks"), "1");
    assert.equal(await page.locator("#cover-input").evaluate((input) => (input as HTMLInputElement).files?.length), 1);
    assert.equal(await page.locator("body").getAttribute("data-capture-clicks"), "0");
  } finally {
    await browser.close();
  }
});

test("kuaishou cover upload does not write to an inactive hidden image input", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span>\u5c01\u9762\u622a\u53d6</span>
                <span id="upload-tab">\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <canvas width="900" height="360" style="display:block;width:900px;height:360px;"></canvas>
              <input id="stale-cover-input" type="file" accept="image/png,image/jpeg" style="display:none;" />
            </div>
          </div>
          <script>
            document.querySelector('#upload-tab').addEventListener('click', () => {
              document.body.dataset.uploadTabClicked = 'true';
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const uploaded = await (hooks.uploadKuaishouCoverFile as (page: unknown, coverPath: string) => Promise<boolean>)(
      page,
      "package.json"
    );

    assert.equal(await page.locator("body").getAttribute("data-upload-tab-clicked"), "true");
    assert.equal(uploaded, false);
    assert.equal(await page.locator("#stale-cover-input").evaluate((input) => (input as HTMLInputElement).files?.length), 0);
  } finally {
    await browser.close();
  }
});

test("kuaishou cover upload does not switch back to capture after selecting upload-cover tab", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body data-capture-clicks="0">
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <div id="tabs" style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span id="capture-tab">\u5c01\u9762\u622a\u53d6</span>
                <span id="upload-tab">\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <canvas width="900" height="360" style="display:block;width:900px;height:360px;"></canvas>
              <input id="stale-cover-input" type="file" accept="image/png,image/jpeg" style="display:none;" />
            </div>
          </div>
          <script>
            document.querySelector('#capture-tab').addEventListener('click', () => {
              document.body.dataset.captureClicks = String(Number(document.body.dataset.captureClicks || '0') + 1);
            });
            document.querySelector('#upload-tab').addEventListener('click', () => {
              document.body.dataset.activeTab = 'upload';
            });
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    const uploaded = await (hooks.uploadKuaishouCoverFile as (page: unknown, coverPath: string) => Promise<boolean>)(
      page,
      "package.json"
    );

    assert.equal(uploaded, false);
    assert.equal(await page.locator("body").getAttribute("data-active-tab"), "upload");
    assert.equal(await page.locator("body").getAttribute("data-capture-clicks"), "0");
  } finally {
    await browser.close();
  }
});

test("kuaishou full cover upload flow closes modal after filechooser upload and confirm", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <section style="display:flex;gap:16px;align-items:flex-start;">
            <div>\u5c01\u9762\u8bbe\u7f6e</div>
            <div id="main-cover" style="width:260px;height:120px;background-image:url(before.png);background-size:cover;"></div>
          </section>
          <div class="semi-modal" style="display:block;position:fixed;inset:80px 120px;background:white;">
            <div class="semi-modal-content" style="height:520px;">
              <button id="close" style="position:absolute;right:24px;top:18px;">\u00d7</button>
              <div style="display:flex;gap:40px;padding:24px 32px;font-size:18px;">
                <span>\u5c01\u9762\u622a\u53d6</span>
                <span id="upload-tab">\u4e0a\u4f20\u5c01\u9762</span>
              </div>
              <canvas width="900" height="360" style="display:block;width:900px;height:360px;"></canvas>
              <input id="cover-input" type="file" accept="image/png,image/jpeg" style="display:none;" />
              <div id="preview-host" style="display:none;height:320px;padding:24px;">
                <img id="uploaded-preview" style="display:block;width:420px;height:240px;" />
              </div>
            </div>
            <div class="semi-modal-footer" style="position:absolute;right:32px;bottom:24px;display:flex;gap:16px;">
              <div id="confirm" class="semi-button" role="button" style="width:88px;height:40px;line-height:40px;text-align:center;border:1px solid #ddd;">\u786e\u8ba4</div>
            </div>
          </div>
          <script>
            const modal = document.querySelector('.semi-modal');
            const input = document.querySelector('#cover-input');
            document.querySelector('#upload-tab').addEventListener('click', () => input.click());
            input.addEventListener('change', () => {
              document.querySelector('#preview-host').style.display = 'block';
              document.querySelector('#uploaded-preview').src = 'blob:https://cp.kuaishou.com/uploaded-cover';
            });
            document.querySelector('#confirm').addEventListener('click', () => {
              const preview = document.querySelector('#uploaded-preview');
              if (!input.files.length || !preview.src) return;
              document.querySelector('#main-cover').style.backgroundImage = 'url(https://cdn.example.com/uploaded-cover.png)';
              modal.remove();
            });
            document.querySelector('#close').addEventListener('click', () => modal.remove());
          </script>
        </body>
      </html>
    `);

    const hooks = new Publisher("profiles", true) as unknown as Record<string, unknown>;
    hooks.scrollCoverSectionIntoView = async () => undefined;
    hooks.openKuaishouCoverDialog = async () => true;

    const uploaded = await (hooks.uploadKuaishouCover as (page: unknown, coverPath: string) => Promise<boolean>)(
      page,
      "package.json"
    );

    assert.equal(uploaded, true);
    assert.equal(await (hooks.hasKuaishouCoverDialog as (page: unknown) => Promise<boolean>)(page), false);
    assert.match(await page.locator("#main-cover").evaluate((element) => getComputedStyle(element).backgroundImage), /uploaded-cover/);
  } finally {
    await browser.close();
  }
});
