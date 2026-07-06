import {
  Archive,
  BrainCircuit,
  Clipboard,
  Download,
  ExternalLink,
  FileVideo,
  FolderOpen,
  ImageUp,
  Loader2,
  RefreshCcw,
  Save,
  Send,
  Settings,
  Sparkles,
  Trash2,
  UserPlus,
  Wifi
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  PLATFORM_LABELS,
  PLATFORMS,
  type AccountProfile,
  type AiConfigView,
  type AiProvider,
  type AppSettings,
  type DiagnosticSummary,
  type EnvironmentReport,
  type Platform,
  type VideoTask
} from "../shared/types";
import { resolveSelectedVideoId } from "./selection";

type Notice = { type: "ok" | "error"; text: string } | null;
type PublishProgress = {
  running: boolean;
  stage: string;
  startedAt: string;
  updatedAt: string;
};

const aiProviderPresets: Record<AiProvider, { label: string; baseURL: string; model: string }> = {
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1", model: "gpt-5.2" },
  deepseek: { label: "DeepSeek", baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
  qwen: {
    label: "通义千问",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus"
  },
  moonshot: { label: "Kimi", baseURL: "https://api.moonshot.cn/v1", model: "kimi-k2.5" },
  zhipu: {
    label: "智谱 GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash-250414"
  },
  custom: { label: "自定义兼容接口", baseURL: "", model: "" }
};

const statusLabels: Record<string, string> = {
  detected: "已发现",
  drafting: "生成中",
  ready: "待发布",
  opened: "已打开",
  posted: "已完成",
  failed: "失败",
  pending: "待生成",
  skipped: "已跳过"
};

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const isFormData = options?.body instanceof FormData;
  const response = await fetch(url, {
    headers: isFormData ? options?.headers : { "Content-Type": "application/json", ...(options?.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "请求失败");
  return data as T;
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function App() {
  const [videos, setVideos] = useState<VideoTask[]>([]);
  const [accounts, setAccounts] = useState<AccountProfile[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [notice, setNotice] = useState<Notice>(null);
  const [publishProgress, setPublishProgress] = useState<Record<string, PublishProgress>>({});
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticSummary[]>([]);
  const [aiConfig, setAiConfig] = useState<AiConfigView | null>(null);
  const [aiApiKey, setAiApiKey] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const selected = useMemo(
    () => videos.find((video) => video.id === selectedId) || null,
    [selectedId, videos]
  );

  async function refresh() {
    const [nextSettings, nextVideos, nextAccounts, nextEnvironment, nextDiagnostics] = await Promise.all([
      api<AppSettings>("/api/settings"),
      api<VideoTask[]>("/api/videos"),
      api<AccountProfile[]>("/api/accounts"),
      api<EnvironmentReport>("/api/environment"),
      api<DiagnosticSummary[]>("/api/diagnostics")
    ]);
    setSettings((current) =>
      current
        ? {
            ...nextSettings,
            defaultStyle: current.defaultStyle,
            defaultPlatforms: current.defaultPlatforms
          }
        : nextSettings
    );
    setVideos(nextVideos);
    setAccounts(nextAccounts);
    setEnvironment(nextEnvironment);
    setDiagnostics(nextDiagnostics);
    setSelectedId((current) => resolveSelectedVideoId(current, nextVideos));
  }

  async function run<T>(key: string, task: () => Promise<T>, ok?: string) {
    setBusy(key);
    setNotice(null);
    try {
      const result = await task();
      await refresh();
      if (ok) setNotice({ type: "ok", text: ok });
      return result;
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "操作失败" });
      return null;
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    void refresh();
    void api<AiConfigView>("/api/ai-config")
      .then(setAiConfig)
      .catch((error) =>
        setNotice({ type: "error", text: error instanceof Error ? error.message : "读取 AI 配置失败" })
      );
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <FileVideo size={24} />
          <div>
            <h1>自动发布视频</h1>
            <p>
              {settings?.aiConfigured
                ? `${aiProviderPresets[settings.aiProvider].label} · ${settings.aiModel}`
                : "手动文案模式"}
            </p>
          </div>
        </div>

        <div className="folder">
          <FolderOpen size={16} />
          <span title={settings?.inboxDir}>{settings?.inboxDir || "data/inbox"}</span>
        </div>

        <button className="wide" onClick={() => run("scan", () => api("/api/scan", { method: "POST" }), "已扫描文件夹")}>
          {busy === "scan" ? <Loader2 className="spin" size={17} /> : <RefreshCcw size={17} />}
          扫描
        </button>

        <div className="videoList">
          {videos.map((video) => (
            <button
              className={`videoItem ${selected?.id === video.id ? "active" : ""}`}
              key={video.id}
              onClick={() => setSelectedId(video.id)}
            >
              <strong>{video.filename}</strong>
              <span>
                {formatBytes(video.size)} · {statusLabels[video.status]}
              </span>
            </button>
          ))}
          {!videos.length && <div className="empty">等待新视频</div>}
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <h2>{selected?.filename || "没有任务"}</h2>
            <p>{selected ? selected.filePath : "把视频和同名封面放入 inbox 文件夹后点击扫描"}</p>
          </div>
          {selected && (
            <div className="actions">
              <button onClick={() => run(`archive-${selected.id}`, () => api(`/api/videos/${selected.id}/archive`, { method: "POST" }), "视频和封面已按时间归档")}>
                <Archive size={17} />
                归档
              </button>
            </div>
          )}
        </header>

        {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}

        {environment && (
          <section className="systemBand">
            <div className="systemHead">
              <div>
                <strong>系统检测</strong>
                <span>{environment.system.platform} · {environment.system.node}</span>
              </div>
              <div className="systemActions">
                <button onClick={() => run("environment", () => api("/api/environment").then((report) => setEnvironment(report as EnvironmentReport)), "检测已刷新")}>
                  {busy === "environment" ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
                  重新检测
                </button>
                <button onClick={() => resetBrowserProfile()}>
                  {busy === "reset-browser-all" ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
                  重置浏览器环境
                </button>
              </div>
            </div>
            <div className="checkGrid">
              {environment.checks.map((check) => (
                <div className={`checkItem ${check.status}`} key={check.id}>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              ))}
            </div>
            <div className="adapterRow">
              {PLATFORMS.map((platform) => (
                <span key={platform}>{PLATFORM_LABELS[platform]} {environment.adapterVersions[platform]}</span>
              ))}
            </div>
            {!!diagnostics.length && (
              <div className="diagnosticList">
                {diagnostics.slice(0, 3).map((item) => (
                  <a href={`/api/diagnostics/${item.id}/file`} key={item.id} target="_blank" rel="noreferrer">
                    <Download size={14} />
                    {PLATFORM_LABELS[item.platform]} · {item.status === "ok" ? "成功" : "失败"} · {(item.elapsedMs / 1000).toFixed(1)}s
                  </a>
                ))}
              </div>
            )}
          </section>
        )}

        {aiConfig && (
          <section className="aiBand">
            <div className="aiHead">
              <BrainCircuit size={20} />
              <div>
                <strong>AI 文案配置</strong>
                <span>密钥仅保存在当前电脑，不会显示完整内容</span>
              </div>
            </div>
            <label>
              服务商
              <select
                value={aiConfig.provider}
                onChange={(event) => {
                  const provider = event.target.value as AiProvider;
                  const preset = aiProviderPresets[provider];
                  setAiConfig({
                    ...aiConfig,
                    provider,
                    baseURL: preset.baseURL,
                    model: preset.model,
                    apiKeyConfigured: false,
                    apiKeyMasked: ""
                  });
                  setAiApiKey("");
                }}
              >
                {(Object.keys(aiProviderPresets) as AiProvider[]).map((provider) => (
                  <option value={provider} key={provider}>
                    {aiProviderPresets[provider].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              接口地址
              <input
                value={aiConfig.baseURL}
                placeholder="https://example.com/v1"
                onChange={(event) => setAiConfig({ ...aiConfig, baseURL: event.target.value })}
              />
            </label>
            <label>
              模型
              <input
                value={aiConfig.model}
                placeholder="模型名称"
                onChange={(event) => setAiConfig({ ...aiConfig, model: event.target.value })}
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                value={aiApiKey}
                autoComplete="new-password"
                placeholder={aiConfig.apiKeyConfigured ? aiConfig.apiKeyMasked : "请输入 API Key"}
                onChange={(event) => setAiApiKey(event.target.value)}
              />
            </label>
            <div className="aiActions">
              <button onClick={() => saveAiConfig()}>
                {busy === "ai-save" ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                保存配置
              </button>
              <button onClick={() => testAiConnection()}>
                {busy === "ai-test" ? <Loader2 className="spin" size={16} /> : <Wifi size={16} />}
                测试连接
              </button>
            </div>
          </section>
        )}

        {selected && (
          <section className="coverBand">
            {(["landscape", "portrait"] as const).map((orientation) => {
              const cover = selected.covers?.[orientation];
              const label = orientation === "landscape" ? "横屏封面" : "竖屏封面";
              return (
                <div className="coverSlot" key={orientation}>
                  <div className={`coverPreview ${orientation}`}>
                    {cover ? (
                      <img
                        src={`/api/videos/${selected.id}/covers/${orientation}/file?ts=${encodeURIComponent(cover.updatedAt)}`}
                        alt={label}
                      />
                    ) : (
                      <ImageUp size={30} />
                    )}
                  </div>
                  <div className="coverMeta">
                    <strong>{label}</strong>
                    <span>
                      {cover
                        ? `${cover.width}x${cover.height} · ${cover.source === "manual" ? "手动上传" : "自动扫描"}`
                        : "点击扫描匹配同名图片，或手动上传"}
                    </span>
                    <label className="uploadButton">
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.currentTarget.value = "";
                          if (file) void uploadCover(selected.id, orientation, file);
                        }}
                      />
                      <ImageUp size={16} />
                      上传{orientation === "landscape" ? "横图" : "竖图"}
                    </label>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {settings && (
          <section className="settingsBand">
            <div className="settingsHead">
              <Settings size={19} />
              <div>
                <strong>AI 标题与正文生成要求</strong>
                <span>在这里描述文案风格、语气和限制。AI 会根据这些要求生成各平台的标题与正文。</span>
              </div>
            </div>
            <textarea
              aria-label="AI 标题与正文生成要求"
              placeholder="例如：语言简洁自然，突出实用价值；标题有吸引力但不夸张；正文避免绝对化表达。"
              value={settings.defaultStyle}
              onChange={(event) => setSettings({ ...settings, defaultStyle: event.target.value })}
              onBlur={() => saveDefaultSettings()}
            />
            <div className="styleActions">
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => saveDefaultSettings(true)}
              >
                {busy === "settings" ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                保存生成要求
              </button>
              <button
                className="generateDraftButton"
                disabled={!selected || busy === `gen-${selected?.id}`}
                onClick={() =>
                  selected &&
                  run(
                    `gen-${selected.id}`,
                    () => api(`/api/videos/${selected.id}/generate`, { method: "POST" }),
                    "文案已生成"
                  )
                }
              >
                {busy === `gen-${selected?.id}` ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
                生成文案
              </button>
            </div>
          </section>
        )}

        {selected ? (
          <div className="postGrid">
            {selected.posts.map((post) => {
              const progress = publishProgress[post.id];
              const isOpening = busy === `${post.id}-open`;
              const platformAccounts = accounts.filter((account) => account.platform === post.platform);
              const activeAccount = platformAccounts.find((account) => account.id === post.accountId) || platformAccounts[0];
              const elapsedSeconds =
                progress?.startedAt && Date.parse(progress.startedAt) > 0
                  ? Math.max(0, Math.floor((now - Date.parse(progress.startedAt)) / 1000))
                  : 0;
              return (
              <section className="postCard" key={post.id}>
                <div className="postHead">
                  <label className="platformCheck">
                    <input
                      type="checkbox"
                      checked={post.enabled}
                      onChange={(event) =>
                        run(`${post.id}-enable`, () =>
                          api(`/api/videos/${selected.id}/posts/${post.platform}`, {
                            method: "PATCH",
                            body: JSON.stringify({
                              enabled: event.target.checked,
                              status: event.target.checked ? "ready" : "skipped"
                            })
                          })
                        )
                      }
                    />
                    <span>{PLATFORM_LABELS[post.platform]}</span>
                  </label>
                  <span className={`pill ${post.status}`}>{statusLabels[post.status]}</span>
                </div>

                <div className="accountRow">
                  <label className="field accountSelect">
                    发布账号
                    <select
                      value={activeAccount?.id || ""}
                      onChange={(event) => {
                        const accountId = event.target.value;
                        patchLocal(selected.id, post.platform, { accountId });
                        void run(`${post.id}-account`, () =>
                          api(`/api/videos/${selected.id}/posts/${post.platform}`, {
                            method: "PATCH",
                            body: JSON.stringify({ accountId })
                          })
                        );
                      }}
                    >
                      {platformAccounts.map((account) => (
                        <option value={account.id} key={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="accountActions">
                    <button title="新增账号" onClick={() => addAccount(post.platform, selected.id)}>
                      <UserPlus size={16} />
                    </button>
                    <button title="重命名账号" disabled={!activeAccount} onClick={() => activeAccount && renameAccount(activeAccount)}>
                      <Save size={16} />
                    </button>
                    <button
                      title="删除账号"
                      disabled={!activeAccount || activeAccount.isDefault}
                      onClick={() => activeAccount && deleteAccount(activeAccount)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <label className="field">
                  标题
                  <input
                    value={post.title}
                    onChange={(event) => patchLocal(selected.id, post.platform, { title: event.target.value })}
                    onBlur={() => savePost(selected.id, post.platform)}
                  />
                </label>
                <label className="field">
                  正文
                  <textarea
                    className="bodyInput"
                    value={post.body}
                    onChange={(event) => patchLocal(selected.id, post.platform, { body: event.target.value })}
                    onBlur={() => savePost(selected.id, post.platform)}
                  />
                </label>
                <label className="field">
                  话题
                  <input
                    value={post.hashtags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}
                    onChange={(event) =>
                      patchLocal(selected.id, post.platform, {
                        hashtags: event.target.value.split(/\s+/).map((tag) => tag.replace(/^#/, "")).filter(Boolean)
                      })
                    }
                    onBlur={() => savePost(selected.id, post.platform)}
                  />
                </label>

                <div className="postActions">
                  <button
                    disabled={!post.enabled}
                    title="复制当前平台文案"
                    onClick={() =>
                      run(`${post.id}-copy`, () => api(`/api/videos/${selected.id}/posts/${post.platform}/copy`, { method: "POST" }), "文案已复制")
                    }
                  >
                    <Clipboard size={17} />
                    复制
                  </button>
                  <button
                    disabled={!post.enabled || isOpening}
                    title="打开平台发布页"
                    onClick={() => openPost(selected.id, post.platform, post.id, activeAccount?.id || post.accountId)}
                  >
                    {isOpening ? <Loader2 className="spin" size={17} /> : <ExternalLink size={17} />}
                    {isOpening ? "自动操作中" : "打开发布"}
                  </button>
                  <button
                    disabled={!post.enabled}
                    title="标记为已发布"
                    onClick={() =>
                      run(`${post.id}-posted`, () =>
                        api(`/api/videos/${selected.id}/posts/${post.platform}`, {
                          method: "PATCH",
                          body: JSON.stringify({ status: "posted" })
                        })
                      )
                    }
                  >
                    <Send size={17} />
                    已发布
                  </button>
                  <button
                    disabled={!post.enabled}
                    title="清理当前账号的浏览器登录环境"
                    onClick={() => resetBrowserProfile(post.platform, post.accountId)}
                  >
                    <RefreshCcw size={17} />
                    重置账号
                  </button>
                </div>
                {progress && (
                  <div className={`publishProgress ${progress.running ? "running" : ""}`}>
                    <Loader2 className={progress.running ? "spin" : ""} size={16} />
                    <div>
                      <strong>{progress.stage}</strong>
                      <span>
                        {progress.running
                          ? `已耗时 ${elapsedSeconds} 秒，请不要关闭浏览器`
                          : `结束于 ${new Date(progress.updatedAt).toLocaleTimeString()}`}
                      </span>
                    </div>
                  </div>
                )}
              </section>
              );
            })}
          </div>
        ) : (
          <div className="emptyState">暂无视频任务</div>
        )}
      </section>
    </main>
  );

  function patchLocal(videoId: string, platform: Platform, patch: Partial<VideoTask["posts"][number]>) {
    setVideos((current) =>
      current.map((video) =>
        video.id !== videoId
          ? video
          : {
              ...video,
              posts: video.posts.map((post) => (post.platform === platform ? { ...post, ...patch } : post))
            }
      )
    );
  }

  function aiConfigBody() {
    if (!aiConfig) throw new Error("AI 配置尚未加载");
    return {
      provider: aiConfig.provider,
      baseURL: aiConfig.baseURL.trim(),
      model: aiConfig.model.trim(),
      ...(aiApiKey.trim() ? { apiKey: aiApiKey.trim() } : {})
    };
  }

  async function saveAiConfig() {
    await run(
      "ai-save",
      async () => {
        const saved = await api<AiConfigView>("/api/ai-config", {
          method: "PATCH",
          body: JSON.stringify(aiConfigBody())
        });
        setAiConfig(saved);
        setAiApiKey("");
        return saved;
      },
      "AI 配置已保存"
    );
  }

  async function testAiConnection() {
    await run(
      "ai-test",
      async () => {
        const saved = await api<AiConfigView>("/api/ai-config", {
          method: "PATCH",
          body: JSON.stringify(aiConfigBody())
        });
        setAiConfig(saved);
        setAiApiKey("");
        return api<{ ok: boolean; response: string }>("/api/ai-config/test", { method: "POST" });
      },
      "AI 模型连接成功"
    );
  }

  function saveDefaultSettings(showNotice = false) {
    if (!settings) return;
    void run(
      "settings",
      () =>
        api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({
            defaultStyle: settings.defaultStyle
          })
        }),
      showNotice ? "AI 生成要求已保存" : undefined
    );
  }

  function savePost(videoId: string, platform: Platform) {
    const post = videos.find((video) => video.id === videoId)?.posts.find((item) => item.platform === platform);
    if (!post) return;
    void run(`${post.id}-save`, () =>
      api(`/api/videos/${videoId}/posts/${platform}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: post.title,
          body: post.body,
          hashtags: post.hashtags
        })
      })
    );
  }

  async function uploadCover(videoId: string, orientation: "landscape" | "portrait", file: File) {
    const body = new FormData();
    body.append("cover", file);
    await run(`${videoId}-${orientation}-cover`, () =>
      api(`/api/videos/${videoId}/covers/${orientation}`, {
        method: "POST",
        body
      }),
      "封面已上传"
    );
  }

  async function addAccount(platform: Platform, videoId?: string) {
    const name = window.prompt(`请输入${PLATFORM_LABELS[platform]}账号名称`, `${PLATFORM_LABELS[platform]}账号${accounts.filter((account) => account.platform === platform).length + 1}`);
    if (name === null) return;
    await run(
      `account-add-${platform}`,
      async () => {
        const account = await api<AccountProfile>("/api/accounts", {
          method: "POST",
          body: JSON.stringify({ platform, name })
        });
        if (videoId) {
          await api(`/api/videos/${videoId}/posts/${platform}`, {
            method: "PATCH",
            body: JSON.stringify({ accountId: account.id })
          });
        }
        return account;
      },
      videoId ? "账号已添加，并已切换当前任务" : "账号已添加"
    );
  }

  async function renameAccount(account: AccountProfile) {
    const name = window.prompt("请输入新的账号名称", account.name);
    if (name === null) return;
    await run(
      `account-rename-${account.id}`,
      () =>
        api<AccountProfile>(`/api/accounts/${account.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name })
        }),
      "账号名称已保存"
    );
  }

  async function deleteAccount(account: AccountProfile) {
    if (account.isDefault) return;
    if (!window.confirm(`将删除账号“${account.name}”及其浏览器登录环境，相关发布任务会回到默认账号。确定继续吗？`)) return;
    await run(
      `account-delete-${account.id}`,
      () => api<AccountProfile[]>(`/api/accounts/${account.id}`, { method: "DELETE" }),
      "账号已删除"
    );
  }

  async function resetBrowserProfile(platform?: Platform, accountId?: string) {
    const account = accountId ? accounts.find((item) => item.id === accountId) : null;
    const label = account ? `${PLATFORM_LABELS[account.platform]}-${account.name}` : platform ? PLATFORM_LABELS[platform] : "全部平台";
    if (!window.confirm(`将清理 ${label} 的浏览器登录环境，之后需要重新登录。确定继续吗？`)) return;
    await run(
      accountId ? `reset-browser-${accountId}` : platform ? `reset-browser-${platform}` : "reset-browser-all",
      () =>
        api("/api/browser-profiles/reset", {
          method: "POST",
          body: JSON.stringify(accountId ? { accountId } : platform ? { platform } : {})
        }),
      `${label} 浏览器环境已重置`
    );
  }

  async function syncPublishProgress(videoId: string, platform: Platform, postId: string) {
    try {
      const progress = await api<PublishProgress>(`/api/videos/${videoId}/posts/${platform}/progress`);
      setPublishProgress((current) => ({ ...current, [postId]: progress }));
    } catch {
      // Progress polling is only a UI aid; the main publish request still reports failures.
    }
  }

  async function openPost(videoId: string, platform: Platform, postId: string, accountId: string) {
    const startedAt = new Date().toISOString();
    setPublishProgress((current) => ({
      ...current,
      [postId]: {
        running: true,
        stage: "正在启动发布辅助",
        startedAt,
        updatedAt: startedAt
      }
    }));
    const timer = window.setInterval(() => void syncPublishProgress(videoId, platform, postId), 1000);
    await run(
      `${postId}-open`,
      async () => {
        const response = await api<{
          result: {
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
        }>(`/api/videos/${videoId}/posts/${platform}/open`, {
          method: "POST",
          body: JSON.stringify({ accountId })
        });
        const result = response.result;
        if (result.loginRequired) {
          setNotice({ type: "error", text: "请先在打开的浏览器中登录该平台，登录完成后再点一次打开发布" });
        } else if (result.browserMode === "manual") {
          setNotice({
            type: "ok",
            text: "小红书已改为人工上传模式：已复制文案，并用当前账号的独立浏览器窗口打开发布页和素材文件夹，请在网页里手动选择视频/封面后发布"
          });
        } else {
          const fields = [
            { label: "视频", done: result.uploadPrefilled, expected: true },
            { label: "标题", done: result.titlePrefilled, expected: platform !== "kuaishou" },
            { label: "正文", done: result.bodyPrefilled, expected: true },
            { label: "话题", done: result.tagsPrefilled, expected: true },
            { label: "封面", done: result.coverPrefilled, expected: true },
            { label: "作者声明", done: result.declarationPrefilled, expected: ["douyin", "kuaishou", "bilibili"].includes(platform) }
          ].filter((field) => field.expected);
          const filled = fields.filter((field) => field.done).map((field) => field.label);
          const missing = fields.filter((field) => !field.done).map((field) => field.label);
          setNotice({
            type: missing.length ? "error" : "ok",
            text: [`已处理：${filled.join("、") || "文案复制"}`, missing.length ? `未处理：${missing.join("、")}` : ""]
              .filter(Boolean)
              .join("；")
          });
        }
        return response;
      }
    );
    window.clearInterval(timer);
    await syncPublishProgress(videoId, platform, postId);
  }
}
