/*
 * アルバム（スタディ一覧の複数選択・追加・表示・外す・管理）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19610 GRAPHY_AUTOMATOR_SCP_PORT=19611 GRAPHY_AUTOMATOR_VITE_PORT=19613 \
 *          npx tsx src/spike/albumCheck.ts
 *        （合成 CT の生成に pydicom・numpy のある python3 が要る。backend の jar が要る）
 *
 * 合成の 3 検査（retentionSynth.py）を取り込み、画面で:
 *   チェック（行クリックの単一選択とは独立）→ 新しいアルバムを作って 2 件追加 → アルバムを開くとその 2 件だけ
 *   → 1 件を外す（スタディ本体は API で 3 件とも残っている）→ 見つからない UID を足すと「見つかりません」＋他の表示は無傷
 *   → 掃除 → スタディ削除でアルバムの件数が減る → 名前変更・削除（スタディは残る）
 *   性能: 見つからない UID を含む 2000 件のアルバムを開くまでの時間とリクエスト数を測る（合否にはしない）
 * 画面はスクリーンショットを .results/album-check に残す（目視用）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "album-check");
const { check, summary } = createChecker();

interface Truth { studyUid: string; seriesUid: string; patientName: string; sops: string[] }
interface Album { id: number; name: string; count: number }

function synth(): { dir: string; truth: Truth[] } {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "retentionSynth.py"), dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return { dir, truth: JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth[] };
}

async function searchAll(page: Page): Promise<void> {
  await page.getByTestId("search-allperiod-chip").click();
  await page.getByTestId("search-submit-button").click();
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { dir, truth } = synth();
  const [s1, s2, s3] = truth;
  const driver = new DesktopDriver();
  const base = `http://127.0.0.1:${driver.ports.http}`;
  const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  const api = async <T>(p: string, init?: RequestInit): Promise<T> => {
    const r = await fetch(base + p, init);
    if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${p} → ${r.status}`);
    const t = await r.text();
    return (t ? JSON.parse(t) : undefined) as T;
  };
  const post = <T = void>(p: string, body: unknown) => api<T>(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const albums = () => api<Album[]>("/api/albums");
  const members = (id: number) => api<string[]>(`/api/albums/${id}/studies`);
  const studyUids = async () => (await api<{ studyInstanceUid: string }[]>("/api/studies")).map((s) => s.studyInstanceUid);

  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    for (const a of await albums()) await api(`/api/albums/${a.id}`, { method: "DELETE" }); // 前回の残りを消す
    for (const s of truth) {
      const imp = await importPaths(driver.ports.http, [path.join(dir, `s${truth.indexOf(s) + 1}`)]);
      check(imp.imported === 4, `合成 CT ${truth.indexOf(s) + 1} を 4 枚取り込めた`, imp);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await searchAll(page);
    const row = (s: Truth) => page.locator(`[data-testid="study-row-${s.studyUid}"]`);
    await row(s1).waitFor({ state: "visible", timeout: 20_000 });

    console.log("\n[0] 前提");
    check((await studyUids()).length === 3, "3 スタディが索引にある");
    check((await albums()).length === 0, "アルバムは最初は 0 件");
    check(await page.getByTestId("album-bar").isVisible(), "アルバムのバーが出ている");
    check(await page.getByTestId("album-checked").count() === 0, "選択が無いときは「アルバムに追加」は出ない（負例）");

    console.log("\n[1] チェックは行クリックの単一選択とは独立");
    await page.getByTestId(`study-check-${s1.studyUid}`).check();
    await page.getByTestId(`study-check-${s2.studyUid}`).check();
    check(/\b2\b/.test(await page.getByTestId("album-checked").innerText()), "選択件数 2 が出る", await page.getByTestId("album-checked").innerText());
    check(await page.locator(`[data-testid="series-row-${s1.seriesUid}"]`).count() === 0, "チェックしても、そのスタディのシリーズは開かない（単一選択は動かない）");
    await row(s3).click();
    await page.locator(`[data-testid="series-row-${s3.seriesUid}"]`).waitFor({ state: "visible", timeout: 15_000 });
    check(true, "行クリックは従来どおりシリーズを開く");
    check(/\b2\b/.test(await page.getByTestId("album-checked").innerText()), "行クリックしてもチェックは 2 件のまま");
    check(await page.getByTestId(`study-check-${s3.studyUid}`).isChecked() === false, "クリックした行はチェックされない");
    await shot(page, "01-checked");

    console.log("\n[2] 新しいアルバムを作って 2 件を追加");
    await page.getByTestId("album-add-select").selectOption("__new__");
    await page.getByTestId("album-new-name").fill("研究A");
    await page.getByTestId("album-new-create").click();
    await page.getByTestId("album-msg").waitFor({ state: "visible", timeout: 10_000 });
    const a1 = (await albums()).find((a) => a.name === "研究A");
    check(!!a1 && a1.count === 2, "アルバム「研究A」が 2 件で作られた（API）", await albums());
    check(a1 !== undefined && JSON.stringify((await members(a1.id)).sort()) === JSON.stringify([s1.studyUid, s2.studyUid].sort()), "メンバーは s1・s2 だけ（API）");
    check(await page.getByTestId("album-checked").count() === 0, "追加したあと、選択は空になる");

    console.log("\n[3] アルバムを開くと、その 2 件だけが出る");
    await page.getByTestId("album-select").selectOption({ label: "研究A (2)" });
    await page.getByTestId("album-view-banner").waitFor({ state: "visible", timeout: 10_000 });
    await row(s1).waitFor({ state: "visible", timeout: 15_000 });
    check(await row(s2).isVisible(), "s2 も出る");
    check(await row(s3).count() === 0, "アルバムに入っていない s3 は出ない（負例）");
    check((await page.getByTestId("album-view-banner").innerText()).includes("研究A"), "「アルバム『研究A』を表示中」と出る");
    await shot(page, "02-album-view");

    console.log("\n[4] アルバムから外しても、スタディ本体は消えない");
    await page.getByTestId(`study-check-${s1.studyUid}`).check();
    await page.getByTestId("album-remove-checked").click();
    await page.getByTestId("album-msg").waitFor({ state: "visible", timeout: 10_000 });
    check(JSON.stringify(await members(a1!.id)) === JSON.stringify([s2.studyUid]), "アルバムのメンバーは s2 だけになった（API）");
    check((await studyUids()).length === 3, "🔴 スタディは 3 件とも残っている（API）");
    await row(s2).waitFor({ state: "visible", timeout: 10_000 });
    check(await row(s1).count() === 0, "一覧から s1 が外れた");

    console.log("\n[5] スタディを削除すると、アルバムには「見つかりません」と出る。他の表示は妨げない");
    await post(`/api/albums/${a1!.id}/studies`, { studyUids: [s3.studyUid] });
    await api(`/api/studies/${s3.studyUid}`, { method: "DELETE" });
    check(!(await studyUids()).includes(s3.studyUid), "前提: s3 は削除された（API）");
    check((await members(a1!.id)).includes(s3.studyUid), "アルバムの行は残る（削除されたスタディの UID は宙に浮く。web でも同じ扱い）");
    await page.getByTestId("album-select").selectOption(""); // 一度閉じる
    await page.getByTestId("album-select").selectOption(String(a1!.id)); // 件数の表示は API 側の変更では更新されないので、id で選ぶ
    await page.getByTestId("album-missing").waitFor({ state: "visible", timeout: 15_000 });
    check(/\b1\b/.test(await page.getByTestId("album-missing").innerText()), "「1 件のスタディが見つかりません」（件数 1）と出る", await page.getByTestId("album-missing").innerText());
    check(await row(s2).isVisible(), "見つかる s2 は普通に出ている");
    await shot(page, "03-missing");
    await page.getByTestId("album-clean").click();
    await page.getByTestId("album-missing").waitFor({ state: "detached", timeout: 10_000 });
    check(JSON.stringify(await members(a1!.id)) === JSON.stringify([s2.studyUid]), "掃除で見つからない UID だけが外れた（s2 は残る）");

    console.log("\n[6] 空のアルバムを開くと、全件ではなく 0 件になる（負例）");
    const a2 = await post<Album>("/api/albums", { name: "削除確認" });
    await page.getByTestId("album-select").selectOption(""); // 閉じる
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.getByTestId("album-select").selectOption(String(a2.id));
    await page.getByTestId("album-view-banner").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(1_500);
    check(await page.locator('[data-testid^="study-row-"]').count() === 0, "空のアルバムでは、スタディが 1 件も出ない（全件が出てしまわない）", await page.locator('[data-testid^="study-row-"]').count());
    await shot(page, "03b-empty-album");

    await page.getByTestId("album-select").selectOption(String(a1!.id)); // 表示中のアルバムを管理で名前変更する
    await page.getByTestId("album-view-banner").waitFor({ state: "visible", timeout: 10_000 });
    console.log("\n[7] 管理: 名前変更・削除（スタディは残る）");
    await page.getByTestId("album-manage").click();
    await page.getByTestId("album-manage-dialog").waitFor({ state: "visible", timeout: 5_000 });
    const rowA = page.getByTestId("album-manage-row").filter({ hasText: "研究A" });
    await rowA.getByTestId("album-rename").click();
    await page.getByTestId("album-rename-input").fill("研究B");
    await page.getByTestId("album-rename-save").click();
    await page.getByTestId("album-manage-row").filter({ hasText: "研究B" }).waitFor({ state: "visible", timeout: 10_000 });
    check((await albums()).some((a) => a.name === "研究B") && !(await albums()).some((a) => a.name === "研究A"), "名前が「研究B」に変わった（API）");
    check((await page.getByTestId("album-view-banner").innerText()).includes("研究B"), "表示中のアルバムのバナーも「研究B」に変わった");
    // 負例: 同じ名前は作れない
    await page.getByTestId("album-manage-row").filter({ hasText: "削除確認" }).getByTestId("album-rename").click();
    await page.getByTestId("album-rename-input").fill("研究B");
    await page.getByTestId("album-rename-save").click();
    await page.getByTestId("album-manage-error").waitFor({ state: "visible", timeout: 10_000 });
    check(true, "負例: 既にある名前への変更は理由つきで断られる: " + (await page.getByTestId("album-manage-error").innerText()));
    await shot(page, "04-manage");
    await page.getByRole("button", { name: /Cancel|キャンセル/ }).first().click();
    await page.getByTestId("album-manage-row").filter({ hasText: "削除確認" }).getByTestId("album-delete").click();
    await shot(page, "05-delete-confirm");
    await page.getByTestId("album-delete-confirm").click();
    await page.getByTestId("album-manage-row").filter({ hasText: "削除確認" }).waitFor({ state: "detached", timeout: 10_000 });
    check(!(await albums()).some((a) => a.name === "削除確認"), "アルバム「削除確認」が消えた（API）");
    check((await studyUids()).length === 2, "🔴 スタディ（s1・s2）は残っている", await studyUids());
    await page.getByTestId("album-manage-dialog").getByRole("button", { name: /Close|閉じる/ }).click();

    console.log("\n[8] 性能: 見つからない UID を含む 2000 件のアルバム（合否にしない。計測）");
    const big = await post<Album>("/api/albums", { name: "大" });
    const fakes = Array.from({ length: 1997 }, (_, i) => `1.2.826.0.1.3680043.10.1338.${String(100000 + i)}`);
    await post(`/api/albums/${big.id}/studies`, { studyUids: fakes.slice(0, 1000) });
    await post(`/api/albums/${big.id}/studies`, { studyUids: fakes.slice(1000) });
    await post(`/api/albums/${big.id}/studies`, { studyUids: [s1.studyUid, s2.studyUid] });
    check((await members(big.id)).length === 1999, "2000 件弱のアルバムを作れた（API）", (await members(big.id)).length);
    await page.getByTestId("album-select").selectOption(""); // 閉じる
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.getByTestId("album-select").locator("option", { hasText: "大 (1999)" }).waitFor({ state: "attached", timeout: 15_000 });
    let requests = 0;
    page.on("request", (r) => { if (r.url().includes("/api/studies?studyInstanceUid=")) requests++; });
    const statuses: Record<string, number> = {};
    page.on("response", (r) => { if (r.url().includes("/api/studies?studyInstanceUid=")) statuses[r.status()] = (statuses[r.status()] ?? 0) + 1; });
    const t0 = Date.now();
    await page.getByTestId("album-select").selectOption({ label: "大 (1999)" });
    await page.getByTestId("album-missing").waitFor({ state: "visible", timeout: 120_000 }).catch(async (e) => {
      console.log("  [計測] 失敗時: リクエスト", requests, "回、応答", JSON.stringify(statuses), `${Date.now() - t0} ms`);
      console.log("  [画面]", (await page.locator("section").first().innerText().catch(() => "")).slice(0, 300));
      await shot(page, "99-big-failed");
      throw e;
    });
    const ms = Date.now() - t0;
    console.log(`  [計測] 1999 件のアルバムを開くまで ${ms} ms、/api/studies の取得 ${requests} 回`);
    check((await page.getByTestId("album-missing").innerText()).includes("1997"), "見つからないのは 1997 件", await page.getByTestId("album-missing").innerText());
    check(await row(s1).isVisible() && await row(s2).isVisible(), "実在する 2 件は出ている");
    await shot(page, "06-big");
  } finally {
    await driver.stop();
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
