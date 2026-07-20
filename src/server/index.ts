import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { imageSizeFromFile } from "image-size/fromFile";
import multer from "multer";
import { AiConfigStore } from "./ai-config.js";
import { archiveTaskFiles } from "./archive.js";
import { config } from "./config.js";
import { Diagnostics } from "./diagnostics.js";
import { getEnvironmentReport } from "./environment.js";
import { DraftGenerator } from "./openai.js";
import { resolvePublishAccount } from "./publish-account.js";
import { ADAPTER_VERSIONS, Publisher } from "./publisher.js";
import { PublishAccountBusyError } from "./publish/account-lock.js";
import { mapPublishOutcome, normalizePublishOutcome } from "./publish/result-mapping.js";
import { VideoScanner } from "./scanner.js";
import { Store } from "./store.js";
import {
  PLATFORMS,
  type AiConfigUpdate,
  type CoverOrientation,
  type Platform,
  type PostStatus,
  type VideoStatus,
  type VideoTask
} from "../shared/types.js";

const app = express();
const store = new Store(config.stateFile);
const aiConfig = new AiConfigStore(config.aiConfigFile, {
  provider: config.aiProvider as AiConfigUpdate["provider"],
  baseURL: config.aiBaseURL,
  apiKey: config.aiApiKey,
  model: config.aiModel
});
const publisher = new Publisher(config.browserProfilesDir);
const diagnostics = new Diagnostics(config.diagnosticsDir);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

type PublishProgress = {
  running: boolean;
  stage: string;
  startedAt: string;
  updatedAt: string;
};

const publishProgress = new Map<string, PublishProgress>();

await Promise.all([
  store.init(),
  aiConfig.init(),
  mkdir(config.inboxDir, { recursive: true }),
  mkdir(config.archiveDir, { recursive: true }),
  mkdir(config.coversDir, { recursive: true }),
  mkdir(config.browserProfilesDir, { recursive: true }),
  diagnostics.init()
]);

const generator = new DraftGenerator(aiConfig.get());

async function generateDrafts(videoId: string) {
  const video = store.getVideo(videoId);
  if (!video) throw new Error("Video task not found");
  await store.updateVideo(video.id, { status: "drafting" });
  try {
    const drafts = await generator.generate(video, store.getSettings().defaultStyle);
    return await store.applyDrafts(video.id, drafts);
  } catch (error) {
    await store.updateVideo(video.id, { status: "failed" });
    throw error;
  }
}

const scanner = new VideoScanner(config.inboxDir, store, async (video) => {
  try {
    await generateDrafts(video.id);
  } catch (error) {
    console.error("[draft]", error);
  }
});
await scanner.start();

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/settings", (_req, res) => {
  res.json({
    ...store.getSettings(),
    inboxDir: config.inboxDir,
    archiveDir: config.archiveDir,
    aiConfigured: generator.configured,
    aiProvider: generator.provider,
    aiModel: generator.model
  });
});

app.get("/api/accounts", (_req, res) => {
  res.json(store.listAccounts());
});

app.post("/api/accounts", async (req, res) => {
  const platform = requirePlatform(param(req.body?.platform));
  const name = typeof req.body?.name === "string" ? req.body.name : "";
  res.json(await store.addAccount(platform, name));
});

app.patch("/api/accounts/:id", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name : undefined;
  res.json(await store.updateAccount(param(req.params.id), { ...(name !== undefined ? { name } : {}) }));
});

app.delete("/api/accounts/:id", async (req, res) => {
  const account = requireAccount(param(req.params.id));
  const accounts = await store.deleteAccount(account.id);
  await publisher.resetProfile(account.platform, account.id);
  res.json(accounts);
});

app.get("/api/ai-config", (_req, res) => {
  res.json(aiConfig.view());
});

app.patch("/api/ai-config", async (req, res) => {
  const view = await aiConfig.update(req.body as AiConfigUpdate);
  generator.configure(aiConfig.get());
  res.json(view);
});

app.post("/api/ai-config/test", async (_req, res) => {
  res.json(await generator.testConnection());
});

app.get("/api/environment", async (_req, res) => {
  res.json(
    await getEnvironmentReport([
      { id: "inbox", label: "Inbox 目录", path: config.inboxDir, writable: true },
      { id: "archive", label: "归档目录", path: config.archiveDir, writable: true },
      { id: "covers", label: "封面目录", path: config.coversDir, writable: true },
      { id: "profiles", label: "浏览器资料目录", path: config.browserProfilesDir, writable: true },
      { id: "diagnostics", label: "诊断目录", path: config.diagnosticsDir, writable: true }
    ])
  );
});

app.get("/api/diagnostics", async (_req, res) => {
  res.json(await diagnostics.list());
});

