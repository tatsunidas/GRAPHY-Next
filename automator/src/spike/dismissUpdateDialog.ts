import type { Page } from "playwright";

/**
 * 「新しい版があります」の窓（起動後しばらくして出る。GitHub の最新リリースを見て出すので、リリースが出た日から検査が
 * 「<div> intercepts pointer events」で止まる）を［あとで］で閉じる。何も保存しない（この版を飛ばす設定は押さない）。
 * 出ていなければ何もしない。出る時機が一定でないので、メイン窓のボタンを押す直前ごとに呼ぶ。
 */
export async function dismissUpdateDialog(page: Page, waitMs = 1500): Promise<boolean> {
  const later = page.getByRole("button", { name: /^(Later|あとで)$/ });
  try {
    await later.waitFor({ state: "visible", timeout: waitMs });
  } catch {
    return false;
  }
  await later.click();
  await later.waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);
  return true;
}
