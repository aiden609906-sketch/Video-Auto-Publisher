export const PLATFORMS = ["douyin", "xiaohongshu", "kuaishou", "bilibili"] as const;

export type Platform = (typeof PLATFORMS)[number];
export type CoverOrientation = "landscape" | "portrait";
export type VideoStatus = "detected" | "drafting" | "ready" | "opened" | "posted" | "failed";
export type PostStatus = "pending" | "ready" | "opened" | "posted" | "failed" | "skipped";

export interface PlatformPost {
  id: string;
  videoId: string;
  platform: Platform;
  accountId: string;
  enabled: boolean;
  title: string;
  body: string;
  hashtags: string[];
  status: PostStatus;
  lastError: string | null;
}

export interface AccountProfile {
  id: string;
  platform: Platform;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CoverImage {
  filePath: string;
  filename: string;
  width: number;
  height: number;
  source: "scanned" | "manual";
  updatedAt: string;
}

export interface VideoCovers {
  landscape: CoverImage | null;
  portrait: CoverImage | null;
}

export interface VideoTask {
  id: string;
  filePath: string;
  filename: string;
  size: number;
  sha256: string;
  status: VideoStatus;
  note: string;
  covers: VideoCovers;
  createdAt: string;
  updatedAt: string;
  posts: PlatformPost[];
}

export interface AppSettings {
  inboxDir: string;
  archiveDir: string;
  aiConfigured: boolean;
  aiProvider: AiProvider;
  aiModel: string;
  defaultStyle: string;
  defaultPlatforms: Platform[];
}

export interface AppData {
  version: 1;
  accounts: AccountProfile[];
  videos: VideoTask[];
  settings: Pick<AppSettings, "defaultStyle" | "defaultPlatforms">;
}

export interface GeneratedPost {
  platform: Platform;
  title: string;
  body: string;
  hashtags: string[];
}

export type AiProvider = "openai" | "deepseek" | "qwen" | "moonshot" | "zhipu" | "custom";

export interface AiConfigView {
  provider: AiProvider;
  baseURL: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyMasked: string;
}

export interface AiConfigUpdate {
  provider: AiProvider;
  baseURL: string;
  model: string;
  apiKey?: string;
}

export type CheckStatus = "ok" | "warn" | "error";

export interface EnvironmentCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface BrowserInstallation {
  channel: "msedge" | "chrome";
  label: string;
  available: boolean;
  path: string | null;
  recommended: boolean;
}

export interface EnvironmentReport {
  generatedAt: string;
  system: {
    platform: string;
    arch: string;
    node: string;
    cwd: string;
  };
  browsers: BrowserInstallation[];
  adapterVersions: Record<Platform, string>;
  checks: EnvironmentCheck[];
}

export interface DiagnosticSummary {
  id: string;
  createdAt: string;
  platform: Platform;
  videoId: string;
  filename: string;
  status: "ok" | "error";
  elapsedMs: number;
  filePath: string;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  kuaishou: "快手",
  bilibili: "B站"
};
