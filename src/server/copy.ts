import type { PlatformPost } from "../shared/types.js";

export function formatPostText(post: PlatformPost) {
  const tags = post.hashtags
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(" ");
  return [post.title.trim(), post.body.trim(), tags].filter(Boolean).join("\n\n");
}
