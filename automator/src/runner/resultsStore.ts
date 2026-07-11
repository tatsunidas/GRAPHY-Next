import fs from "node:fs";
import path from "node:path";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import type { ItemResult, StepRecorder } from "../checklist/types.js";

export const RESULTS_ROOT = path.join(AUTOMATOR_ROOT, ".results");

export interface StoredRun {
  runId: string;
  itemId: string;
  timestamp: string;
  result: ItemResult;
  steps: StepRecorder["steps"];
}

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
    Math.random().toString(36).slice(2, 8)
  );
}

export function runDir(runId: string, itemId: string): string {
  return path.join(RESULTS_ROOT, runId, itemId.replace(/[/\\]/g, "_"));
}

export function saveRunResult(store: StoredRun): string {
  const dir = runDir(store.runId, store.itemId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
  return file;
}
