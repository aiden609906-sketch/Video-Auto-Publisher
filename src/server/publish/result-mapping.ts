import type {
  DiagnosticSummary,
  Platform,
  PostStatus,
  PublishOutcome,
  PublishStage,
  StageResult,
  VideoStatus
} from "../../shared/types.js";
import { buildPublishOutcome, type LegacyPrefillResult } from "./types.js";

const STAGE_LABELS: Record<PublishStage, string> = {
  page: "发布页面",
  video: "视频",
  title: "标题",
  body: "正文",
  topics: "话题",
  cover: "封面",
  declaration: "作者声明",
  ready: "发布前就绪状态"
};

export type PublishResultMapping = {
  diagnosticStatus: DiagnosticSummary["status"];
  postStatus: PostStatus;
  videoStatus: VideoStatus;
  httpStatus: number;
  progressLabel: string;
};

export function mapPublishOutcome(outcome: PublishOutcome): PublishResultMapping {
  if (outcome.status === "login_required") {
    return {
      diagnosticStatus: "partial",
      postStatus: "ready",
      videoStatus: "ready",
      httpStatus: 200,
      progressLabel: "需要登录后重试"
    };
  }

  if (outcome.browserMode === "manual") {
    if (outcome.status === "complete") {
      return {
        diagnosticStatus: "ok",
        postStatus: "opened",
        videoStatus: "opened",
        httpStatus: 200,
        progressLabel: "人工发布材料已准备"
      };
    }

    return {
      diagnosticStatus: outcome.status === "partial" ? "partial" : "error",
      postStatus: "failed",
      videoStatus: "failed",
      httpStatus: 200,
      progressLabel: `人工发布材料未准备：${publishStageDetail(outcome)}`
    };
  }

  if (outcome.status === "complete") {
    return {
      diagnosticStatus: "ok",
      postStatus: "opened",
      videoStatus: "opened",
      httpStatus: 200,
      progressLabel: "自动填写完成"
    };
  }

  return {
    diagnosticStatus: outcome.status === "partial" ? "partial" : "error",
    postStatus: "failed",
    videoStatus: "failed",
    httpStatus: 200,
    progressLabel: outcome.failedStage
      ? `自动填写未完成：${STAGE_LABELS[outcome.failedStage]}`
      : "自动填写失败"
  };
}

export function normalizePublishOutcome(
  platform: Platform,
  adapterVersion: string,
  result: PublishOutcome | LegacyPrefillResult
): PublishOutcome {
  if (isPublishOutcome(result)) return result;

  if (result.browserMode === "manual" && result.copied && !result.loginRequired) {
    return {
      status: "complete",
      browserMode: "manual",
      platform,
      stages: [
        { stage: "page", status: "succeeded", detail: "已打开人工发布页面和素材文件夹" },
        { stage: "ready", status: "succeeded", detail: "人工发布材料已准备，等待用户在平台页面完成发布" }
      ],
      failedStage: null,
      adapterVersion
    };
  }

  const stages: StageResult[] = [
    legacyStage("page", !result.loginRequired, result.loginRequired ? "需要登录平台账号" : "已打开发布页面", {
      loginRequired: result.loginRequired
    }),
    legacyStage("video", result.uploadPrefilled),
    legacyStage("title", result.titlePrefilled),
    legacyStage("body", result.bodyPrefilled),
    legacyStage("topics", result.tagsPrefilled),
    legacyStage("cover", result.coverPrefilled),
    legacyStage("declaration", result.declarationPrefilled),
    {
      stage: "ready",
      status: "failed",
      detail: "Legacy adapter did not verify pre-publish readiness"
    }
  ];
  const outcome = buildPublishOutcome(platform, result.browserMode, stages, adapterVersion);

  // A manual result that did not copy/open its materials is a real failure, not
  // an empty managed workflow that can be considered complete.
  if (result.browserMode === "manual" && !result.loginRequired) {
    return { ...outcome, status: "failed" };
  }
  return outcome;
}

function isPublishOutcome(result: PublishOutcome | LegacyPrefillResult): result is PublishOutcome {
  return "status" in result && "stages" in result && Array.isArray(result.stages);
}

function publishStageDetail(outcome: PublishOutcome): string {
  const result =
    (outcome.failedStage && outcome.stages.find((stage) => stage.stage === outcome.failedStage)) ||
    outcome.stages.find((stage) => stage.status === "failed") ||
    outcome.stages.at(-1);
  return result ? `${STAGE_LABELS[result.stage]}（${result.detail}）` : "未提供失败详情";
}

function legacyStage(
  stage: PublishStage,
  succeeded: boolean,
  successDetail = `Legacy adapter reported ${stage} succeeded`,
  evidence?: StageResult["evidence"]
): StageResult {
  return {
    stage,
    status: succeeded ? "succeeded" : "failed",
    detail: succeeded ? successDetail : `Legacy adapter reported ${stage} incomplete`,
    ...(evidence ? { evidence } : {})
  };
}
