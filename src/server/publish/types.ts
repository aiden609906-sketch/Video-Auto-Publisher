import type { Platform, PublishOutcome, PublishStage, StageResult } from "../../shared/types.js";

const MANAGED_REQUIRED: PublishStage[] = ["page", "video", "title", "body", "topics", "cover", "declaration", "ready"];
const DOUYIN_REQUIRED: PublishStage[] = ["page", "video", "title", "body", "topics", "cover", "declaration"];

export type LegacyPrefillResult = {
  browserMode: "managed" | "manual";
  copied: boolean;
  loginRequired: boolean;
  uploadPrefilled: boolean;
  titlePrefilled: boolean;
  bodyPrefilled: boolean;
  tagsPrefilled: boolean;
  coverPrefilled: boolean;
  declarationPrefilled: boolean;
};

export function requiredStagesFor(platform: Platform): PublishStage[] {
  if (platform === "xiaohongshu") return [];
  return platform === "douyin" ? [...DOUYIN_REQUIRED] : [...MANAGED_REQUIRED];
}

export function buildPublishOutcome(
  platform: Platform,
  browserMode: "managed" | "manual",
  stages: StageResult[],
  adapterVersion: string
): PublishOutcome {
  const failed = stages.find((result) => result.status === "failed") || null;
  const loginRequired = stages.some((result) => result.stage === "page" && result.evidence?.loginRequired === true);
  const complete = requiredStagesFor(platform).every((stage) => stages.some((result) => result.stage === stage && result.status === "succeeded"));

  return {
    status: loginRequired ? "login_required" : complete ? "complete" : failed ? "partial" : "failed",
    browserMode,
    platform,
    stages,
    failedStage: failed?.stage || null,
    adapterVersion
  };
}

export function toLegacyPrefillResult(outcome: PublishOutcome, copied = true): LegacyPrefillResult {
  const succeeded = (stage: PublishStage) => outcome.stages.some((result) => result.stage === stage && result.status === "succeeded");

  return {
    browserMode: outcome.browserMode,
    copied,
    loginRequired: outcome.status === "login_required",
    uploadPrefilled: succeeded("video"),
    titlePrefilled: succeeded("title"),
    bodyPrefilled: succeeded("body"),
    tagsPrefilled: succeeded("topics"),
    coverPrefilled: succeeded("cover"),
    declarationPrefilled: succeeded("declaration")
  };
}
