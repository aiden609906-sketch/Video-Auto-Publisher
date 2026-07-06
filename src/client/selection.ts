import type { VideoTask } from "../shared/types";

export function resolveSelectedVideoId(currentSelectedId: string, videos: VideoTask[]) {
  if (currentSelectedId && videos.some((video) => video.id === currentSelectedId)) return currentSelectedId;
  return videos[0]?.id || "";
}
