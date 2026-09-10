/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 直近に触られたタイル（`commandKey` = tileId）。
 *
 * <p>「ROI をここへ貼れ」のように**宛先が 1 つに定まらないと困る操作**のためのもの。
 * 既定のコマンド送出は「選択タイル → 無ければ全タイル」だが、貼り付けをその規則で流すと
 * **開いている全タイルに複製が生える**。かといって毎回タイルを選ばせるのは煩わしいので、
 * 「最後に触ったタイル」を宛先にする。
 *
 * <p>記録の契機は base ビューポートの `pointerdown`（`segmentation.noteSegViewport` と同じ場所）。
 * ROI をコピーするには、その ROI をクリックして選ぶ＝そのタイルに触る必要があるので、
 * 通常の操作の流れで必ず記録される。
 */
let focused: string | null = null;

export function noteFocusedTile(tileId: string | undefined): void {
  if (tileId) focused = tileId;
}

export function getFocusedTile(): string | null {
  return focused;
}