app.get("/api/diagnostics/:id/file", (req, res) => {
  res.sendFile(diagnostics.filePath(param(req.params.id)));
});

app.post("/api/browser-profiles/reset", async (req, res) => {
  const accountId = typeof req.body?.accountId === "string" ? param(req.body.accountId) : "";
  if (accountId) {
    const account = requireAccount(accountId);
    await publisher.resetProfile(account.platform, account.id);
    res.json({ ok: true, platform: account.platform, accountId: account.id });
    return;
  }
  const platform = req.body?.platform ? requirePlatform(param(req.body.platform)) : undefined;
  await publisher.resetProfile(platform);
  res.json({ ok: true, platform: platform || null, accountId: null });
});

app.patch("/api/settings", async (req, res) => {
  const { defaultStyle, defaultPlatforms } = req.body as {
    defaultStyle?: string;
    defaultPlatforms?: Platform[];
  };
  const validPlatforms = defaultPlatforms?.filter((platform) => PLATFORMS.includes(platform));
  res.json(
    await store.updateSettings({
      ...(typeof defaultStyle === "string" ? { defaultStyle: defaultStyle.trim() } : {}),
      ...(validPlatforms ? { defaultPlatforms: validPlatforms } : {})
    })
  );
});

app.get("/api/videos", (_req, res) => {
  res.json(store.listVideos());
});

app.post("/api/scan", async (_req, res) => {
  await scanner.scanNow();
  res.json({ ok: true });
});

app.patch("/api/videos/:id", async (req, res) => {
  const { note, status } = req.body as { note?: string; status?: VideoStatus };
  res.json(
    await store.updateVideo(param(req.params.id), {
      ...(typeof note === "string" ? { note } : {}),
      ...(status ? { status } : {})
    })
  );
});

app.post("/api/videos/:id/generate", async (req, res) => {
  res.json(await generateDrafts(param(req.params.id)));
});

app.get("/api/videos/:id/covers/:orientation/file", async (req, res) => {
  const video = requireVideo(param(req.params.id));
  const orientation = requireOrientation(param(req.params.orientation));
  const cover = video.covers[orientation];
  if (!cover) throw new Error("Cover not found");
  res.sendFile(cover.filePath);
});

app.post("/api/videos/:id/covers/:orientation", upload.single("cover"), async (req, res) => {
  const video = requireVideo(param(req.params.id));
  const orientation = requireOrientation(param(req.params.orientation));
  if (!req.file) throw new Error("No cover file uploaded");
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) throw new Error("Cover must be jpg, png, or webp");

  const coverDir = path.join(config.coversDir, video.id);
  await mkdir(coverDir, { recursive: true });
  const target = path.join(coverDir, `${orientation}${ext}`);
  await writeFile(target, req.file.buffer);

  const size = await imageSizeFromFile(target);
  if (!size.width || !size.height) {
    await unlink(target).catch(() => undefined);
    throw new Error("Cannot read cover dimensions");
  }
  const actual: CoverOrientation = size.width >= size.height ? "landscape" : "portrait";
  if (actual !== orientation) {
    await unlink(target).catch(() => undefined);
    throw new Error(orientation === "landscape" ? "Please upload a landscape cover" : "Please upload a portrait cover");
  }

  res.json(
    await store.updateCover(video.id, orientation, {
      filePath: target,
      filename: req.file.originalname,
      width: size.width,
      height: size.height,
      source: "manual",
      updatedAt: new Date().toISOString()
    })
  );
});

app.patch("/api/videos/:id/posts/:platform", async (req, res) => {
  const platform = requirePlatform(param(req.params.platform));
  const body = req.body as {
    accountId?: string;
    enabled?: boolean;
    title?: string;
    body?: string;
    hashtags?: string[];
    status?: PostStatus;
  };
  res.json(await store.updatePost(param(req.params.id), platform, body));
});

app.post("/api/videos/:id/posts/:platform/copy", async (req, res) => {
  const platform = requirePlatform(param(req.params.platform));
  const video = requireVideo(param(req.params.id));
  const post = video.posts.find((item) => item.platform === platform)!;
  await publisher.copy(post);
  res.json({ ok: true });
});

app.get("/api/videos/:id/posts/:platform/progress", (req, res) => {
  const platform = requirePlatform(param(req.params.platform));
  const videoId = param(req.params.id);
  res.json(
    publishProgress.get(progressKey(videoId, platform)) || {
      running: false,
      stage: "\u5c1a\u672a\u5f00\u59cb\u81ea\u52a8\u64cd\u4f5c",
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }
  );
});

