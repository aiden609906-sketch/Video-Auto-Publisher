import type { Locator, Page } from "playwright-core";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { PublishStage, StageResult } from "../../../shared/types.js";
import type { PlatformAdapter, PublishInput } from "../platform-adapter.js";

type ConditionObservation = {
  matched: boolean;
  safeState: Record<string, string | number | boolean>;
};

type VideoUploadState = {
  uploadActive: boolean;
  uploadError: boolean;
  visibleProgressCount: number;
  maxProgressPercent: number;
  completionSignal: boolean;
};

type SafeErrorCategory = "timeout" | "strict" | "detached" | "io" | "evaluate" | "action" | "route";
type OperationAlias =
  | "run-stage"
  | "page-read"
  | "video-read"
  | "title-read"
  | "title-fill"
  | "body-operation"
  | "topics-operation"
  | "topic-click"
  | "video-set-file"
  | "video-read-file"
  | "video-read-source"
  | "video-read-signature"
  | "video-read-status"
  | "cover-read-signature"
  | "cover-set-file"
  | "cover-click"
  | "cover-operation"
  | "declaration-operation"
  | "ready-read";
type SelectorAlias =
  | "adapter"
  | "creator-page"
  | "creator-form"
  | "title-input"
  | "body-editor"
  | "topics-editor"
  | "topic-suggestion"
  | "video-upload-input"
  | "video-upload-root"
  | "video-ready-form"
  | "video-source"
  | "cover-surface"
  | "cover-editor"
  | "cover-main"
  | "cover-upload-input"
  | "cover-trigger"
  | "cover-complete"
  | "declaration-surface"
  | "publish-button";

class SafeAdapterError extends Error {
  constructor(
    readonly operation: OperationAlias,
    readonly target: SelectorAlias,
    readonly category: SafeErrorCategory
  ) {
    super("safe adapter operation failed");
  }
}

export type DouyinAdapterCallbacks = {
  onStageStart?: (stage: PublishStage) => void;
  onStageResult?: (result: StageResult) => void;
};

export const DOUYIN_ADAPTER_VERSION = "2026.07.20-v3-state-machine-5";

export class DouyinAdapter implements PlatformAdapter {
  readonly platform = "douyin" as const;
  readonly version = DOUYIN_ADAPTER_VERSION;
  private verifiedVideo: { inputToken: string; sourceContentDigest: string; safeFileDigest: string } | null = null;

  constructor(
    private readonly page: Page,
    private readonly callbacks: DouyinAdapterCallbacks = {}
  ) {}

  async runStage(stage: PublishStage, input: PublishInput): Promise<StageResult> {
    let result: StageResult;
    try {
      this.callbacks.onStageStart?.(stage);
    } catch {
      // Start observers are deliberately isolated from the real stage mutation.
    }
    try {
      switch (stage) {
        case "page":
          result = await this.safeOperation("page-read", "creator-page", () => this.ensurePage(input));
          break;
        case "video":
          result = await this.safeOperation("video-read", "creator-form", () => this.uploadVideo(input));
          break;
        case "title":
          result = await this.fillTitle(input);
          break;
        case "body":
          result = await this.safeOperation("body-operation", "body-editor", () => this.fillBody(input));
          break;
        case "topics":
          result = await this.safeOperation("topics-operation", "topics-editor", () => this.fillTopics(input));
          break;
        case "cover":
          result = await this.safeOperation("cover-operation", "cover-surface", () => this.uploadCovers(input));
          break;
        case "declaration":
          result = await this.safeOperation("declaration-operation", "declaration-surface", () => this.selectDeclaration(input));
          break;
        case "ready":
          result = await this.safeOperation("ready-read", "publish-button", () => this.verifyReady(input));
          break;
      }
    } catch (error) {
      result = { stage, status: "failed", detail: this.safeError(stage, error) };
    }
    try {
      this.callbacks.onStageResult?.(result);
    } catch {
      // Result observers are deliberately isolated from the verified stage result.
    }
    return result;
  }

