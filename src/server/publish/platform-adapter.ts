import type { Platform, PlatformPost, PublishStage, StageResult } from "../../shared/types.js";

export type CoverPaths = {
  landscape: string | null;
  portrait: string | null;
};

export type PublishInput = {
  platform: Platform;
  accountId: string;
  filePath: string;
  post: PlatformPost;
  covers: CoverPaths;
};

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly version: string;
  runStage(stage: PublishStage, input: PublishInput): Promise<StageResult>;
}
