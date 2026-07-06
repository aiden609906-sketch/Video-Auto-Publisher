import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { imageSizeFromFile } from "image-size/fromFile";
import type { Store } from "./store.js";
import type { CoverImage, CoverOrientation, VideoTask } from "../shared/types.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function sha256(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex");
}

async function waitUntilStable(filePath: string) {
  let previous = -1;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = (await stat(filePath)).size;
    if (current > 0 && current === previous) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`文件仍在写入：${path.basename(filePath)}`);
}

export class VideoScanner {
  private processing = new Set<string>();
  private coverRescanTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly inboxDir: string,
    private readonly store: Store,
    private readonly onVideoAdded?: (video: VideoTask) => Promise<void>
  ) {}

  async start() {
    await mkdir(this.inboxDir, { recursive: true });
    const existing = await readdir(this.inboxDir, { withFileTypes: true });
    const filePaths = existing.filter((entry) => entry.isFile()).map((entry) => path.join(this.inboxDir, entry.name));
    await Promise.all(filePaths.filter((filePath) => isVideo(filePath)).map((filePath) => this.process(filePath)));
    await this.scanCovers(filePaths);

    chokidar
      .watch(this.inboxDir, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: false,
        ignored: (filePath) => path.basename(filePath).startsWith(".")
      })
      .on("add", (filePath) => void this.process(filePath))
      .on("change", (filePath) => void this.process(filePath))
      .on("error", (error) => console.error("[scanner:watcher]", error));
  }

  async scanNow() {
    const entries = await readdir(this.inboxDir, { withFileTypes: true });
    const filePaths = entries.filter((entry) => entry.isFile()).map((entry) => path.join(this.inboxDir, entry.name));
    await Promise.all(filePaths.filter((filePath) => isVideo(filePath)).map((filePath) => this.process(filePath)));
    await this.scanCovers(filePaths);
  }

  private async process(filePath: string) {
    const resolved = path.resolve(filePath);
    if (path.basename(resolved).startsWith(".")) return;
    if (this.processing.has(resolved) || (!isVideo(resolved) && !isImage(resolved))) return;
    this.processing.add(resolved);
    try {
      if (isImage(resolved)) {
        await this.processCover(resolved);
        return;
      }

      const size = await waitUntilStable(resolved);
      const digest = await sha256(resolved);
      const existing = this.store.findVideoByHash(digest);
      if (existing) {
        if (existing.status === "drafting") return;
        const updated = await this.store.updateVideoFile(existing.id, {
          filePath: resolved,
          filename: path.basename(resolved),
          size,
          status: existing.status === "failed" ? "detected" : existing.status
        });
        const hasDrafts = updated.posts.some((post) => post.title || post.body || post.hashtags.length);
        if (!hasDrafts || updated.status === "detected") {
          if (this.onVideoAdded) void this.onVideoAdded(updated);
        }
        this.scheduleCoverRescan();
        return;
      }
      const video = await this.store.addVideo({
        filePath: resolved,
        filename: path.basename(resolved),
        size,
        sha256: digest
      });
      if (this.onVideoAdded) void this.onVideoAdded(video);
      this.scheduleCoverRescan();
    } catch (error) {
      console.error("[scanner]", error);
    } finally {
      this.processing.delete(resolved);
    }
  }

  private async processCover(filePath: string) {
    await waitUntilStable(filePath);
    const size = await imageSizeFromFile(filePath);
    if (!size.width || !size.height) throw new Error(`无法识别封面尺寸：${path.basename(filePath)}`);
    const orientation: CoverOrientation = size.width >= size.height ? "landscape" : "portrait";
    const video = this.findCoverTarget(filePath);
    if (!video) return;
    if (video.covers[orientation]?.source === "manual") return;
    const cover: CoverImage = {
      filePath,
      filename: path.basename(filePath),
      width: size.width,
      height: size.height,
      source: "scanned",
      updatedAt: new Date().toISOString()
    };
    await this.removeStaleCoverLinks(filePath, video.id);
    await this.store.updateCover(video.id, orientation, cover);
  }

  private findCoverTarget(filePath: string) {
    const videos = this.store.listVideos().filter((video) => isPathInside(this.inboxDir, video.filePath));
    if (videos.length === 1) return videos[0];
    if (videos.length === 0) return undefined;

    const imageStem = normalizeCoverStem(filePath);
    if (!imageStem) return undefined;

    const matches = videos
      .map((video) => ({ video, score: coverMatchScore(imageStem, normalizeStem(video.filename)) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!matches[0] || matches[0].score === matches[1]?.score) return undefined;
    return matches[0].video;
  }

  private async scanCovers(filePaths?: string[]) {
    const paths =
      filePaths ||
      (await readdir(this.inboxDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(this.inboxDir, entry.name));
    await Promise.all(paths.filter((filePath) => isImage(filePath)).map((filePath) => this.process(filePath)));
  }

  private scheduleCoverRescan() {
    if (this.coverRescanTimer) clearTimeout(this.coverRescanTimer);
    this.coverRescanTimer = setTimeout(() => {
      this.coverRescanTimer = undefined;
      void this.scanCovers().catch((error) => console.error("[scanner:covers]", error));
    }, 1500);
  }

  private async removeStaleCoverLinks(filePath: string, targetVideoId: string) {
    const resolved = path.resolve(filePath);
    for (const video of this.store.listVideos()) {
      if (video.id === targetVideoId) continue;
      for (const orientation of ["landscape", "portrait"] as const) {
        const cover = video.covers[orientation];
        if (cover?.source === "scanned" && path.resolve(cover.filePath) === resolved) {
          await this.store.updateCover(video.id, orientation, null);
        }
      }
    }
  }
}

function isVideo(filePath: string) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isImage(filePath: string) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function normalizeStem(filePath: string) {
  return path
    .basename(filePath, path.extname(filePath))
    .toLowerCase()
    .replace(/[\s._\-—–()[\]（）【】]+/g, "");
}

function normalizeCoverStem(filePath: string) {
  return normalizeStem(filePath).replace(
    /(?:横屏|竖屏|横版|竖版|landscape|portrait)?(?:视频)?(?:封面图?|cover)$/i,
    ""
  );
}

function coverMatchScore(imageStem: string, videoStem: string) {
  if (imageStem === videoStem) return 10_000 + imageStem.length;
  if (imageStem.startsWith(videoStem) || videoStem.startsWith(imageStem)) {
    const sharedLength = Math.min(imageStem.length, videoStem.length);
    return sharedLength >= 4 ? 1_000 + sharedLength : 0;
  }

  const sharedLength = commonPrefixLength(imageStem, videoStem);
  const sufficientlySpecific =
    sharedLength >= 4 &&
    (sharedLength / imageStem.length >= 0.6 || sharedLength / videoStem.length >= 0.6);
  return sufficientlySpecific ? sharedLength : 0;
}

function commonPrefixLength(left: string, right: string) {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function isPathInside(parentDir: string, childPath: string) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
