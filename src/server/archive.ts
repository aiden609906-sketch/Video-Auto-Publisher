import { access, copyFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { VideoCovers, VideoTask } from "../shared/types.js";

type MovedFile = {
  source: string;
  target: string;
};

export type ArchiveResult = {
  directory: string;
  videoPath: string;
  covers: VideoCovers;
  movedFiles: string[];
};

export async function archiveTaskFiles(
  video: VideoTask,
  inboxDir: string,
  archiveDir: string,
  now = new Date()
): Promise<ArchiveResult> {
  if (!isPathInside(inboxDir, video.filePath)) {
    throw new Error(video.status === "posted" ? "该视频已经归档" : "视频文件不在 inbox 目录中");
  }

  await access(video.filePath);
  const directory = await createArchiveDirectory(archiveDir, now);

  const sources = new Map<string, string>();
  sources.set(path.resolve(video.filePath), video.filePath);
  for (const cover of Object.values(video.covers)) {
    if (cover && isPathInside(inboxDir, cover.filePath)) {
      sources.set(path.resolve(cover.filePath), cover.filePath);
    }
  }

  const moved: MovedFile[] = [];
  try {
    for (const source of sources.values()) {
      const target = await availablePath(directory, path.basename(source));
      await moveFile(source, target);
      moved.push({ source, target });
    }
  } catch (error) {
    await rollbackMoves(moved);
    throw error;
  }

  const targetBySource = new Map(moved.map((item) => [path.resolve(item.source), item.target]));
  return {
    directory,
    videoPath: targetBySource.get(path.resolve(video.filePath))!,
    covers: {
      landscape: updateCoverPath(video.covers.landscape, targetBySource),
      portrait: updateCoverPath(video.covers.portrait, targetBySource)
    },
    movedFiles: moved.map((item) => item.target)
  };
}

function updateCoverPath(
  cover: VideoCovers["landscape"],
  targetBySource: Map<string, string>
) {
  if (!cover) return null;
  const target = targetBySource.get(path.resolve(cover.filePath));
  return target ? { ...cover, filePath: target, updatedAt: new Date().toISOString() } : cover;
}

async function availablePath(directory: string, filename: string) {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  for (let index = 1; ; index += 1) {
    const candidate = path.join(directory, index === 1 ? filename : `${stem}-${index}${extension}`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
}

async function moveFile(source: string, target: string) {
  try {
    await rename(source, target);
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
    await copyFile(source, target);
    try {
      await unlink(source);
    } catch (unlinkError) {
      await unlink(target).catch(() => undefined);
      throw unlinkError;
    }
  }
}

async function rollbackMoves(moved: MovedFile[]) {
  for (const item of [...moved].reverse()) {
    await moveFile(item.target, item.source).catch((error) =>
      console.error("[archive:rollback]", item.target, error)
    );
  }
}

function isCrossDeviceError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV";
}

function isPathInside(directory: string, filePath: string) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function createArchiveDirectory(archiveDir: string, date: Date) {
  await mkdir(archiveDir, { recursive: true });
  const timestamp = formatLocalTimestamp(date);

  for (let index = 1; ; index += 1) {
    const directory = path.join(archiveDir, index === 1 ? timestamp : `${timestamp}-${index}`);
    try {
      await mkdir(directory);
      return directory;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  }
}

function isAlreadyExistsError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function formatLocalTimestamp(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}
