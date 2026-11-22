import type { Page } from "playwright";

/**
 * 設定欄の群（折りたたみ。data-testid が `…-group-…` の details）を、閉じているものだけ開く。③ 値の扱い・④ QC と絞り込みは既定で
 * 閉じていて、中の入力（校正・値の種類・QC・セグメント名の絞り込み）は閉じている間は見えない（DOM には残る）ので、触る前に呼ぶ。
 * Playwright の待機は描画フレームに頼るので、DOM へ直接クリックを送る（要素の可視の待ちを使わない）。
 */
export async function openAllGroups(page: Page): Promise<number> {
  const n = (await page.evaluate(`(function () {
    var opened = 0;
    document.querySelectorAll('details[data-testid*="-group-"]').forEach(function (d) {
      if (!d.open) { d.querySelector('summary').click(); opened++; }
    });
    return opened;
  })()`)) as number;
  await page.waitForTimeout(300);
  return n;
}
