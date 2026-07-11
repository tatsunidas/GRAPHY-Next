import type { ChecklistItem } from "./types.js";
import { dbAdminItems } from "./items/dbAdmin.js";
import { importExportItems } from "./items/importExport.js";
import { mainscreenItems } from "./items/mainscreen.js";
import { viewer2dCoreItems } from "./items/viewer2dCore.js";

/** 実装済みの checklist item 一覧（他27大項目は automator/checklist/*.md のスケルトンのみで未実装）。 */
export const ALL_ITEMS: ChecklistItem[] = [
  ...dbAdminItems,
  ...importExportItems,
  ...mainscreenItems,
  ...viewer2dCoreItems,
];

export function getItem(id: string): ChecklistItem {
  const item = ALL_ITEMS.find((i) => i.id === id);
  if (!item) {
    const known = ALL_ITEMS.map((i) => i.id).join(", ") || "(なし)";
    throw new Error(`未知の checklist item id: "${id}"。実装済み: ${known}`);
  }
  return item;
}

export function getItemsByCategory(category: string): ChecklistItem[] {
  return ALL_ITEMS.filter((i) => i.category === category);
}
