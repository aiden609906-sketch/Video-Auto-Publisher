import type { PublishOutcome, StageResult } from "../../shared/types.js";
import { buildPublishOutcome, requiredStagesFor } from "./types.js";
import type { PlatformAdapter, PublishInput } from "./platform-adapter.js";

export class PublishWorkflow {
  constructor(private readonly adapter: PlatformAdapter) {}

  async run(input: PublishInput): Promise<PublishOutcome> {
    const results: StageResult[] = [];

    for (const stage of requiredStagesFor(input.platform)) {
      const result = await this.adapter.runStage(stage, input);
      results.push(result);
      if (result.status === "failed") {
        break;
      }
    }

    return buildPublishOutcome(input.platform, "managed", results, this.adapter.version);
  }
}