  private async ensurePage(_input: PublishInput): Promise<StageResult> {
    const form = this.page.locator(".form-container-MDtobK");
    const uploadRoot = this.videoUploadRoot();
    return this.waitForCondition("page", 45_000, async () => {
      const formCount = await form.count();
      const formVisible = formCount === 1 && (await form.isVisible());
      const uploadRootCount = await uploadRoot.count();
      const uploadRootVisible = uploadRootCount === 1 && (await uploadRoot.isVisible());
      const videoInputCount = uploadRootCount === 1
        ? await this.videoUploadInput(uploadRoot).count()
        : 0;
      return {
        matched:
          (formCount === 1 && formVisible && uploadRootCount === 0) ||
          (formCount === 0 && uploadRootCount === 1 && uploadRootVisible && videoInputCount === 1),
        safeState: { formCount, formVisible, uploadRootCount, uploadRootVisible, videoInputCount }
      };
    });
  }

  private async uploadVideo(input: PublishInput): Promise<StageResult> {
    const form = this.page.locator(".form-container-MDtobK");
    const inputToken = createHash("sha256").update(input.filePath).digest("hex");
    if (this.verifiedVideo?.inputToken === inputToken) {
      const sourceContentDigest = await this.videoSourceContentDigest(input.filePath);
      const uploadState = (await form.count()) === 1
        ? await this.readVideoUploadState(form)
        : null;
      if (
        sourceContentDigest === this.verifiedVideo.sourceContentDigest &&
        (await form.count()) === 1 &&
        (await form.isVisible()) &&
        uploadState !== null &&
        !uploadState.uploadActive &&
        !uploadState.uploadError
      ) {
        return {
          stage: "video",
          status: "succeeded",
          detail: "video postcondition verified from this adapter upload",
          evidence: {
            formReady: true,
            uploadSubmitted: true,
            reusedVerifiedUpload: true,
            safeFileDigest: this.verifiedVideo.safeFileDigest
          }
        };
      }
    }

    this.assertCreatorRoute("video-set-file", "video-upload-input");
    const uploadRoot = this.videoUploadRoot();
    const uploadRootCount = await uploadRoot.count();
    if (uploadRootCount !== 1 || !(await uploadRoot.isVisible())) {
      return {
        stage: "video",
        status: "failed",
        detail: "video upload root was not uniquely visible",
        evidence: { uploadSubmitted: false, uploadRootCount }
      };
    }
    const videoInput = this.videoUploadInput(uploadRoot);
    if ((await videoInput.count()) !== 1) {
      return {
        stage: "video",
        status: "failed",
        detail: "video upload input count did not equal one",
        evidence: { uploadSubmitted: false, videoInputCount: await videoInput.count() }
      };
    }
    const uploadRootHandle = await uploadRoot.elementHandle();
    if (!uploadRootHandle) {
      return { stage: "video", status: "failed", detail: "video upload root handle was unavailable" };
    }
    const videoInputHandle = await videoInput.elementHandle();
    if (!videoInputHandle) {
      return { stage: "video", status: "failed", detail: "video upload input handle was unavailable" };
    }
    await this.safeOperation("video-read-file", "video-upload-input", () => videoInputHandle.evaluate((element) => {
      const input = element as HTMLInputElement & {
        __publisherSelectedFileEvidence?: {
          connected: boolean;
          files: Array<{ size: number; type: string; lastModified: number }>;
        } | null;
      };
      input.__publisherSelectedFileEvidence = null;
      input.addEventListener("input", () => {
        input.__publisherSelectedFileEvidence = {
          connected: input.isConnected,
          files: Array.from(input.files || []).map((file) => ({
            size: file.size,
            type: file.type,
            lastModified: file.lastModified
          }))
        };
      }, { capture: true, once: true });
    }));
    this.assertCreatorRoute("video-set-file", "video-upload-input");
    await this.safeOperation("video-set-file", "video-upload-input", () => videoInput.setInputFiles(input.filePath));
    const selectedFileEvidence = await this.safeOperation("video-read-file", "video-upload-input", () => videoInputHandle.evaluate((element) => {
      const input = element as HTMLInputElement & {
        __publisherSelectedFileEvidence?: {
          connected: boolean;
          files: Array<{ size: number; type: string; lastModified: number }>;
        } | null;
      };
      return input.__publisherSelectedFileEvidence || null;
    }));
    const selectedFileConnected = selectedFileEvidence?.connected === true;
    const selectedFiles = selectedFileEvidence?.files || [];
    const selectedFileVerified = selectedFileConnected && selectedFiles.length === 1;
    if (!selectedFileVerified) {
      return {
        stage: "video",
        status: "failed",
        detail: "video input did not provide connected initial file identity evidence",
        evidence: {
          uploadSubmitted: true,
          selectedFileConnected,
          selectedFileVerified: false,
          safeFileCount: selectedFiles.length
        }
      };
    }
    const safeFileDigest = createHash("sha256").update(JSON.stringify(selectedFiles)).digest("hex");

    let stableFormReads = 0;
    let stableFormHandle = await form.elementHandle();
    let stableFormSignature = "";
    let stableFormSince = 0;
    let uploadBusyObserved = false;
    const result = await this.waitForCondition("video", 75_000, async () => {
      const formCount = await form.count();
      const formReady = formCount === 1 && (await form.isVisible());
      let sameFormNode = false;
      let formSignatureStable = false;
      let uploadActive = false;
      let uploadError = false;
      let visibleProgressCount = 0;
      let maxProgressPercent = 0;
      let completionSignal = false;
      if (formReady) {
        const currentHandle = await form.elementHandle();
        const currentSignature = await this.contentSignature(
          form,
          "video-read-signature",
          "video-ready-form",
          false
        );
        sameFormNode = Boolean(
          stableFormHandle &&
          currentHandle &&
          (await stableFormHandle.evaluate((initial, current) => initial === current, currentHandle))
        );
        formSignatureStable = sameFormNode && stableFormSignature === currentSignature;
        if (formSignatureStable) {
          stableFormReads += 1;
        } else {
          stableFormHandle = currentHandle;
          stableFormSignature = currentSignature;
          stableFormReads = 1;
          stableFormSince = Date.now();
        }
        const uploadState = await this.readVideoUploadState(form);
        uploadActive = uploadState.uploadActive;
        uploadError = uploadState.uploadError;
        visibleProgressCount = uploadState.visibleProgressCount;
        maxProgressPercent = uploadState.maxProgressPercent;
        completionSignal = uploadState.completionSignal;
        uploadBusyObserved ||= uploadActive;
      } else {
        stableFormHandle = null;
        stableFormSignature = "";
        stableFormReads = 0;
        stableFormSince = 0;
      }
      const stableFormMs = stableFormSince ? Date.now() - stableFormSince : 0;
      const uploadEntryDisconnected = !(await uploadRootHandle.evaluate((element) => element.isConnected));
      const stableForm = stableFormReads >= 2 && stableFormMs >= 400;
      const uploadTerminal = stableForm && !uploadActive && !uploadError
        ? uploadBusyObserved && completionSignal
          ? "busy-cleared"
          : uploadEntryDisconnected
            ? "entry-exited"
            : "pending"
        : "pending";
      return {
        matched: selectedFileVerified && uploadTerminal !== "pending",
        safeState: {
          formCount,
          formReady,
          uploadSubmitted: true,
          selectedFileConnected,
          selectedFileVerified,
          stableFormReads,
          stableFormMs,
          sameFormNode,
          formSignatureStable,
          uploadEntryDisconnected,
          uploadBusyObserved,
          uploadActive,
          uploadError,
          visibleProgressCount,
          maxProgressPercent,
          uploadTerminal,
          safeFileDigest
        }
      };
    });
    if (result.status === "succeeded") {
      this.verifiedVideo = {
        inputToken,
        sourceContentDigest: await this.videoSourceContentDigest(input.filePath),
        safeFileDigest
      };
    }
    return result;
  }