app.post("/api/videos/:id/posts/:platform/open", async (req, res) => {
  const platform = requirePlatform(param(req.params.platform));
  const video = requireVideo(param(req.params.id));
  const post = video.posts.find((item) => item.platform === platform)!;
  const requestedAccountId = typeof req.body?.accountId === "string" ? param(req.body.accountId) : "";
  const account = resolvePublishAccount(post, requestedAccountId, (id) => store.getAccount(id));
  if (post.accountId !== account.id) await store.updatePost(video.id, platform, { accountId: account.id });
  const key = progressKey(video.id, platform);
  const startedAt = new Date().toISOString();
  const progressHistory: Array<{ stage: string; at: string }> = [];
  const setProgress = (stage: string, running = true) => {
    progressHistory.push({ stage, at: new Date().toISOString() });
    publishProgress.set(key, {
      running,
      stage,
      startedAt,
      updatedAt: new Date().toISOString()
    });
  };

  setProgress("\u6b63\u5728\u542f\u52a8\u53d1\u5e03\u8f85\u52a9");
  try {
    const started = Date.now();
    const result = await publisher.open(platform, account.id, video.filePath, post, selectCovers(video), setProgress);
    const outcome = normalizePublishOutcome(platform, ADAPTER_VERSIONS[platform], result);
    const mapped = mapPublishOutcome(outcome);
    console.log("[publisher:result]", platform, result);
    setProgress(`${mapped.progressLabel}\uff0c\u6b63\u5728\u5237\u65b0\u4efb\u52a1\u72b6\u6001`);
    const updated = await store.updatePost(video.id, platform, {
      status: mapped.postStatus,
      lastError: mapped.postStatus === "failed" ? mapped.progressLabel : null
    });
    await store.updateVideo(video.id, { status: mapped.videoStatus });
    await diagnostics.write({
      createdAt: new Date().toISOString(),
      platform,
      accountId: account.id,
      accountName: account.name,
      videoId: video.id,
      filename: video.filename,
      status: mapped.diagnosticStatus,
      elapsedMs: Date.now() - started,
      adapterVersion: outcome.adapterVersion,
      startedAt,
      completedAt: new Date().toISOString(),
      progress: progressHistory,
      result: outcome
    });
    setProgress(mapped.progressLabel, false);
    res.status(mapped.httpStatus).json({ result: { ...result, ...outcome }, video: updated });
  } catch (error) {
    if (error instanceof PublishAccountBusyError) {
      const message = "\u8be5\u8d26\u53f7\u5df2\u6709\u53d1\u5e03\u4efb\u52a1\u6b63\u5728\u8fd0\u884c";
      setProgress(message, false);
      res.status(409).json({ code: error.code, error: message });
      return;
    }
    const message = error instanceof Error ? error.message : "\u672a\u77e5\u9519\u8bef";
    setProgress(`\u53d1\u5e03\u8f85\u52a9\u5931\u8d25\uff1a${message}`, false);
    await diagnostics.write({
      createdAt: new Date().toISOString(),
      platform,
      accountId: account.id,
      accountName: account.name,
      videoId: video.id,
      filename: video.filename,
      status: "error",
      elapsedMs: Date.now() - Date.parse(startedAt),
      adapterVersion: ADAPTER_VERSIONS[platform],
      startedAt,
      completedAt: new Date().toISOString(),
      progress: progressHistory,
      error: message
    });
    await store.updatePost(video.id, platform, { status: "failed", lastError: message }).catch(() => undefined);
    throw error;
  }
});

app.post("/api/videos/:id/archive", async (req, res) => {
  await scanner.scanNow();
  const video = requireVideo(param(req.params.id));
  const archived = await archiveTaskFiles(video, config.inboxDir, config.archiveDir);
  res.json({
    video: await store.archiveVideo(video.id, archived.videoPath, archived.covers),
    archiveDir: archived.directory,
    movedFiles: archived.movedFiles
  });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("[api]", error);
  res.status(400).json({ error: message });
});

const distDir = path.join(config.root, "dist");
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));

app.listen(config.port, "127.0.0.1", () => {
  console.log(`API server: http://127.0.0.1:${config.port}`);
  console.log(`Inbox: ${config.inboxDir}`);
});

function requirePlatform(value: string) {
  if (!PLATFORMS.includes(value as Platform)) throw new Error("Unsupported platform");
  return value as Platform;
}

function param(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function progressKey(videoId: string, platform: Platform) {
  return `${videoId}:${platform}`;
}

function requireOrientation(value: string) {
  if (value !== "landscape" && value !== "portrait") throw new Error("Unsupported cover orientation");
  return value;
}

function requireVideo(id: string) {
  const video = store.getVideo(id);
  if (!video) throw new Error("Video task not found");
  return video;
}

function requireAccount(id: string) {
  const account = store.getAccount(id);
  if (!account) throw new Error("Account not found");
  return account;
}

function selectCovers(video: VideoTask) {
  return {
    landscape: video.covers.landscape?.filePath || null,
    portrait: video.covers.portrait?.filePath || null
  };
}
