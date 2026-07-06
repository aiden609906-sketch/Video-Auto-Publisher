import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type AppData,
  type CoverImage,
  type CoverOrientation,
  type VideoCovers,
  type Platform,
  type PlatformPost,
  PLATFORMS,
  type VideoTask
} from "../shared/types.js";

const initialData: AppData = {
  version: 1,
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
    patch: Partial<Pick<PlatformPost, "enabled" | "title" | "body" | "hashtags" | "status" | "lastError">>
  ) {
    const video = this.requireVideo(videoId);
    const post = video.posts.find((item) => item.platform === platform);
    if (!post) throw new Error(`找不到平台任务：${platform}`);
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
    this.data.settings ||= structuredClone(initialData.settings);
    this.data.settings.defaultStyle ||= initialData.settings.defaultStyle;
    this.data.settings.defaultPlatforms ||= [...PLATFORMS];
    for (const video of this.data.videos) {
      video.covers ||= {
        landscape: null,
        portrait: null
      };
    }
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
