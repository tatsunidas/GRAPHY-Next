import fs from "node:fs";
import path from "node:path";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import type { Mode } from "../driver/types.js";

const CHECKLIST_ROOT = path.join(AUTOMATOR_ROOT, "checklist");

export type SubStatus = "未着手" | "自動PASS" | "要人間確認" | "FAIL";
const KNOWN_STATUSES: SubStatus[] = ["未着手", "自動PASS", "要人間確認", "FAIL"];

export interface SubItem {
  n: number;
  title: string;
  status: SubStatus;
  lastRun: string;
}

export interface FeatureReport {
  /** ファイル名(拡張子無し)。例 "10-viewer2d-core"。 */
  category: string;
  /** md 見出し。例 "10. 2D Viewer コア表示"。 */
  title: string;
  /** 由来 fw ドキュメント（**ソース**: 行）。 */
  source: string | null;
  items: SubItem[];
}

export interface ModeReport {
  mode: Mode;
  features: FeatureReport[];
}

function normalizeStatus(raw: string): SubStatus {
  const s = raw.trim();
  return (KNOWN_STATUSES as string[]).includes(s) ? (s as SubStatus) : "未着手";
}

/** checklist の 1 ファイルを解析して機能レポートにする。状態サマリ表が無ければ null。 */
export function parseChecklistFile(file: string): FeatureReport | null {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");

  let title = path.basename(file, ".md");
  let source: string | null = null;
  const items: SubItem[] = [];
  let inSummary = false;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1 && title === path.basename(file, ".md")) title = h1[1];

    const src = line.match(/\*\*ソース\*\*[:：]\s*(.+?)\s*$/);
    if (src) source = src[1];

    if (line.startsWith("## ")) inSummary = line.includes("状態サマリ");
    if (!inSummary || !line.startsWith("|")) continue;

    // "| 1 | 小項目 | 状態 | 最終実行 |" → ["", " 1 ", " 小項目 ", " 状態 ", " 最終実行 ", ""]
    const cells = line.split("|");
    if (cells.length < 6) continue;
    const n = parseInt(cells[1].trim(), 10);
    if (!Number.isInteger(n)) continue; // ヘッダ行/区切り行はスキップ
    items.push({
      n,
      title: cells[2].trim(),
      status: normalizeStatus(cells[3]),
      lastRun: cells[4].trim(),
    });
  }

  if (items.length === 0) return null;
  return { category: path.basename(file, ".md"), title, source, items };
}

/** 指定モードの checklist/<mode>/ 配下を全解析。00-overview 等の索引ファイル(状態サマリ無し)は自動除外。 */
export function collectMode(mode: Mode): ModeReport {
  const dir = path.join(CHECKLIST_ROOT, mode);
  if (!fs.existsSync(dir)) return { mode, features: [] };
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d\d-.*\.md$/.test(f))
    .sort();
  const features: FeatureReport[] = [];
  for (const f of files) {
    const fr = parseChecklistFile(path.join(dir, f));
    if (fr) features.push(fr);
  }
  return { mode, features };
}

export interface StatusCounts {
  total: number;
  自動PASS: number;
  要人間確認: number;
  FAIL: number;
  未着手: number;
}

export function countStatuses(features: FeatureReport[]): StatusCounts {
  const c: StatusCounts = { total: 0, 自動PASS: 0, 要人間確認: 0, FAIL: 0, 未着手: 0 };
  for (const f of features) {
    for (const it of f.items) {
      c.total++;
      c[it.status]++;
    }
  }
  return c;
}
