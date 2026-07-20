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

  if (outcome.browserMode === "manual" && outcome.status !== "failed") {
    return {
      diagnosticStatus: outcome.status === "complete" ? "ok" : "partial",
      postStatus: "opened",
      videoStatus: "opened",
      httpStatus: 200,
      progressLabel: "人工发布材料已准备"
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

  // Manual publishing intentionally stops before an automated readiness check.
  // Keep that incompleteness visible while the route maps it to the manual task semantics.
  if (result.browserMode === "manual" && !result.loginRequired) {
    return { ...outcome, status: "partial" };
  }
  return outcome;
}

function isPublishOutcome(result: PublishOutcome | LegacyPrefillResult): result is PublishOutcome {
  return "status" in result && "stages" in result && Array.isArray(result.stages);
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
