import type { Locator, Page } from "playwright-core";
import type { PublishStage, StageResult } from "../../../shared/types.js";
import type { PlatformAdapter, PublishInput } from "../platform-adapter.js";

type ConditionObservation = {
  matched: boolean;
  safeState: Record<string, string | number | boolean>;
};

export type DouyinAdapterCallbacks = {
  onStageStart?: (stage: PublishStage) => void;
  onStageResult?: (result: StageResult) => void;
};

export const DOUYIN_ADAPTER_VERSION = "2026.07.20-v3-state-machine-1";

export class DouyinAdapter implements PlatformAdapter {
  readonly platform = "douyin" as const;
  readonly version = DOUYIN_ADAPTER_VERSION;

  constructor(
    private readonly page: Page,
    private readonly callbacks: DouyinAdapterCallbacks = {}
  ) {}

  async runStage(stage: PublishStage, input: PublishInput): Promise<StageResult> {
    let result: StageResult;
    try {
      this.callbacks.onStageStart?.(stage);
      switch (stage) {
        case "page":
          result = await this.ensurePage(input);
          break;
        case "video":
          result = await this.uploadVideo(input);
          break;
        case "title":
          result = await this.fillTitle(input);
          break;
        case "body":
          result = await this.fillBody(input);
          break;
        case "topics":
          result = await this.fillTopics(input);
          break;
        case "cover":
          result = await this.uploadCovers(input);
          break;
        case "declaration":
          result = await this.selectDeclaration(input);
          break;
        case "ready":
          result = await this.verifyReady(input);
          break;
      }
    } catch (error) {
      result = { stage, status: "failed", detail: this.safeError(error) };
    }
    this.callbacks.onStageResult?.(result);
    return result;
  }

  private async ensurePage(_input: PublishInput): Promise<StageResult> {
    const loginRequired = /(?:login|passport|sso)/i.test(this.page.url());
    if (loginRequired) {
      return {
        stage: "page",
        status: "failed",
        detail: "page postcondition failed; login is required",
        evidence: { loginRequired: true }
      };
    }
    const form = this.page.locator(".form-container-MDtobK");
    const videoInputs = this.page.locator('input[type="file"][accept*="video" i]');
    return this.waitForCondition("page", 45_000, async () => {
      const formCount = await form.count();
      const formVisible = formCount === 1 && (await form.isVisible());
      const videoInputCount = await videoInputs.count();
      return {
        matched: (formCount === 1 && formVisible) || (formCount === 0 && videoInputCount === 1),
        safeState: { formCount, formVisible, videoInputCount, loginRequired: false }
      };
    });
  }

  private async uploadVideo(input: PublishInput): Promise<StageResult> {
    const form = this.page.locator(".form-container-MDtobK");
    if ((await form.count()) === 1 && (await form.isVisible())) {
      return {
        stage: "video",
        status: "succeeded",
        detail: "video postcondition verified from existing creator form",
        evidence: { formReady: true, uploadSubmitted: false }
      };
    }

    const videoInput = this.page.locator('input[type="file"][accept*="video" i]');
    if ((await videoInput.count()) !== 1) {
      return { stage: "video", status: "failed", detail: "video upload input count did not equal one" };
    }
    await videoInput.setInputFiles(input.filePath);

    return this.waitForCondition("video", 75_000, async () => {
      const formCount = await form.count();
      const formReady = formCount === 1 && (await form.isVisible());
      return {
        matched: formReady,
        safeState: { formCount, formReady, uploadSubmitted: true }
      };
    });
  }

  private async fillTitle(input: PublishInput): Promise<StageResult> {
    const titleInput = this.scoped('.editor-kit-root-container input[type="text"]');
    if ((await titleInput.count()) !== 1) {
      return { stage: "title", status: "failed", detail: "title input count did not equal one" };
    }

    await titleInput.fill(input.post.title);
    return this.waitForCondition("title", 2_000, async () => {
      const actual = await titleInput.inputValue();
      return {
        matched: actual === input.post.title,
        safeState: { inputCount: await titleInput.count(), valueLength: actual.length, expectedLength: input.post.title.length }
      };
    });
  }

