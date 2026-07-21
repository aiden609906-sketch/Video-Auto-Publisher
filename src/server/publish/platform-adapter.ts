import type { Platform, PlatformPost, PublishStage, StageResult } from "../../shared/types.js";

export type ManagedPlatform = Exclude<Platform, "xiaohongshu">;
export type ManagedPlatformPost = Omit<PlatformPost, "platform"> & { platform: ManagedPlatform };

export type CoverPaths = {
  landscape: string | null;
  portrait: string | null;
};

export type PublishInput = {
  platform: ManagedPlatform;
  accountId: string;
  filePath: string;
  post: ManagedPlatformPost;
  covers: CoverPaths;
};

export interface PlatformAdapter {
  readonly platform: ManagedPlatform;
  readonly version: string;
  readonly stageOrder?: readonly PublishStage[];
  runStage(stage: PublishStage, input: PublishInput): Promise<StageResult>;
}