  private async videoSourceContentDigest(filePath: string): Promise<string> {
    return this.safeOperation("video-read-source", "video-source", async () => {
      await stat(filePath);
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(filePath)) digest.update(chunk);
      return digest.digest("hex");
    });
  }

  private async fillTitle(input: PublishInput): Promise<StageResult> {
    const titleInput = this.scoped('.editor-kit-root-container input[type="text"]');
    if ((await this.safeOperation("title-read", "title-input", () => titleInput.count())) !== 1) {
      return { stage: "title", status: "failed", detail: "title input count did not equal one" };
    }

    this.assertCreatorRoute("title-fill", "title-input");
    await this.safeOperation("title-fill", "title-input", () => titleInput.fill(input.post.title));
    return this.waitForCondition("title", 2_000, async () => {
      const actual = await this.safeOperation("title-read", "title-input", () => titleInput.inputValue());
      return {
        matched: actual === input.post.title,
        safeState: {
          inputCount: await this.safeOperation("title-read", "title-input", () => titleInput.count()),
          valueLength: actual.length,
          expectedLength: input.post.title.length
        }
      };
    });
  }

  private videoUploadRoot(): Locator {
    return this.page.locator(
      '.semi-upload:has(> input[type="file"][accept*="video" i]), .container-drag-VAfIfu:has(> input[type="file"])'
    );
  }

  private videoUploadInput(root: Locator): Locator {
    return root.locator(':scope > input[type="file"]');
  }

  private async fillBody(input: PublishInput): Promise<StageResult> {
    const editor = this.scoped('[data-slate-editor]');
    if ((await editor.count()) !== 1) {
      return { stage: "body", status: "failed", detail: "body editor count did not equal one" };
    }

    this.assertCreatorRoute("body-operation", "body-editor");
    await this.safeOperation("body-operation", "body-editor", () => editor.evaluate((element, text) => {
      element.replaceChildren(...text.split("\n").flatMap((line, index) => {
        const nodes: Node[] = [];
        if (index > 0) nodes.push(document.createElement("br"));
        nodes.push(document.createTextNode(line));
        return nodes;
      }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, input.post.body));

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
      this.assertCreatorRoute("topic-click", "topics-editor");
      await this.safeOperation("topic-click", "topics-editor", () => editor.click());
      this.assertCreatorRoute("topics-operation", "topics-editor");
      await this.safeOperation("topics-operation", "topics-editor", () => this.page.keyboard.press("End"));
      this.assertCreatorRoute("topics-operation", "topics-editor");
      await this.safeOperation("topics-operation", "topics-editor", () => editor.pressSequentially(` #${topic}`));

      const suggestionReady = await this.waitForCondition("topics", 2_000, async () => {
        const suggestion = await this.findExactTopicSuggestion(topic);
        return { matched: suggestion !== null, safeState: { exactSuggestionCount: suggestion ? 1 : 0 } };
      });
      if (suggestionReady.status === "failed") return suggestionReady;
      const suggestion = await this.findExactTopicSuggestion(topic);
      if (!suggestion) {
        return { stage: "topics", status: "failed", detail: "expected scoped topic suggestion was not unique" };
      }
      this.assertCreatorRoute("topic-click", "topic-suggestion");
      await this.safeOperation("topic-click", "topic-suggestion", () => suggestion.click());
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
    const beforeMainSignature = await this.contentSignature(
      mainCover,
      "cover-read-signature",
      "cover-main",
      false
    );
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
      this.assertCreatorRoute("cover-click", "cover-trigger");
      await this.safeOperation("cover-click", "cover-trigger", () => target.click());
      const opened = await this.waitForCondition("cover", 2_000, async () => {
        const count = await dialog.count();
        return { matched: count === 1 && (await dialog.isVisible()), safeState: { coverDialogCount: count } };
      });
      if (opened.status === "failed") return opened;
    }
    if ((await dialog.count()) !== 1 || !(await dialog.isVisible())) {
      return { stage: "cover", status: "failed", detail: "cover editor was not uniquely visible" };
    }

    const beforeEditorSignature = await this.contentSignature(
      dialog,
      "cover-read-signature",
      "cover-editor",
      false
    );
    const uploadInput = dialog.locator('.container-Xnz3EO input.semi-upload-hidden-input[type="file"]');
    if ((await uploadInput.count()) !== 1) {
      return { stage: "cover", status: "failed", detail: "cover upload input count did not equal one" };
    }
    this.assertCreatorRoute("cover-set-file", "cover-upload-input");
    await this.safeOperation("cover-set-file", "cover-upload-input", () => uploadInput.setInputFiles(coverPath));

    const applied = await this.waitForCondition("cover", 4_000, async () => {
      const count = await dialog.count();
      const signature = count === 1
        ? await this.contentSignature(dialog, "cover-read-signature", "cover-editor", false)
        : "closed";
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
    this.assertCreatorRoute("cover-click", "cover-complete");
    await this.safeOperation("cover-click", "cover-complete", () => complete.click());

    return this.waitForCondition("cover", 4_000, async () => {
      const dialogCount = await dialog.count();
      const mainCount = await mainCover.count();
      const mainSignature = mainCount === 1
        ? await this.contentSignature(mainCover, "cover-read-signature", "cover-main", false)
        : "missing";
      const signatureChanged = mainSignature !== beforeMainSignature;
      return {
        matched: dialogCount === 0 && mainCount === 1 && signatureChanged,
        safeState: { coverDialogCount: dialogCount, mainCoverCount: mainCount, uploadSignatureChanged: signatureChanged }
      };
    });
  }

  private async readVideoUploadState(form: Locator): Promise<VideoUploadState> {
    return this.safeOperation("video-read-status", "video-ready-form", () => form.evaluate((root) => {
      let visibleBusyCount = 0;
      let visibleInactiveBusyCount = 0;
      let visibleProgressCount = 0;
      let visibleErrorCount = 0;
      let activeProgressCount = 0;
      let completeProgressCount = 0;
      let maxProgressPercent = 0;
      const candidates = [
        root,
        ...Array.from(root.querySelectorAll(
          '[aria-busy], [role="progressbar"], [role="alert"], [aria-invalid="true"], [data-status="error"]'
        ))
      ];
      for (const element of candidates) {
        let current: Element | null = element;
        let elementVisible = true;
        while (current) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            elementVisible = false;
            break;
          }
          if (current === root) break;
          current = current.parentElement;
        }
        const rectangle = element.getBoundingClientRect();
        if (!elementVisible || rectangle.width <= 0 || rectangle.height <= 0) continue;
        if (element.getAttribute("aria-busy") === "true") visibleBusyCount += 1;
        if (element.getAttribute("aria-busy") === "false") visibleInactiveBusyCount += 1;
        if (
          element.getAttribute("role") === "alert" ||
          element.getAttribute("aria-invalid") === "true" ||
          element.getAttribute("data-status") === "error"
        ) {
          visibleErrorCount += 1;
        }
        if (element.getAttribute("role") === "progressbar") {
          visibleProgressCount += 1;
          const minimum = Number(element.getAttribute("aria-valuemin") ?? "0");
          const maximum = Number(element.getAttribute("aria-valuemax") ?? "100");
          const value = Number(element.getAttribute("aria-valuenow"));
          if (!Number.isFinite(value) || !Number.isFinite(maximum) || maximum <= minimum) {
            activeProgressCount += 1;
          } else {
            const percent = Math.max(0, Math.min(100, ((value - minimum) / (maximum - minimum)) * 100));
            maxProgressPercent = Math.max(maxProgressPercent, Math.round(percent));
            if (percent >= 100) completeProgressCount += 1;
            else activeProgressCount += 1;
          }
        }
      }
      const uploadActive = visibleBusyCount > 0 || activeProgressCount > 0;
      const uploadError = visibleErrorCount > 0;
      const completionSignal =
        visibleInactiveBusyCount > 0 ||
        completeProgressCount > 0 ||
        (visibleBusyCount === 0 && visibleProgressCount === 0);
      return {
        uploadActive,
        uploadError,
        visibleProgressCount,
        maxProgressPercent,
        completionSignal
      };
    }));
  }

  private async contentSignature(
    locator: Locator,
    operation: Extract<OperationAlias, "video-read-signature" | "cover-read-signature">,
    target: Extract<SelectorAlias, "video-upload-root" | "video-ready-form" | "cover-editor" | "cover-main">,
    includeFileMetadata: boolean
  ): Promise<string> {
    return this.safeOperation(operation, target, () => locator.evaluate(async (root, includeFiles) => {
      const elements = [root, ...Array.from(root.querySelectorAll("*"))];
      const parts: string[] = [];
      for (const element of elements) {
        const tag = element.tagName.toLowerCase();
        const classes = Array.from(element.classList).sort().join(".");
        const background = getComputedStyle(element).backgroundImage;
        const image = element instanceof HTMLImageElement ? `${element.currentSrc}|${element.src}` : "";
        const input = element instanceof HTMLInputElement
          ? `${element.type}|${element.accept}|${element.checked}|${element.getAttribute("aria-checked") || ""}|${includeFiles ? Array.from(element.files || []).map((file) => `${file.size}:${file.type}:${file.lastModified}`).join(",") : ""}`
          : "";
        parts.push(`${tag}|${classes}|${background}|${image}|${input}`);
      }
      for (const canvas of Array.from(root.querySelectorAll("canvas"))) {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("canvas-read-unavailable");
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const canvasDigest = await crypto.subtle.digest("SHA-256", pixels);
        parts.push(
          `canvas:${canvas.width}:${canvas.height}:${Array.from(new Uint8Array(canvasDigest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
        );
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }, includeFileMetadata));
  }

  private async selectDeclaration(_input: PublishInput): Promise<StageResult> {
    const coverDialog = this.page.locator(
      '.dy-creator-content-modal-content[role="dialog"]'
    );
    if ((await coverDialog.count()) > 0) {
      return { stage: "declaration", status: "failed", detail: "cover dialog is still open" };
    }

    const selectedValue = this.scoped('.wrapper-MLZdnB .selectText-XSrMFZ');
    const modal = this.page.locator('.semi-modal:has(.btnWrapper-LtGF4z)');
    const initialModalCount = await modal.count();
    if (initialModalCount === 0 && (await this.declarationRowIsChecked(selectedValue))) {
      return {
        stage: "declaration",
        status: "succeeded",
        detail: "declaration postcondition verified from existing selection",
        evidence: { declarationModalCount: initialModalCount, aiValueSelected: true, aiRadioChecked: true }
      };
    }

    if (initialModalCount === 0) {
      const control = this.scoped('.wrapper-MLZdnB .selectBox-buZRzi');
      if ((await control.count()) !== 1 || !(await control.isVisible())) {
        return { stage: "declaration", status: "failed", detail: "declaration control was not uniquely visible" };
      }
      this.assertCreatorRoute("declaration-operation", "declaration-surface");
      await this.safeOperation("declaration-operation", "declaration-surface", () => control.click());
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
    if (!(await this.radioIsChecked(aiLabel))) {
      this.assertCreatorRoute("declaration-operation", "declaration-surface");
      await this.safeOperation("declaration-operation", "declaration-surface", () => aiLabel.click());
    }

    const checked = await this.waitForCondition("declaration", 2_000, async () => {
      const currentAiLabel = await this.findAiDeclarationLabel(modal);
      const selected = currentAiLabel ? await this.radioIsChecked(currentAiLabel) : false;
      return {
        matched: selected,
        safeState: { declarationModalCount: await modal.count(), aiRadioChecked: selected }
      };
    });
    if (checked.status === "failed") return checked;

    const confirmedModalShell = await modal.elementHandle();
    if (!confirmedModalShell) {
      return { stage: "declaration", status: "failed", detail: "declaration modal shell was unavailable" };
    }

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
    this.assertCreatorRoute("declaration-operation", "declaration-surface");
    await this.safeOperation("declaration-operation", "declaration-surface", () => confirmations[0].click());

    return this.waitForCondition("declaration", 2_000, async () => {
      const modalCount = await modal.count();
      const declarationModalConnected = await confirmedModalShell.evaluate((element) => element.isConnected);
      const valueCount = await selectedValue.count();
      const valueMatches = valueCount === 1 && (await this.declarationRowIsChecked(selectedValue));
      return {
        matched: !declarationModalConnected && modalCount === 0 && valueMatches,
        safeState: {
          declarationModalCount: modalCount,
          declarationModalConnected,
          selectedValueCount: valueCount,
          aiValueSelected: valueMatches
        }
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

  private async declarationRowIsChecked(value: Locator): Promise<boolean> {
    if ((await value.count()) !== 1 || !(await value.isVisible())) return false;
    if ((await value.innerText()).trim() !== "内容由AI生成") return false;
    if ((await value.getAttribute("aria-checked")) === "true") return true;
    const input = value.locator('input[type="radio"]');
    return (
      (await input.count()) === 1 &&
      ((await input.isChecked()) || (await input.getAttribute("aria-checked")) === "true")
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
      const route = this.currentRouteState();
      if (route.loginRequired) {
        return {
          stage: name,
          status: "failed",
          detail: `${name} postcondition failed; login is required`,
          evidence: { approvedPage: false, loginRequired: true }
        };
      }
      if (!route.approvedPage) {
        return {
          stage: name,
          status: "failed",
          detail: `${name} postcondition failed; creator page is not approved`,
          evidence: { approvedPage: false, loginRequired: false }
        };
      }
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

  private currentRouteState(): { approvedPage: boolean; loginRequired: boolean } {
    try {
      const url = new URL(this.page.url());
      const loginRequired =
        /(?:^|\.)(?:passport|sso)\.douyin\.com$/i.test(url.hostname) ||
        /(?:^|\/)(?:login|passport|sso)(?:\/|$)/i.test(url.pathname);
      return {
        approvedPage:
          !loginRequired &&
          url.protocol === "https:" &&
          url.hostname === "creator.douyin.com" &&
          (url.pathname === "/creator-micro/content/upload" ||
            url.pathname === "/creator-micro/content/upload/" ||
            url.pathname === "/creator-micro/content/post/video"),
        loginRequired
      };
    } catch {
      return { approvedPage: false, loginRequired: false };
    }
  }

  private assertCreatorRoute(operation: OperationAlias, target: SelectorAlias): void {
    const route = this.currentRouteState();
    if (!route.approvedPage || route.loginRequired) {
      throw new SafeAdapterError(operation, target, "route");
    }
  }

  private async safeOperation<T>(
    operation: OperationAlias,
    target: SelectorAlias,
    action: () => Promise<T>
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SafeAdapterError) throw error;
      throw new SafeAdapterError(operation, target, classifyError(error, operation));
    }
  }

  private safeError(stage: PublishStage, error: unknown): string {
    const safe = error instanceof SafeAdapterError
      ? error
      : new SafeAdapterError("run-stage", "adapter", classifyError(error, "run-stage"));
    return `stage=${stage};operation=${safe.operation};target=${safe.target};category=${safe.category}`;
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

function classifyError(error: unknown, operation: OperationAlias): SafeErrorCategory {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timeout")) return "timeout";
  if (message.includes("strict mode")) return "strict";
  if (
    message.includes("detached") ||
    message.includes("target page") ||
    message.includes("browser has been closed") ||
    message.includes("context has been closed")
  ) {
    return "detached";
  }
  if (
    operation.endsWith("set-file") ||
    operation === "video-read-source" ||
    message.includes("enoent") ||
    message.includes("no such file")
  ) return "io";
  if (operation.endsWith("read-signature") || operation === "video-read-file") return "evaluate";
  return "action";
}