  private async fillBody(input: PublishInput): Promise<StageResult> {
    const editor = this.scoped('[data-slate-editor]');
    if ((await editor.count()) !== 1) {
      return { stage: "body", status: "failed", detail: "body editor count did not equal one" };
    }

    await editor.evaluate((element, text) => {
      element.replaceChildren(...text.split("\n").flatMap((line, index) => {
        const nodes: Node[] = [];
        if (index > 0) nodes.push(document.createElement("br"));
        nodes.push(document.createTextNode(line));
        return nodes;
      }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, input.post.body);

    return this.waitForCondition("body", 2_000, async () => {
      const actual = normalizeEditorText(await editor.innerText());
      const expected = normalizeEditorText(input.post.body);
      return {
        matched: actual === expected,
        safeState: { editorCount: await editor.count(), normalizedLength: actual.length, expectedLength: expected.length }
      };
    });
  }

  private async fillTopics(input: PublishInput): Promise<StageResult> {
    const topics = uniqueTopics(input.post.hashtags);
    for (const topic of topics) {
      if (await this.hasVisibleTopicChip(topic)) continue;

      const editor = this.scoped('[data-slate-editor]');
      if ((await editor.count()) !== 1) {
        return { stage: "topics", status: "failed", detail: "topic editor count did not equal one" };
      }
      await editor.click();
      await this.page.keyboard.press("End");
      await this.page.keyboard.insertText(` #${topic}`);

      const suggestionReady = await this.waitForCondition("topics", 2_000, async () => {
        const suggestion = await this.findExactTopicSuggestion(topic);
        return { matched: suggestion !== null, safeState: { exactSuggestionCount: suggestion ? 1 : 0 } };
      });
      if (suggestionReady.status === "failed") return suggestionReady;
      const suggestion = await this.findExactTopicSuggestion(topic);
      if (!suggestion) {
        return { stage: "topics", status: "failed", detail: "expected scoped topic suggestion was not unique" };
      }
      await suggestion.click();
    }

    return this.waitForCondition("topics", 2_000, async () => {
      let visibleCount = 0;
      for (const topic of topics) {
        if (await this.hasVisibleTopicChip(topic)) visibleCount += 1;
      }
      return {
        matched: visibleCount === topics.length,
        safeState: { expectedTopics: topics.length, visibleTopics: visibleCount }
      };
    });
  }

  private async uploadCovers(input: PublishInput): Promise<StageResult> {
    const coverPath = input.covers.landscape || input.covers.portrait;
    if (!coverPath) {
      return {
        stage: "cover",
        status: "succeeded",
        detail: "cover postcondition verified; no cover requested",
        evidence: { requested: false }
      };
    }

    const mainCover = this.scoped('.content-upload-new');
    if ((await mainCover.count()) !== 1) {
      return { stage: "cover", status: "failed", detail: "main cover target count did not equal one" };
    }
    const beforeMainSignature = await this.structuralSignature(mainCover);
    const dialog = this.page.locator(
      '.dy-creator-content-modal-content[role="dialog"]'
    );
    if ((await dialog.count()) === 0) {
      const target = this.scoped(
        '.horizontalContainer-I6fMtI > .cover-ybR0xM:not(.hcover-aQtDQg)'
      );
      if ((await target.count()) !== 1 || !(await target.isVisible())) {
        return { stage: "cover", status: "failed", detail: "cover editor trigger was not unique and visible" };
      }
      await target.click();
      const opened = await this.waitForCondition("cover", 2_000, async () => {
        const count = await dialog.count();
        return { matched: count === 1 && (await dialog.isVisible()), safeState: { coverDialogCount: count } };
      });
      if (opened.status === "failed") return opened;
    }
    if ((await dialog.count()) !== 1 || !(await dialog.isVisible())) {
      return { stage: "cover", status: "failed", detail: "cover editor was not uniquely visible" };
    }

    const beforeEditorSignature = await this.structuralSignature(dialog);
    const uploadInput = dialog.locator('.container-Xnz3EO input.semi-upload-hidden-input[type="file"]');
    if ((await uploadInput.count()) !== 1) {
      return { stage: "cover", status: "failed", detail: "cover upload input count did not equal one" };
    }
    await uploadInput.setInputFiles(coverPath);

    const applied = await this.waitForCondition("cover", 4_000, async () => {
      const count = await dialog.count();
      const signature = count === 1 ? await this.structuralSignature(dialog) : "closed";
      return {
        matched: count === 1 && signature !== beforeEditorSignature,
        safeState: { coverDialogCount: count, uploadSignatureChanged: signature !== beforeEditorSignature }
      };
    });
    if (applied.status === "failed") return applied;

    const complete = dialog.locator('.buttons-BoCvr4 button.secondary-zU1YLr[type="button"]');
    if ((await complete.count()) !== 1 || !(await complete.isVisible()) || !(await complete.isEnabled())) {
      return { stage: "cover", status: "failed", detail: "cover complete control was not uniquely actionable" };
    }
    await complete.click();

    return this.waitForCondition("cover", 4_000, async () => {
      const dialogCount = await dialog.count();
      const mainCount = await mainCover.count();
      const mainSignature = mainCount === 1 ? await this.structuralSignature(mainCover) : "missing";
      const signatureChanged = mainSignature !== beforeMainSignature;
      return {
        matched: dialogCount === 0 && mainCount === 1 && signatureChanged,
        safeState: { coverDialogCount: dialogCount, mainCoverCount: mainCount, uploadSignatureChanged: signatureChanged }
      };
    });
  }

  private async structuralSignature(locator: Locator): Promise<string> {
    return locator.evaluate((root) => {
      const elements = [root, ...Array.from(root.querySelectorAll("*"))];
      const classTokens = elements.reduce((count, element) => count + element.classList.length, 0);
      return [
        `elements:${elements.length}`,
        `classes:${classTokens}`,
        `files:${root.querySelectorAll('input[type="file"]').length}`,
        `canvas:${root.querySelectorAll(".canvas-container").length}`,
        `checked:${root.querySelectorAll("input:checked").length}`
      ].join(";");
    });
  }

  private async selectDeclaration(_input: PublishInput): Promise<StageResult> {
    const coverDialog = this.page.locator(
      '.dy-creator-content-modal-content[role="dialog"]'
    );
    if ((await coverDialog.count()) > 0 && (await coverDialog.first().isVisible())) {
      return { stage: "declaration", status: "failed", detail: "cover dialog is still open" };
    }

    const selectedValue = this.scoped('.wrapper-MLZdnB .selectText-XSrMFZ.selected-Vx6wO5');
    if (
      (await selectedValue.count()) === 1 &&
      (await selectedValue.isVisible()) &&
      (await selectedValue.innerText()).trim() === "内容由AI生成"
    ) {
      return {
        stage: "declaration",
        status: "succeeded",
        detail: "declaration postcondition verified from existing selection",
        evidence: { declarationModalCount: 0, aiValueSelected: true }
      };
    }

    const modal = this.page.locator('.semi-modal:has(.btnWrapper-LtGF4z)');
    if ((await modal.count()) === 0) {
      const control = this.scoped('.wrapper-MLZdnB .selectBox-buZRzi');
      if ((await control.count()) !== 1 || !(await control.isVisible())) {
        return { stage: "declaration", status: "failed", detail: "declaration control was not uniquely visible" };
      }
      await control.click();
      const opened = await this.waitForCondition("declaration", 2_000, async () => {
        const count = await modal.count();
        return { matched: count === 1 && (await modal.isVisible()), safeState: { declarationModalCount: count } };
      });
      if (opened.status === "failed") return opened;
    }
    if ((await modal.count()) !== 1 || !(await modal.isVisible())) {
      return { stage: "declaration", status: "failed", detail: "declaration modal was not uniquely visible" };
    }

    const aiLabel = await this.findAiDeclarationLabel(modal);
    if (!aiLabel) {
      return { stage: "declaration", status: "failed", detail: "AI declaration radio was not unique" };
    }
    await aiLabel.click();

    const checked = await this.waitForCondition("declaration", 2_000, async () => {
      const currentAiLabel = await this.findAiDeclarationLabel(modal);
      const selected = currentAiLabel ? await this.radioIsChecked(currentAiLabel) : false;
      return {
        matched: selected,
        safeState: { declarationModalCount: await modal.count(), aiRadioChecked: selected }
      };
    });
    if (checked.status === "failed") return checked;

    const buttons = modal.locator('button[type="button"]');
    const confirmations: Locator[] = [];
    for (let index = 0; index < (await buttons.count()); index += 1) {
      const button = buttons.nth(index);
      if ((await button.innerText()).trim() === "确定") confirmations.push(button);
    }
    if (
      confirmations.length !== 1 ||
      !(await confirmations[0].isVisible()) ||
      !(await confirmations[0].isEnabled())
    ) {
      return { stage: "declaration", status: "failed", detail: "declaration confirmation was not uniquely actionable" };
    }
    await confirmations[0].click();

    return this.waitForCondition("declaration", 2_000, async () => {
      const modalCount = await modal.count();
      const valueCount = await selectedValue.count();
      const valueMatches =
        valueCount === 1 && (await selectedValue.isVisible()) && (await selectedValue.innerText()).trim() === "内容由AI生成";
      return {
        matched: modalCount === 0 && valueMatches,
        safeState: { declarationModalCount: modalCount, selectedValueCount: valueCount, aiValueSelected: valueMatches }
      };
    });
  }

  private async findAiDeclarationLabel(modal: Locator): Promise<Locator | null> {
    const labels = modal.locator("label.semi-radio");
    const matches: Locator[] = [];
    for (let index = 0; index < (await labels.count()); index += 1) {
      const label = labels.nth(index);
      if ((await label.innerText()).trim() === "内容由AI生成" && (await label.isVisible())) matches.push(label);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  private async radioIsChecked(label: Locator): Promise<boolean> {
    const input = label.locator('input[type="radio"]');
    if ((await input.count()) !== 1) return false;
    return (
      (await input.isChecked()) ||
      (await input.getAttribute("aria-checked")) === "true" ||
      (await label.getAttribute("aria-checked")) === "true"
    );
  }

  private async verifyReady(_input: PublishInput): Promise<StageResult> {
    const publishButton = this.scoped('.content-confirm-container-Wp91G7 button.primary-cECiOJ[type="button"], .content-confirm-container-Wp91G7 button.primary-cECiOJ:not([type])');
    return this.waitForCondition("ready", 2_000, async () => {
      const count = await publishButton.count();
      const textMatches = count === 1 && (await publishButton.innerText()).trim() === "发布";
      const visible = count === 1 && (await publishButton.isVisible());
      const enabled = count === 1 && (await publishButton.isEnabled());
      return {
        matched: count === 1 && textMatches && visible && enabled,
        safeState: { publishButtonCount: count, publishButtonVisible: visible, publishButtonEnabled: enabled }
      };
    });
  }

  private async hasVisibleTopicChip(topic: string): Promise<boolean> {
    const chips = this.scoped('[data-slate-editor] [data-mention]');
    const count = await chips.count();
    for (let index = 0; index < count; index += 1) {
      const chip = chips.nth(index);
      if (!(await chip.isVisible())) continue;
      const text = normalizeTopic(await chip.innerText());
      if (text === topic) return true;
    }
    return false;
  }

  private async findExactTopicSuggestion(topic: string): Promise<Locator | null> {
    const options = this.page.locator(
      '.mention-suggest-item-container-TVOZMl .tag-hash-o0tpyE'
    );
    const matches: Locator[] = [];
    const count = await options.count();
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      if (!(await option.isVisible())) continue;
      const name = option.locator('[class*="tag-hash-view-name"]');
      if ((await name.count()) !== 1) continue;
      if (normalizeTopic(await name.innerText()) === topic) matches.push(option);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  private scoped(selector: string): Locator {
    return this.page.locator(".form-container-MDtobK").locator(selector);
  }

  private async waitForCondition(
    name: PublishStage,
    timeoutMs: number,
    read: () => Promise<ConditionObservation>
  ): Promise<StageResult> {
    const startedAt = Date.now();
    let lastState: Record<string, string | number | boolean> = {};
    while (Date.now() - startedAt <= timeoutMs) {
      const observation = await read();
      lastState = observation.safeState;
      if (observation.matched) {
        return { stage: name, status: "succeeded", detail: `${name} postcondition verified`, evidence: lastState };
      }
      if (Date.now() - startedAt >= timeoutMs) break;
      await this.page.waitForTimeout(200);
    }
    return { stage: name, status: "failed", detail: `${name} postcondition timed out; last=${safeState(lastState)}` };
  }

  private safeError(error: unknown): string {
    if (!(error instanceof Error)) return "unexpected adapter error";
    const name = error.name.replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "Error";
    const lower = error.message.toLowerCase();
    const context = lower.includes("timeout")
      ? "scoped selector operation timed out"
      : lower.includes("strict mode")
        ? "scoped selector was not unique"
        : lower.includes("detached")
          ? "scoped element became detached"
          : "scoped adapter operation failed";
    return `${name}: ${context}`;
  }
}

function normalizeEditorText(value: string): string {
  return value
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function safeState(value: Record<string, string | number | boolean>): string {
  return Object.entries(value)
    .slice(0, 8)
    .map(([key, item]) => `${key}=${String(item).slice(0, 80)}`)
    .join(",");
}

function normalizeTopic(value: string): string {
  return value.replace(/^#/, "").trim().toLowerCase();
}

function uniqueTopics(values: string[]): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const value of values) {
    const topic = normalizeTopic(value);
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    topics.push(topic);
  }
  return topics.slice(0, 5);
}
