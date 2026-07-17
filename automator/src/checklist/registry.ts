import type { ChecklistItem } from "./types.js";
import type { Mode } from "../driver/types.js";
import { dbAdminItems } from "./items/shared/dbAdmin.js";
import { mainscreenItems } from "./items/shared/mainscreen.js";
import { viewer2dCoreItems } from "./items/shared/viewer2dCore.js";
import { lutItems } from "./items/shared/lut.js";
import { tagToolsItems } from "./items/shared/tagTools.js";
import { importExportItems } from "./items/desktop/importExport.js";
import { viewer2dMenuToolbarItems } from "./items/desktop/viewer2dMenuToolbar.js";
import { dbAdminNotifyItems } from "./items/desktop/dbAdminNotify.js";
import { seriesExtractorItems } from "./items/desktop/seriesExtractor.js";

/**
 * 実装済みの checklist item 一覧（他大項目は automator/checklist/<mode>/*.md のスケルトンのみで未実装）。
 * items/shared は desktop/web 両対応、items/desktop / items/web は各モード専用。
 */
export const ALL_ITEMS: ChecklistItem[] = [
  // shared（両モード対応）
  ...dbAdminItems,
  ...mainscreenItems,
  ...viewer2dCoreItems,
  ...lutItems,
  ...tagToolsItems,
  // desktop 専用
  ...importExportItems,
  ...viewer2dMenuToolbarItems,
  ...dbAdminNotifyItems,
  ...seriesExtractorItems,
  // web 専用（未実装）
];

export function getItem(id: string): ChecklistItem {
  const item = ALL_ITEMS.find((i) => i.id === id);
  if (!item) {
    const known = ALL_ITEMS.map((i) => i.id).join(", ") || "(なし)";
    throw new Error(`未知の checklist item id: "${id}"。実装済み: ${known}`);
  }
  return item;
}

/** 指定モードで実行可能な item のみ（modes に mode を含むもの）。 */
export function getItemsForMode(mode: Mode): ChecklistItem[] {
  return ALL_ITEMS.filter((i) => i.modes.includes(mode));
}

/** カテゴリで絞り込む。mode を渡すとさらにモードで絞る。 */
export function getItemsByCategory(category: string, mode?: Mode): ChecklistItem[] {
  return ALL_ITEMS.filter((i) => i.category === category && (mode == null || i.modes.includes(mode)));
}
