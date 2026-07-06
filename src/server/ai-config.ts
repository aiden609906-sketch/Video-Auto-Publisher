import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiConfigUpdate, AiConfigView, AiProvider } from "../shared/types.js";

export type AiRuntimeConfig = {
  provider: AiProvider;
  baseURL: string;
  model: string;
  apiKey: string;
};

const providers = new Set<AiProvider>(["openai", "deepseek", "qwen", "moonshot", "zhipu", "custom"]);

export class AiConfigStore {
  private config: AiRuntimeConfig;

  constructor(
    private readonly filePath: string,
    defaults: AiRuntimeConfig
  ) {
    this.config = normalize(defaults);
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AiRuntimeConfig>;
      this.config = normalize({ ...this.config, ...saved });
    } catch {
      // Environment defaults remain active until the user saves settings.
    }
  }

  get() {
    return { ...this.config };
  }

  view(): AiConfigView {
    return {
      provider: this.config.provider,
      baseURL: this.config.baseURL,
      model: this.config.model,
      apiKeyConfigured: Boolean(this.config.apiKey),
      apiKeyMasked: maskKey(this.config.apiKey)
    };
  }

  async update(input: AiConfigUpdate) {
    if (!providers.has(input.provider)) throw new Error("不支持的 AI 服务商");
    if (!String(input.baseURL || "").trim()) throw new Error("请填写 AI 接口地址");
    if (!String(input.model || "").trim()) throw new Error("请填写模型名称");
    const providerChanged = input.provider !== this.config.provider;
    const next = normalize({
      ...this.config,
      ...input,
      apiKey: input.apiKey?.trim() || (providerChanged ? "" : this.config.apiKey)
    });
    validate(next);
    this.config = next;
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.config, null, 2), "utf8");
    await rename(temp, this.filePath);
    return this.view();
  }
}

function validate(config: AiRuntimeConfig) {
  let url: URL;
  try {
    url = new URL(config.baseURL);
  } catch {
    throw new Error("AI 接口地址格式不正确");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("AI 接口地址只支持 HTTP 或 HTTPS");
  if (!config.model) throw new Error("请填写模型名称");
}

function normalize(input: Partial<AiRuntimeConfig>): AiRuntimeConfig {
  const provider = providers.has(input.provider as AiProvider) ? (input.provider as AiProvider) : "custom";
  const baseURL = String(input.baseURL || "").trim().replace(/\/+$/, "");
  const model = String(input.model || "").trim();
  return {
    provider,
    baseURL: baseURL || "https://api.openai.com/v1",
    model: model || "gpt-5.2",
    apiKey: String(input.apiKey || "").trim()
  };
}

function maskKey(apiKey: string) {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "********";
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}
