import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type AccountProfile,
  type AppData,
  type CoverImage,
  type CoverOrientation,
  type VideoCovers,
  type Platform,
  type PlatformPost,
  PLATFORMS,
  type VideoTask
} from "../shared/types.js";
import { DEFAULT_ACCOUNT_NAME, defaultAccountId, ensureDefaultAccounts } from "./account-matrix.js";

const initialData: AppData = {
  version: 1,
  accounts: ensureDefaultAccounts([]),
  videos: [],
  settings: {
    defaultStyle: "简洁、自然、有吸引力，不夸张，不使用违禁或绝对化表达",
    defaultPlatforms: [...PLATFORMS]
  }
};

export class Store {
  private data: AppData = structuredClone(initialData);
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.filePath, "utf8")) as AppData;
      this.migrate();
      await this.persist();
    } catch {
      await this.persist();
    }
  }

  listVideos() {
    return [...this.data.videos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getVideo(id: string) {
    return this.data.videos.find((video) => video.id === id);
  }

  findVideoByHash(sha256: string) {
    return this.data.videos.find((video) => video.sha256 === sha256);
  }

  getSettings() {
    return structuredClone(this.data.settings);
  }

  listAccounts() {
    return structuredClone(this.data.accounts).sort((a, b) => {
      const platformOrder = PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform);
      if (platformOrder !== 0) return platformOrder;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  getAccount(id: string) {
    return this.data.accounts.find((account) => account.id === id);
  }

  getDefaultAccount(platform: Platform) {
    const account = this.data.accounts.find((item) => item.id === defaultAccountId(platform));
    if (!account) throw new Error(`Default account not found for ${platform}`);
    return account;
  }

  async addAccount(platform: Platform, name: string) {
    const now = new Date().toISOString();
    const account: AccountProfile = {
      id: randomUUID(),
      platform,
      name: normalizeAccountName(name),
      isDefault: false,
      createdAt: now,
      updatedAt: now
    };
    this.data.accounts.push(account);
    await this.persist();
    return account;
  }

  async updateAccount(id: string, patch: Partial<Pick<AccountProfile, "name">>) {
    const account = this.requireAccount(id);
    if (typeof patch.name === "string") account.name = normalizeAccountName(patch.name);
    account.updatedAt = new Date().toISOString();
    await this.persist();
    return account;
  }

  async deleteAccount(id: string) {
    const account = this.requireAccount(id);
    if (account.isDefault) throw new Error("默认账号不能删除");
    this.data.accounts = this.data.accounts.filter((item) => item.id !== id);
    const fallback = defaultAccountId(account.platform);
    for (const video of this.data.videos) {
      for (const post of video.posts) {
        if (post.platform === account.platform && post.accountId === id) post.accountId = fallback;
      }
      video.updatedAt = new Date().toISOString();
    }
    await this.persist();
    return this.listAccounts();
  }

  async updateSettings(patch: Partial<AppData["settings"]>) {
    this.data.settings = {
      ...this.data.settings,
      ...patch,
      defaultPlatforms: patch.defaultPlatforms || this.data.settings.defaultPlatforms
    };
    await this.persist();
    return this.getSettings();
  }

  async addVideo(input: Pick<VideoTask, "filePath" | "filename" | "size" | "sha256">) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const enabled = new Set(PLATFORMS);
    const posts: PlatformPost[] = PLATFORMS.map((platform) => ({
      id: randomUUID(),
      videoId: id,
      platform,
      accountId: defaultAccountId(platform),
      enabled: enabled.has(platform),
      title: "",
      body: "",
      hashtags: [],
      status: enabled.has(platform) ? "pending" : "skipped",
      lastError: null
    }));
    const video: VideoTask = {
      id,
      ...input,
      status: "detected",
      note: "",
      covers: {
        landscape: null,
        portrait: null
      },
      createdAt: now,
      updatedAt: now,
      posts
    };
    this.data.videos.push(video);
    await this.persist();
    return video;
  }

  async updateVideo(id: string, patch: Partial<Pick<VideoTask, "status" | "note" | "filePath">>) {
    const video = this.requireVideo(id);
    Object.assign(video, patch, { updatedAt: new Date().toISOString() });
    await this.persist();
    return video;
  }

  async updateVideoFile(
    id: string,
    patch: Pick<VideoTask, "filePath" | "filename" | "size"> & Partial<Pick<VideoTask, "status">>
  ) {
    const video = this.requireVideo(id);
    Object.assign(video, patch, { updatedAt: new Date().toISOString() });
    await this.persist();
    return video;
  }

  async archiveVideo(id: string, filePath: string, covers: VideoCovers) {
    const video = this.requireVideo(id);
    video.filePath = filePath;
    video.covers = covers;
    video.status = "posted";
    video.updatedAt = new Date().toISOString();
    await this.persist();
    return video;
  }

  async updateCover(videoId: string, orientation: CoverOrientation, cover: CoverImage | null) {
    const video = this.requireVideo(videoId);
    video.covers[orientation] = cover;
    video.updatedAt = new Date().toISOString();
    await this.persist();
    return video;
  }

  async updatePost(
    videoId: string,
    platform: Platform,
    patch: Partial<Pick<PlatformPost, "accountId" | "enabled" | "title" | "body" | "hashtags" | "status" | "lastError">>
  ) {
    const video = this.requireVideo(videoId);
    const post = video.posts.find((item) => item.platform === platform);
    if (!post) throw new Error(`找不到平台任务：${platform}`);
    if (patch.accountId) {
      const account = this.requireAccount(patch.accountId);
      if (account.platform !== platform) throw new Error("账号不属于当前平台");
    }
    Object.assign(post, patch);
    video.updatedAt = new Date().toISOString();
    await this.persist();
    return video;
  }

  async applyDrafts(videoId: string, drafts: Array<Pick<PlatformPost, "platform" | "title" | "body" | "hashtags">>) {
    const video = this.requireVideo(videoId);
    for (const draft of drafts) {
      const post = video.posts.find((item) => item.platform === draft.platform);
      if (!post) continue;
      Object.assign(post, draft, {
        status: post.enabled ? "ready" : "skipped",
        lastError: null
      });
    }
    video.status = "ready";
    video.updatedAt = new Date().toISOString();
    await this.persist();
    return video;
  }

  private requireVideo(id: string) {
    const video = this.getVideo(id);
    if (!video) throw new Error("视频任务不存在");
    return video;
  }

  private migrate() {
    this.data.accounts = ensureDefaultAccounts(this.data.accounts);
    this.data.settings ||= structuredClone(initialData.settings);
    this.data.settings.defaultStyle ||= initialData.settings.defaultStyle;
    this.data.settings.defaultPlatforms ||= [...PLATFORMS];
    for (const video of this.data.videos) {
      video.covers ||= {
        landscape: null,
        portrait: null
      };
      for (const post of video.posts) {
        const accountId = "accountId" in post ? post.accountId : "";
        const account = this.data.accounts.find((item) => item.id === accountId);
        if (!account || account.platform !== post.platform) post.accountId = defaultAccountId(post.platform);
      }
    }
  }

  private requireAccount(id: string) {
    const account = this.getAccount(id);
    if (!account) throw new Error("账号不存在");
    return account;
  }

  private persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, JSON.stringify(this.data, null, 2), "utf8");
      await rename(temp, this.filePath);
    });
    return this.writeQueue;
  }
}

function normalizeAccountName(name: string) {
  const trimmed = name.trim();
  return trimmed || DEFAULT_ACCOUNT_NAME;
}
