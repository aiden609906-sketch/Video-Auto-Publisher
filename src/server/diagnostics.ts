import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DiagnosticSummary, Platform } from "../shared/types.js";

export type DiagnosticRecord = DiagnosticSummary & {
  accountId?: string;
  accountName?: string;
  adapterVersion: string;
  startedAt: string;
  completedAt: string;
  progress: Array<{ stage: string; at: string }>;
  result?: unknown;
  error?: string;
};

export class Diagnostics {
  constructor(private readonly dir: string) {}

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  async write(input: Omit<DiagnosticRecord, "id" | "filePath">) {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${input.platform}-${randomUUID().slice(0, 8)}`;
    const filePath = path.join(this.dir, `${id}.json`);
    const record: DiagnosticRecord = {
      id,
      filePath,
      ...input
    };
    await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
    return record;
  }

  async list(limit = 20): Promise<DiagnosticSummary[]> {
    const files = (await readdir(this.dir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit);

    const summaries: DiagnosticSummary[] = [];
    for (const file of files) {
      try {
        const record = JSON.parse(await readFile(path.join(this.dir, file), "utf8")) as DiagnosticRecord;
        if (!isDiagnosticRecord(record)) continue;
        summaries.push({
          id: record.id,
          createdAt: record.createdAt,
          platform: record.platform,
          videoId: record.videoId,
          filename: record.filename,
          status: record.status,
          elapsedMs: record.elapsedMs,
          filePath: record.filePath
        });
      } catch {
        // Ignore malformed diagnostics.
      }
    }
    return summaries;
  }

  filePath(id: string) {
    if (!/^[\w.-]+$/.test(id)) throw new Error("诊断 ID 非法");
    return path.join(this.dir, `${id}.json`);
  }
}

function isDiagnosticRecord(value: Partial<DiagnosticRecord>): value is DiagnosticRecord {
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.platform === "string" &&
    typeof value.videoId === "string" &&
    typeof value.filename === "string" &&
    (value.status === "ok" || value.status === "partial" || value.status === "error") &&
    typeof value.elapsedMs === "number" &&
    typeof value.filePath === "string"
  );
}
