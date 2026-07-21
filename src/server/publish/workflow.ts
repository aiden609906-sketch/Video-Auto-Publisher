import type { Platform, PublishOutcome, PublishStage, StageResult } from "../../shared/types.js";
import { buildPublishOutcome, requiredStagesFor } from "./types.js";
import type { ManagedPlatform, PlatformAdapter, PublishInput } from "./platform-adapter.js";

function managedPlatform(platform: Platform): ManagedPlatform {
  if (platform === "xiaohongshu") {
    throw new Error("Xiaohongshu uses manual-assisted publish mode");
  }

  return platform;
}

function stageOrderFor(adapter: PlatformAdapter, platform: ManagedPlatform): readonly PublishStage[] {
  const required = requiredStagesFor(platform);
  const configured = adapter.stageOrder;
  if (!configured) return required;

  const configuredStages = new Set(configured);
  if (
    configured.length !== required.length ||
    configuredStages.size !== required.length ||
    required.some((stage) => !configuredStages.has(stage))
  ) {
    throw new Error(`Adapter stage order must contain every required ${platform} stage exactly once`);
  }

  return configured;
}

export class PublishWorkflow {
  constructor(private readonly adapter: PlatformAdapter) {}

  async run(input: PublishInput): Promise<PublishOutcome> {
    const platform = managedPlatform(input.platform);
    const results: StageResult[] = [];

    for (const stage of stageOrderFor(this.adapter, platform)) {
      const result = await this.adapter.runStage(stage, input);
      results.push(result);
      if (result.status === "failed") {
        break;
      }
    }

    return buildPublishOutcome(platform, "managed", results, this.adapter.version);
  }
}
