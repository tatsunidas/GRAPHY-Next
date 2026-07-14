import fs from "node:fs";
import path from "node:path";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import type { ItemResult, StepRecorder } from "../checklist/types.js";
import type { ChecklistItem } from "../checklist/types.js";
import type { Mode } from "../driver/types.js";

const CHECKLIST_ROOT = path.join(AUTOMATOR_ROOT, "checklist");

/** モード別チェックリストの格納ディレクトリ（checklist/<mode>/）。 */
export function checklistDir(mode: Mode): string {
  return path.join(CHECKLIST_ROOT, mode);
}

function statusLabel(result: ItemResult): string {
  if (result.status === "pass") return "自動PASS";
  if (result.status === "fail") return "FAIL";
  return "要人間確認";
}

/** id "03-db-admin.item-06" → 小項目番号 6（状態サマリ表の行特定に使う）。 */
function itemNumber(id: string): number | null {
  const m = id.match(/\.item-(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * checklist/<category>.md を更新する:
 *  1) 状態サマリ表の該当行（# 列が item 番号と一致）の「状態」「最終実行」列を書き換える。
 *  2) `<!-- AUTOMATOR:BEGIN id -->`〜`<!-- AUTOMATOR:END id -->` の区間を手順ログで置き換える。
 * それ以外の人間が書いた文章はそのまま保持する（対象外の行・マーカー外の記述には触れない）。
 */
export function recordResult(item: ChecklistItem, mode: Mode, runId: string, result: ItemResult, steps: StepRecorder["steps"]): void {
  const file = path.join(checklistDir(mode), `${item.category}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`checklist ファイルが見つかりません: ${file}\n（${mode} モードの ${item.category} 用チェックリストが未作成です）`);
  }
  let text = fs.readFileSync(file, "utf8");

  const n = itemNumber(item.id);
  if (n != null) {
    text = updateSummaryRow(text, n, statusLabel(result), todayStr());
  }

  const begin = `<!-- AUTOMATOR:BEGIN ${item.id} -->`;
  const end = `<!-- AUTOMATOR:END ${item.id} -->`;
  const blockRe = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`);
  const body = renderProcedureLog(item, runId, result, steps);
  const newBlock = `${begin}\n${body}\n${end}`;
  if (blockRe.test(text)) {
    text = text.replace(blockRe, newBlock);
  } else {
    text += `\n${newBlock}\n`;
  }

  fs.writeFileSync(file, text, "utf8");
}

function renderProcedureLog(item: ChecklistItem, runId: string, result: ItemResult, steps: StepRecorder["steps"]): string {
  const lines: string[] = [];
  lines.push(`#### ${todayStr()} (run ${runId})`);
  steps.forEach((s, i) => {
    const detail = s.detail ? ` \`${JSON.stringify(s.detail)}\`` : "";
    lines.push(`${i + 1}. ${s.description}${detail}`);
  });
  if (result.status === "pass") {
    lines.push(`Result: PASS${result.notes ? ` — ${result.notes}` : ""}`);
  } else if (result.status === "fail") {
    lines.push(`Result: FAIL — ${result.error}`);
    if (result.screenshotPath) lines.push(`Screenshot: ${result.screenshotPath}`);
  } else {
    lines.push(`Result: 要人間確認 — ${result.question}`);
    lines.push(`Screenshot: ${result.screenshotPath}`);
    lines.push(`確定するには: \`automator confirm ${item.id} --pass\` または \`--fail\``);
  }
  return lines.join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 状態サマリ表の該当行（先頭セル=n）の「状態」「最終実行」列を書き換える。正規表現の `$`/multiline
 * 一致に頼らず、行ごとに `|` 区切りでセルを直接置換する（表の書式を厳密に前提にしない、堅牢な実装）。
 */
function updateSummaryRow(text: string, n: number, status: string, date: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    // "| # | 小項目 | 状態 | 最終実行 |" → split("|") = ["", " # ", " 小項目 ", " 状態 ", " 最終実行 ", ""]
    if (cells.length < 6) continue;
    if (cells[1].trim() !== String(n)) continue;
    cells[3] = ` ${status} `;
    cells[4] = ` ${date} `;
    lines[i] = cells.join("|");
    break;
  }
  return lines.join("\n");
}
