import path from "node:path";
import { PLATFORMS, type AccountProfile, type Platform } from "../shared/types.js";

export const DEFAULT_ACCOUNT_NAME = "\u9ed8\u8ba4\u8d26\u53f7";

export function defaultAccountId(platform: Platform) {
  return `default-${platform}`;
}

export function ensureDefaultAccounts(accounts: AccountProfile[] | undefined, now = new Date().toISOString()) {
  const next = [...(accounts || [])];
  for (const platform of PLATFORMS) {
    const defaultId = defaultAccountId(platform);
    const existing = next.find((account) => account.id === defaultId || (account.platform === platform && account.isDefault));
    if (existing) {
      existing.id = defaultId;
      existing.platform = platform;
      existing.name = existing.name?.trim() || DEFAULT_ACCOUNT_NAME;
      existing.isDefault = true;
      existing.createdAt ||= now;
      existing.updatedAt ||= existing.createdAt;
      continue;
    }
    next.push({
      id: defaultId,
      platform,
      name: DEFAULT_ACCOUNT_NAME,
      isDefault: true,
      createdAt: now,
      updatedAt: now
    });
  }
  return next;
}

export function getProfileDir(profilesDir: string, platform: Platform, accountId: string) {
  if (accountId === defaultAccountId(platform)) return path.join(profilesDir, platform);
  return path.join(profilesDir, "accounts", platform, accountId);
}
