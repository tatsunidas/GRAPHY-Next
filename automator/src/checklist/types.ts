import type { Page } from "@playwright/test";
import type { Driver } from "../driver/types.js";

export type ItemResult =
  | { status: "pass"; notes?: string }
  | { status: "fail"; error: string; screenshotPath?: string }
  | { status: "needs-human"; screenshotPath: string; question: string };

export interface StepRecorder {
  /** 1手順を記録する（成功後にMarkdownへ書き戻される）。selector/assertion等は detail に。 */
  step(description: string, detail?: Record<string, unknown>): void;
  readonly steps: { description: string; detail?: Record<string, unknown> }[];
}

export interface RunContext {
  driver: Driver;
  recorder: StepRecorder;
  /** driver.page のスクリーンショットを .results/<runId>/<item-id>/ に保存し、パスを返す。 */
  screenshot(page: Page, label: string): Promise<string>;
}

export interface ChecklistItem {
  /** "03-db-admin.item-06" 形式。前半は checklist/<id>.md のファイル名(拡張子無し)と一致させる。 */
  id: string;
  title: string;
  /** checklist/<category>.md のファイル名(拡張子無し)。例: "03-db-admin"。 */
  category: string;
  /** true の項目は自動PASSにせず、証跡スクリーンショット付きで人間確認待ちにする。 */
  requiresHuman: boolean;
  /** 実行前に automator/fixtures/<id>/ の存在を要求する fixture カテゴリID一覧。 */
  dependsOnFixtures?: string[];
  run(ctx: RunContext): Promise<ItemResult>;
}

export function createStepRecorder(): StepRecorder {
  const steps: { description: string; detail?: Record<string, unknown> }[] = [];
  return {
    steps,
    step(description, detail) {
      steps.push({ description, detail });
    },
  };
}
