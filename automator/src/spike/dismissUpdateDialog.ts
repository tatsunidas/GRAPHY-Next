import type { Page } from "playwright";

/**
 * 「新しい版があります」の窓（起動後しばらくして出る。GitHub の最新リリースを見て出すので、リリースが出た日から検査が
 * 「<div> intercepts pointer events」で止まる）を［後で］（en は Later）で閉じる。何も保存しない（この版を飛ばす設定は押さない）。
 * 出ていなければ何もしない。出る時機が一定でないので、メイン窓のボタンを押す直前ごとに呼ぶ。
 */
export async function dismissUpdateDialog(page: Page, waitMs = 1500): Promise<boolean> {
  const later = page.getByRole("button", { name: /^(Later|後で|あとで)$/ });
  try {
    await later.waitFor({ state: "visible", timeout: waitMs });
  } catch {
    return false;
  }
  await later.click();
  await later.waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);
  return true;
}

/**
 * クリックを、新版の窓に遮られても通す。窓はクリックの途中で出ることもある（直前に閉じても間に合わない）ので、
 * 短い待ちで試し、失敗したら窓を閉じてやり直す。
 */
export async function clickDismissing(page: Page, locator: import("playwright").Locator, attempts = 4): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await locator.click({ timeout: 15_000 });
      return;
    } catch (e) {
      if (i >= attempts) throw e;
      await dismissUpdateDialog(page, 2000);
    }
  }
}
