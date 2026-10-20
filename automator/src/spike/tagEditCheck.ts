/*
 * タグビューアから DICOM タグを編集する（fw/db-admin.md §8）: 実アプリで、編集 → 確認 → 保存 → 一覧・ダンプ・ファイルが新しい値。
 * 鍵の付く行（UID・患者タグ）に入力欄が無いこと、確認で戻ると何も変わらないこと、形の違う値で保存できないことも見る。
 *
 * 実行:  cd automator && npx tsx src/spike/tagEditCheck.ts   （pydicom のある python3 が要る。GRAPHY_TEST_PYTHON で差し替え可）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "tag-edit-check");
const DATA_DIR = path.join(OUT_DIR, "data");
const STUDY = "1.2.826.0.1.3680043.10.999.1";
const SERIES = "1.2.826.0.1.3680043.10.999.1.1";
const { check, summary } = createChecker();

// 合成のシリーズ（3 枚、画素はそれぞれ違う）を書き、あとでファイルを読み直す
const PY_WRITE = `
import sys, numpy as np, pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage
out, study, series = sys.argv[1], sys.argv[2], sys.argv[3]
for i in range(1, 4):
    fm = FileMetaDataset(); fm.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    fm.MediaStorageSOPInstanceUID = f"{series}.{i}"; fm.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset(); ds.file_meta = fm
    ds.SOPClassUID = SecondaryCaptureImageStorage; ds.SOPInstanceUID = f"{series}.{i}"
    ds.StudyInstanceUID = study; ds.SeriesInstanceUID = series
    ds.PatientID = "TAGEDIT-SPIKE"; ds.PatientName = "Spike^Tag"; ds.StudyDate = "20260101"
    ds.Modality = "OT"; ds.SeriesNumber = 1; ds.InstanceNumber = i; ds.SeriesDescription = "Chest"
    ds.StudyDescription = "Spike"; ds.ProtocolName = "Routine"
    ds.Rows = ds.Columns = 8; ds.BitsAllocated = ds.BitsStored = 8; ds.HighBit = 7; ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"; ds.PixelRepresentation = 0
    ds.PixelData = (np.arange(64, dtype=np.uint8) * i).tobytes()
    ds.save_as(f"{out}/img{i}.dcm", enforce_file_format=True)
`;

const PY_READ = `
import sys, json, hashlib, pydicom
out = []
for p in sys.argv[1:]:
    ds = pydicom.dcmread(p)
    oas = ds.get("OriginalAttributesSequence")
    mod = None
    if oas:
        m = oas[-1].ModifiedAttributesSequence[0]
        mod = {"SeriesDescription": str(m.get("SeriesDescription", "")), "system": str(oas[-1].ModifyingSystem)}
    out.append({"sop": str(ds.SOPInstanceUID), "desc": str(ds.get("SeriesDescription", "")),
                "pixel": hashlib.sha256(ds.PixelData).hexdigest(), "mod": mod})
print(json.dumps(out))
`;

function py(code: string, args: string[]): string {
  const r = spawnSync(process.env.GRAPHY_TEST_PYTHON ?? "python3", ["-c", code, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  py(PY_WRITE, [DATA_DIR, STUDY, SERIES]);

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    const http = driver.ports.http;
    const base = `http://127.0.0.1:${http}`;
    await resetDb(http);
    const imp = (await (await fetch(`${base}/api/import/paths`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [DATA_DIR] }),
    })).json()) as { imported: number };
    check(imp.imported === 3, `合成シリーズを取り込む（${imp.imported} 枚）`);
    const insts = (await (await fetch(`${base}/api/studies/${STUDY}/series/${SERIES}/instances`)).json()) as unknown[];
    check(insts.length === 3, "インスタンスの一覧が 3 枚");
    // 保管庫は backend の作業フォルダ（DESKTOP_RUN_DATA_DIR）の下。取り込みでコピーされた実ファイルを読む
    const storeDir = DESKTOP_RUN_DATA_DIR;
    const findStored = (): string[] => {
      const out: string[] = [];
      const walk = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".dcm") && p.includes(SERIES) && !e.name.startsWith(".")) out.push(p);
        }
      };
      walk(storeDir);
      return out.sort();
    };
    const before = JSON.parse(py(PY_READ, findStored())) as { sop: string; desc: string; pixel: string; mod: unknown }[];
    check(before.length === 3 && before.every((b) => b.desc === "Chest" && b.mod === null), "保管庫のファイル 3 つを読める（編集前）", { storeDir, n: before.length });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-patientid-input").fill("TAGEDIT-SPIKE");
    await page.getByTestId("search-submit-button").click();
    await page.screenshot({ path: path.join(OUT_DIR, "0-list.png") });
    await page.locator(`[data-testid="study-row-${STUDY}"]`).click();
    await page.locator(`[data-testid="series-row-${SERIES}"]`).click();
    await page.getByTestId("toolbar-tag-viewer-btn").click();
    const dlg = page.getByTestId("tag-viewer-dialog");
    await dlg.getByTestId("tag-viewer-table").waitFor({ state: "visible", timeout: 30_000 });
    // 編集の前にバックアップを促す確認が出る。「やめる」では編集に入らず、「バックアップ済み」で入る
    await dlg.getByTestId("tag-edit-start").click();
    await dlg.getByTestId("tag-edit-warn").waitFor({ state: "visible", timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT_DIR, "0-warn.png") });
    await dlg.getByTestId("tag-edit-warn-cancel").click();
    check((await dlg.getByTestId("tag-edit-warn").count()) === 0, "やめる: 確認が閉じる");
    check((await dlg.getByTestId("tag-edit-input").count()) === 0, "やめる: 編集に入らず入力欄が無い");
    check((await dlg.getByTestId("tag-edit-start").count()) === 1, "やめる: 「編集」ボタンが残る");
    await dlg.getByTestId("tag-edit-start").click();
    await dlg.getByTestId("tag-edit-warn-ok").click();
    check((await dlg.getByTestId("tag-edit-warn").count()) === 0, "バックアップ済み: 確認が閉じる");
    check((await dlg.getByTestId("tag-edit-input").count()) > 0, "バックアップ済み: 編集に入り入力欄が出る");

    const row =(tag: string) => dlg.locator(`[data-testid="tag-row-${tag}"]`).first(); // 同じタグが変更の記録（SQ）の中にも出る
    check((await row("(0020,000E)").getByTestId("tag-edit-input").count()) === 0, "SeriesInstanceUID の行に入力欄が無い");
    check((await row("(0020,000E)").getByTestId("tag-lock").count()) === 1, "SeriesInstanceUID の行に鍵の印");
    check((await row("(0010,0010)").getByTestId("tag-edit-input").count()) === 0, "PatientName の行に入力欄が無い（患者情報の編集へ）");
    check((await row("(0028,0010)").getByTestId("tag-edit-input").count()) === 0, "Rows の行に入力欄が無い");

    // 形の違う値では保存できない
    await row("(0008,0060)").getByTestId("tag-edit-input").fill("ot");
    check(await dlg.getByTestId("tag-edit-save").isDisabled(), "Modality に小文字を入れると保存できない");
    await row("(0008,0060)").getByTestId("tag-edit-input").fill("OT");

    await row("(0008,103E)").getByTestId("tag-edit-input").fill("Chest 1.0");
    check(await dlg.getByTestId("tag-edit-save").isEnabled(), "SeriesDescription を変えると保存できる");
    await page.screenshot({ path: path.join(OUT_DIR, "1-editing.png") });

    // 確認 → 戻る: 何も変わらない
    await dlg.getByTestId("tag-edit-save").click();
    const confirm = dlg.getByTestId("tag-edit-confirm");
    await confirm.waitFor({ state: "visible", timeout: 30_000 });
    const confirmText = await confirm.innerText();
    check(/3/.test(confirmText) && /Chest 1\.0/.test(confirmText), "確認に対象 3 枚と新しい値が出る", confirmText);
    await page.screenshot({ path: path.join(OUT_DIR, "2-confirm.png") });
    await dlg.getByTestId("tag-edit-confirm-cancel").click();
    const afterCancel = JSON.parse(py(PY_READ, findStored())) as { desc: string }[];
    check(afterCancel.every((b) => b.desc === "Chest"), "確認で戻ると、ファイルは変わらない");

    // 保存
    await dlg.getByTestId("tag-edit-save").click();
    await confirm.waitFor({ state: "visible", timeout: 30_000 });
    await dlg.getByTestId("tag-edit-confirm-ok").click();
    await dlg.getByTestId("tag-edit-notice").filter({ hasText: /3/ }).waitFor({ timeout: 30_000 });
    await dlg.getByTestId("tag-viewer-table").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(800);
    const dumpValue = await row("(0008,103E)").innerText();
    check(/Chest 1\.0/.test(dumpValue), "ダンプを読み直すと新しい値", dumpValue);
    check((await row("(0400,0561)").count()) === 1, "ダンプに Original Attributes Sequence が出る");
    await page.screenshot({ path: path.join(OUT_DIR, "3-saved.png") });

    const after = JSON.parse(py(PY_READ, findStored())) as { sop: string; desc: string; pixel: string; mod: { SeriesDescription: string; system: string } | null }[];
    after.forEach((a, i) => {
      check(a.desc === "Chest 1.0", `ファイル ${i + 1}: SeriesDescription が新しい値`, a.desc);
      check(a.sop === before[i].sop && a.pixel === before[i].pixel, `ファイル ${i + 1}: SOPInstanceUID と画素は同じ`);
      check(a.mod?.SeriesDescription === "Chest" && a.mod?.system === "GRAPHY-Next", `ファイル ${i + 1}: 前の値 Chest が記録に残る`, a.mod);
    });

    // 一覧（同じウィンドウ）も読み直される（選択は外れるので、検査を選び直してシリーズの説明を見る）
    await dlg.getByLabel(/^(閉じる|Close)$/).first().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT_DIR, "4-list-after-save.png") });
    await page.locator(`[data-testid="study-row-${STUDY}"]`).click();
    const seriesRow = page.locator(`[data-testid="series-row-${SERIES}"]`);
    await seriesRow.waitFor({ state: "visible", timeout: 30_000 });
    const seriesText = await seriesRow.innerText();
    check(/Chest 1\.0/.test(seriesText), "一覧のシリーズの説明が新しい値（索引も更新）", seriesText);
    await page.screenshot({ path: path.join(OUT_DIR, "5-list.png") });
  } finally {
    await driver.stop();
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
