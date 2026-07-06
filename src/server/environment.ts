import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserInstallation, EnvironmentCheck, EnvironmentReport } from "../shared/types.js";
import { ADAPTER_VERSIONS, BROWSER_CHANNELS } from "./publisher.js";

type PathCheck = {
  id: string;
  label: string;
  path: string;
  writable?: boolean;
};

export async function getEnvironmentReport(paths: PathCheck[]): Promise<EnvironmentReport> {
  const browsers = await detectBrowsers();
  const checks: EnvironmentCheck[] = [
    {
      id: "os",
      label: "操作系统",
      status: process.platform === "win32" ? "ok" : "warn",
      detail: process.platform === "win32" ? "Windows 环境" : `当前是 ${process.platform}，主要测试范围是 Windows`
    },
    {
      id: "node",
      label: "Node.js",
      status: Number(process.versions.node.split(".")[0]) >= 20 ? "ok" : "warn",
      detail: process.version
    },
    {
      id: "browser",
      label: "浏览器",
      status: browsers.some((browser) => browser.available) ? "ok" : "error",
      detail: browsers.some((browser) => browser.available)
        ? browsers.filter((browser) => browser.available).map((browser) => browser.label).join("、")
        : "未检测到 Edge 或 Chrome"
    },
    ...(await Promise.all(paths.map(checkPath)))
  ];

  return {
    generatedAt: new Date().toISOString(),
    system: {
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      cwd: process.cwd()
    },
    browsers,
    adapterVersions: ADAPTER_VERSIONS,
    checks
  };
}

async function checkPath(input: PathCheck): Promise<EnvironmentCheck> {
  try {
    await access(input.path, constants.R_OK);
    if (input.writable) {
      await access(input.path, constants.W_OK);
    }
    return {
      id: input.id,
      label: input.label,
      status: "ok",
      detail: input.path
    };
  } catch (error) {
    return {
      id: input.id,
      label: input.label,
      status: "error",
      detail: `${input.path} 不可访问：${error instanceof Error ? error.message : "未知错误"}`
    };
  }
}

export async function detectBrowsers(): Promise<BrowserInstallation[]> {
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    {
      channel: "msedge" as const,
      label: "Microsoft Edge",
      paths:
        process.platform === "win32"
          ? [
              "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
              "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
              path.join(localAppData, "Microsoft\\Edge\\Application\\msedge.exe")
            ]
          : []
    },
    {
      channel: "chrome" as const,
      label: "Google Chrome",
      paths:
        process.platform === "win32"
          ? [
              "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
              "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
              path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe")
            ]
          : []
    }
  ];

  const results: BrowserInstallation[] = [];
  for (const candidate of candidates) {
    const installedPath = await firstAccessiblePath(candidate.paths);
    results.push({
      channel: candidate.channel,
      label: candidate.label,
      available: Boolean(installedPath),
      path: installedPath,
      recommended: candidate.channel === BROWSER_CHANNELS[0]
    });
  }
  return results;
}

async function firstAccessiblePath(paths: string[]) {
  for (const candidate of paths) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue checking fallback paths.
    }
  }
  return null;
}
