import type { Platform, PublishOutcome, StageResult } from "../../shared/types.js";
import { buildPublishOutcome, requiredStagesFor } from "./types.js";
import type { ManagedPlatform, PlatformAdapter, PublishInput } from "./platform-adapter.js";

function managedPlatform(platform: Platform): ManagedPlatform {
  if (platform === "xiaohongshu") {
    throw new Error("Xiaohongshu uses manual-assisted publish mode");
  }

  return platform;
}

export class PublishWorkflow {
  constructor(private readonly adapter: PlatformAdapter) {}

  async run(input: PublishInput): Promise<PublishOutcome> {
    const platform = managedPlatform(input.platform);
    const results: StageResult[] = [];

    for (const stage of requiredStagesFor(platform)) {
      const result = await this.adapter.runStage(stage, input);
      results.push(result);
      if (result.status === "failed") {
        break;
      }
    }

    return buildPublishOutcome(platform, "managed", results, this.adapter.version);
  }
}
