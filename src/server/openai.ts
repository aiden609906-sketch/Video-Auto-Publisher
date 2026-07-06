import OpenAI from "openai";
import { PLATFORMS, type GeneratedPost, type Platform, type VideoTask } from "../shared/types.js";
import type { AiRuntimeConfig } from "./ai-config.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    posts: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          platform: { type: "string", enum: [...PLATFORMS] },
          title: { type: "string" },
          body: { type: "string" },
          hashtags: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 8
          }
        },
        required: ["platform", "title", "body", "hashtags"]
      }
    }
  },
  required: ["posts"]
} as const;

const genericTechTags = ["AI工具教程", "AI工具", "效率工具", "实用教程"];

function addTag(tags: string[], tag: string) {
  const clean = tag.replace(/^#/, "").trim();
  if (!clean || tags.some((item) => item.toLowerCase() === clean.toLowerCase())) return;
  tags.push(clean);
}

function inferHashtags(filename: string) {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  const lower = base.toLowerCase();
  const tags: string[] = [];

  if (lower.includes("codex")) {
    addTag(tags, "codex");
    addTag(tags, "Codex教程");
  }
  if (lower.includes("gpt")) addTag(tags, "GPT");
  if (lower.includes("openai")) addTag(tags, "OpenAI");
  if (lower.includes("ai") || /人工智能|模型|工具/.test(base)) addTag(tags, "AI工具教程");
  if (/报错|错误|故障|异常/.test(base)) addTag(tags, "报错解决");
  if (/解决|修复|处理/.test(base)) addTag(tags, "问题解决");
  if (/教程|教学|指南|入门/.test(base)) addTag(tags, "教程");

  for (const match of base.matchAll(/[A-Za-z][A-Za-z0-9]{1,18}/g)) addTag(tags, match[0]);
  for (const tag of genericTechTags) addTag(tags, tag);

  return tags.slice(0, 6);
}

function fallbackDrafts(video: VideoTask): GeneratedPost[] {
  const base = video.filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  const hashtags = inferHashtags(video.filename);
  return PLATFORMS.map((platform) => ({
    platform,
    title: base,
    body: video.note || `分享一个关于“${base}”的实用教程。`,
    hashtags
  }));
}

function normalizePosts(value: unknown): GeneratedPost[] {
  if (!value || typeof value !== "object" || !("posts" in value) || !Array.isArray(value.posts)) {
    throw new Error("AI 返回格式无效");
  }
  const byPlatform = new Map<Platform, GeneratedPost>();
  for (const item of value.posts) {
    if (!item || typeof item !== "object") continue;
    const platform = "platform" in item ? item.platform : null;
    if (!PLATFORMS.includes(platform as Platform)) continue;
    byPlatform.set(platform as Platform, {
      platform: platform as Platform,
      title: String("title" in item ? item.title : "").trim(),
      body: String("body" in item ? item.body : "").trim(),
      hashtags: Array.isArray("hashtags" in item ? item.hashtags : null)
        ? (item.hashtags as unknown[])
            .map(String)
            .map((tag) => tag.replace(/^#/, "").trim())
            .filter(Boolean)
            .filter((tag) => !["视频分享", "热门", "上热门", "推荐"].includes(tag))
            .slice(0, 8)
        : []
    });
  }
  if (byPlatform.size !== PLATFORMS.length) throw new Error("AI 未返回全部平台文案");
  return PLATFORMS.map((platform) => byPlatform.get(platform)!);
}

export class DraftGenerator {
  private config: AiRuntimeConfig;

  constructor(config: AiRuntimeConfig) {
    this.config = { ...config };
  }

  configure(config: AiRuntimeConfig) {
    this.config = { ...config };
  }

  get configured() {
    return Boolean(this.config.apiKey && this.config.baseURL && this.config.model);
  }

  get provider() {
    return this.config.provider;
  }

  get model() {
    return this.config.model;
  }

  async testConnection(config = this.config) {
    if (!config.apiKey) throw new Error("请先填写 API Key");
    try {
      const client = createClient(config);
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: "你是连接测试助手。" },
          { role: "user", content: "只回复 OK" }
        ],
        max_tokens: 8
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error("模型没有返回内容");
      return { ok: true, response: content.slice(0, 50) };
    } catch (error) {
      throw new Error(friendlyAiError(error));
    }
  }

  async generate(video: VideoTask, style: string) {
    if (!this.configured) return fallbackDrafts(video);

    try {
      const content = await this.requestDraftJson(video, style);
      return normalizePosts(JSON.parse(extractJson(content)));
    } catch (error) {
      console.warn("[ai] draft generation failed, using local fallback:", error);
      return fallbackDrafts(video);
    }
  }

  private async requestDraftJson(video: VideoTask, style: string) {
    const client = createClient(this.config);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: [
          "你是中文短视频运营编辑。生成真实、自然、不过度承诺的发布文案。",
          "话题必须短、明确、可搜索，不要输出#号。",
          "必须只返回 JSON，不要使用 Markdown 代码块。",
          `JSON 结构必须符合：${JSON.stringify(schema)}`
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `视频文件名：${video.filename}`,
          `用户备注：${video.note || "无"}`,
          `文案风格：${style}`,
          "分别为 douyin、xiaohongshu、kuaishou、bilibili 生成标题、正文和3-8个话题词。",
          "话题示例风格：codex、AI工具教程、报错解决、效率工具。",
          "不要使用平台名、视频分享、热门、上热门、推荐这类泛标签。"
        ].join("\n")
      }
    ];

    try {
      const response = await client.chat.completions.create({
        model: this.config.model,
        messages,
        response_format: { type: "json_object" }
      });
      return response.choices[0]?.message?.content || "";
    } catch (error) {
      console.warn("[ai] provider rejected response_format, retrying without it:", error);
      const response = await client.chat.completions.create({
        model: this.config.model,
        messages
      });
      return response.choices[0]?.message?.content || "";
    }
  }
}

function createClient(config: AiRuntimeConfig) {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: 20_000,
    maxRetries: 0
  });
}

function extractJson(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 返回内容中没有 JSON");
  return trimmed.slice(start, end + 1);
}

function friendlyAiError(error: unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return "连接 AI 服务超时，请检查网络、代理或接口地址";
  if (status === 401) return "API Key 无效或已过期";
  if (status === 403) return "当前 API Key 没有访问该模型的权限";
  if (status === 404) return "接口地址或模型名称不存在";
  if (status === 429) return "请求过于频繁或账户额度不足";
  if (/fetch failed|connection|network/i.test(message)) return "无法连接 AI 服务，请检查网络和接口地址";
  return `AI 服务返回错误：${message.slice(0, 200)}`;
}
