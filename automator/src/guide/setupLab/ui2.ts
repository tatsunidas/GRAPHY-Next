// dcm4chee-arc の管理 UI（UI2）の操作。メニュー: 左上の ≡ ▸ Configuration ▸ 上のタブ「AE list」▸ New AET。
import type { Page } from "@playwright/test";

const SHOTS = process.env.HOME + "/graphy-guide-lab/probe-shots/";

async function fillAfter(page: Page, label: string, value: string): Promise<void> {
  // 背後の一覧の見出し（同名の「AE Title」など）と混ざらないよう、DOM で最後（＝ダイアログ内）の一致を使う
  const el = page.getByText(label, { exact: true }).last().locator("xpath=following::input[1]");
  await el.fill(value);
}

/** 「AE list ▸ New AET ▸ Create new device」で、相手（GRAPHY-Next など）を AE として登録する。 */
export async function registerAe(page: Page, base: string, o: { device: string; ae: string; host: string; port: number; shot?: string }): Promise<void> {
  await page.goto(`${base}/dcm4chee-arc/ui2/en/device/aelist`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.getByText("New AET", { exact: true }).first().click();
  await page.waitForTimeout(1200);
  // 開いた直後は「New Network Connection」と「Network AE」が開いていて、入力欄は
  // [0]=Search device（既存デバイス検索）[1]=NC の Name [2]=Hostname [3]=Port [4]=AE Title。見出しを押すと開閉が切り替わる。
  const ins = page.locator("input:visible");
  await ins.nth(1).fill(o.device);
  await ins.nth(2).fill(o.host);
  await ins.nth(3).fill(String(o.port));
  await ins.nth(4).fill(o.ae);
  // 最後に「New Device」を開き、Device name と Installed（True）を入れる（必須）
  await page.getByText("New Device", { exact: true }).last().click();
  await page.waitForTimeout(600);
  await fillAfter(page, "Device name", o.device);
  await page.getByText("True", { exact: true }).last().click();
  if (o.shot) await page.screenshot({ path: SHOTS + o.shot + ".png" });
  await page.getByRole("button", { name: /apply/i }).click();
  await page.waitForTimeout(3000);
}
