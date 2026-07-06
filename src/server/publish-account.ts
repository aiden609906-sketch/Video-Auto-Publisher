import type { AccountProfile, PlatformPost } from "../shared/types.js";

export function resolvePublishAccount(
  post: PlatformPost,
  requestedAccountId: string,
  getAccount: (id: string) => AccountProfile | undefined
) {
  const accountId = requestedAccountId || post.accountId;
  const account = getAccount(accountId);
  if (!account) throw new Error("账号不存在");
  if (account.platform !== post.platform) throw new Error("账号不属于当前平台");
  return account;
}
