import type { PublishOutcome } from "../shared/types.js";

export type PublishNotice = { type: "ok" | "error"; text: string };

const STAGE_LABELS: Record<PublishOutcome["stages"][number]["stage"], string> = {
  page: "发布页面",
  video: "视频",
  title: "标题",
  body: "正文",
  topics: "话题",
  cover: "封面",
  declaration: "作者声明",
  ready: "发布前就绪状态"
};

const STAGE_STATUS_LABELS: Record<PublishOutcome["stages"][number]["status"], string> = {
  succeeded: "成功",
  skipped: "已跳过",
  failed: "失败"
};

export function formatPublishNotice(result: PublishOutcome): PublishNotice {
  const stageDetails = result.stages.map(
    (stage) => `${STAGE_LABELS[stage.stage]}：${STAGE_STATUS_LABELS[stage.status]}（${stage.detail}）`
  );

  if (result.status === "login_required") {
    return {
      type: "error",
      text: ["请先在打开的浏览器中登录该平台，登录完成后再点一次打开发布", ...stageDetails].join("；")
    };
  }

  if (result.browserMode === "manual") {
    if (result.status === "complete") {
      return {
        type: "ok",
        text: [
          "小红书人工发布材料已准备：已复制文案，并用当前账号的独立浏览器窗口打开发布页和素材文件夹，请在网页里手动选择视频/封面后发布",
          ...stageDetails
        ].join("；")
      };
    }

    return {
      type: "error",
      text: stageDetails.join("；") || "人工发布准备未完成"
    };
  }

  return {
    type: result.status === "partial" || result.status === "failed" ? "error" : "ok",
    text: stageDetails.join("；") || (result.status === "complete" ? "自动填写完成" : "自动填写未完成")
  };
}
