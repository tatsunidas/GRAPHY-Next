import type { Page } from "@playwright/test";

/**
 * 起動直後に出るモーダルを閉じる。
 *
 * <p>🚨 これが効かないと、以降のクリックが**別の要素に吸われて 30 秒タイムアウトする**。
 * 原因のダイアログは画面外ではなく前面のオーバレイなので、
 * 「ボタンは見えているのに押せない」という分かりにくい形で出る。
 *
 * <p>閉じるボタンの文言は 1 つではない:
 * - 起動時の各種お知らせ … 「閉じる」/「Close」
 * - **アプリ内更新通知** … 「**✕**」「このバージョンをスキップ」「後で」
 *
 * 「閉じる」だけを探していたために更新通知を閉じられず、`search-submit-button` の
 * クリックが `<div> intercepts pointer events` で失敗した（2026-08-15、実際に踏んだ）。
 * この環境の公開デモ機は版が古いままなので、更新通知は**毎回出る**前提で書くこと。
 */
export async function dismissStartupDialogs(page: Page, attempts = 6): Promise<void> {
  const CLOSE_LABEL = /^(閉じる|Close|✕|×|✖|OK|後で|Later|このバージョンをスキップ|Skip this version)$/;
  for (let i = 0; i < attempts; i++) {
    const dialog = page.locator('[role="dialog"]');
    const inDialog = dialog.first().getByRole("button", { name: CLOSE_LABEL });
    if ((await dialog.count()) > 0 && (await inDialog.count()) > 0) {
      await inDialog.first().click().catch(() => {});
      await page.waitForTimeout(400);
      continue;
    }
    // ⚠️ `role="dialog"` を持たないオーバレイもある（**アプリ内更新通知がまさにそれ**）。
    //    role の有無で探すのをやめ、文言でページ全体から探す。
    const anywhere = page.getByRole("button", { name: CLOSE_LABEL });
    const n = await anywhere.count();
    for (let k = 0; k < n; k++) {
      const b = anywhere.nth(k);
      if (await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(300);
        break;
      }
    }
    if (n === 0) {
      if ((await dialog.count()) === 0) return;
      // 文言が想定外でも Escape なら閉じる実装が多い。
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page.waitForTimeout(300);
  }
}

/**
 * 何かがクリックを吸っていないかを確かめる。
 *
 * <p>「閉じたつもり」で先へ進むと 30 秒待たされたうえで別の場所が落ちるので、
 * **先に**塞がれていないことを確認して、塞いでいる要素の正体を出す。
 *
 * @returns 塞いでいる要素の説明。塞がれていなければ null
 */
export async function findBlockingOverlay(page: Page, testId: string): Promise<string | null> {
  const result = (await page.evaluate(`(() => {
    const target = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
    if (!target) return "target-missing";
    const r = target.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || hit === target || target.contains(hit)) return null;
    return hit.tagName + "." + hit.className + " txt=" + (hit.textContent || "").slice(0, 120);
  })()`)) as string | null;
  return result;
}
