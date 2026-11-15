// 起動済みのデスクトップ版（--remote-debugging-port=9233）へ CDP でつなぎ、メイン画面を返す。
import { chromium, type Browser, type Page } from "@playwright/test";

export async function connect(port = 9233): Promise<{ browser: Browser; pages: () => Page[] }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return { browser, pages: () => browser.contexts().flatMap((c) => c.pages()) };
}

export async function mainPage(port = 9233): Promise<{ browser: Browser; page: Page }> {
  const { browser, pages } = await connect(port);
  const page = pages().find((p) => /index\.html$/.test(p.url()));
  if (!page) throw new Error("メイン画面が見つからない: " + pages().map((p) => p.url()).join(", "));
  return { browser, page };
}

/** 環境設定を開く（開いていれば何もしない）。 */
export async function openSettings(page: Page): Promise<void> {
  if (await page.getByText("画像オーバーレイ").count()) return;
  await page.getByRole("button", { name: /設定/ }).first().click();
  await page.getByText("画像オーバーレイ").first().waitFor();
}

export const SHOTS = process.env.HOME + "/graphy-guide-lab/probe-shots/";

/** 環境設定のタブ（左の一覧）を開く。ツールバーの同名ボタン（Query/Retrieve）と混ざらないよう、最後に一致した要素を押す。 */
export async function settingsTab(page: Page, name: string): Promise<void> {
  await openSettings(page);
  await page.getByText(name).last().click();
  await page.waitForTimeout(700);
}

/** 「DICOM 通信先」タブで行を追加する。 */
export async function addRemoteAe(page: Page, ae: string, host: string, port: number | string): Promise<number> {
  await settingsTab(page, "DICOM 通信先");
  await page.getByRole("button", { name: /追加$/ }).first().click();
  const n = await page.getByPlaceholder("AET").count();
  await page.getByPlaceholder("AET").nth(n - 1).fill(ae);
  await page.getByPlaceholder("host / IP").nth(n - 1).fill(host);
  await page.getByPlaceholder("104").nth(n - 1).fill(String(port));
  return n - 1;
}

/** 行の［疎通確認］を押し、結果（✓ / ✕）を返す。 */
export async function echoRow(page: Page, row: number): Promise<string> {
  const btn = page.locator('button[title="疎通確認"]').nth(row);
  await btn.click();
  await page.waitForFunction(
    ([i]) => {
      const b = document.querySelectorAll('button[title="疎通確認"]')[i as number];
      return !!b && /[✓✕]/.test(b.textContent ?? "");
    },
    [row],
    { timeout: 40000 },
  );
  return ((await btn.innerText()) ?? "").trim();
}

/** Query/Retrieve の窓（index.html#qr）。 */
export async function qrPage(port = 9233): Promise<{ browser: Browser; page: Page }> {
  const { browser, pages } = await connect(port);
  const page = pages().find((p) => /index\.html#qr/.test(p.url()));
  if (!page) throw new Error("Q/R の窓が開いていない");
  return { browser, page };
}

/** 開いている送信ダイアログなどを閉じる。 */
export async function closeDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const b = page.getByRole("button", { name: "閉じる" });
    if (!(await b.count())) break;
    await b.last().click().catch(() => {});
    await page.waitForTimeout(400);
  }
}
