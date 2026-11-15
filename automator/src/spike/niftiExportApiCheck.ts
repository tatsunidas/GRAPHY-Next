/*
 * NIfTI 書き出し API（POST /api/nifti/export）の実アプリ検査（backend の jar を起動して、実際に HTTP で呼ぶ）。
 *
 * 合成 CT（軸位・冠状・矢状・斜位。位置の逆順で保管・LPS の既知の 3 点に印）を取り込み、書き出した .nii.gz を
 * **nibabel で読んで**（本体の書き手とは別の実装）、形・画素のビット一致・印の RAS・軸の向きの文字を確かめる。
 * 負例: ガントリーチルトの形・欠けたスライスは、ファイルを流す前に 422 と理由コードで断る。
 * 往復: float の NIfTI（NaN を含む）を Parametric Map として取り込み → 書き出し → 元の NIfTI と形・affine・画素・NaN が一致。
 *
 * 実行（先に backend の jar を作り直す。専用ポートは GRAPHY_AUTOMATOR_*_PORT。JDK を PATH に足す）:
 *   cd automator && NIFTI_PY=<nibabel・pydicom・numpy の入った python> npx tsx src/spike/niftiExportApiCheck.ts
 * 結果は 合格・失敗・未達 に分けて数える。患者情報を含まない合成データ。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const PY = process.env.NIFTI_PY ?? "python3";
const TOOL = path.join(AUTOMATOR_ROOT, "scripts", "check-nifti-markers.py");
const MAKE_FLOAT = path.join(AUTOMATOR_ROOT, "scripts", "make-float-nifti.py");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "nifti-export-api");

function py(args: string[]): { status: number; out: string } {
  const r = spawnSync(PY, ["-I", ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function main(): Promise<number> {
  const probe = py(["-c", "import nibabel, pydicom, numpy"]);
  if (probe.status !== 0) {
    console.log(`【未達】nibabel / pydicom / numpy が使えません（NIFTI_PY=${PY}）。独立照合ができないので合格にしません。\n${probe.out}`);
    return 2;
  }
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nifti-export-"));
  const ph = path.join(work, "ph");
  const made = py([TOOL, "make", ph]);
  if (made.status !== 0) throw new Error(`合成シリーズを作れませんでした: ${made.out}`);
  const truth = JSON.parse(fs.readFileSync(path.join(ph, "truth.json"), "utf8")) as Record<string, { study: string; series: string }>;
  const floatNii = path.join(work, "adc.nii.gz");
  const truthFloat = path.join(work, "adc-truth.json");
  const gen = py([MAKE_FLOAT, floatNii, truthFloat]);
  if (gen.status !== 0) throw new Error(`float の NIfTI を作れませんでした: ${gen.out}`);

  const driver = new DesktopDriver();
  try {
    await driver.start();
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    const names = Object.keys(truth);
    const imp = await importPaths(driver.ports.http, names.map((n) => path.join(ph, n)));
    check(imp.failed === 0 && imp.imported === 16 * 6 + 15 + 5 + 47 + 48 - 16, "（前提）合成シリーズ（3D・欠け・チルト・モザイク 5 枚・時相 48 枚・時相の欠け 47 枚）を取り込めた", imp);

    const exportOf = async (name: string) => {
      const t = truth[name];
      return fetch(`${base}/api/nifti/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studyUid: t.study, seriesUid: t.series }) });
    };

    console.log("\n[1] 4 つの向き（位置の逆順で保管）: 書き出して nibabel で読む");
    for (const name of ["axial", "coronal", "sagittal", "oblique"]) {
      const res = await exportOf(name);
      check(res.status === 200 && /gzip/.test(res.headers.get("content-type") ?? ""), `${name}: 200 application/gzip`, res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      check(buf.length === Number(res.headers.get("content-length")) && res.headers.get("x-graphy-slices") === "16", `${name}: Content-Length どおりに流れ、スライス 16`, { len: buf.length, cl: res.headers.get("content-length"), sl: res.headers.get("x-graphy-slices") });
      check(!/(PH-NIFTI|PHANTOM)/.test(buf.toString("latin1")) && /^attachment; filename="CT_volume\.nii\.gz"$/.test(res.headers.get("content-disposition") ?? ""), `${name}: ファイル名・ヘッダに患者情報なし`, res.headers.get("content-disposition"));
      const f = path.join(OUT_DIR, `${name}.nii.gz`);
      fs.writeFileSync(f, buf);
      const r = py([TOOL, "check", name, f, ph]);
      console.log(r.out.split("\n").filter(Boolean).map((l) => `    ${l.trim()}`).join("\n"));
      check(r.status === 0, `${name}: nibabel の独立照合がすべて合格`);
    }

    console.log("\n[2] 負例: 断る形は、ファイルを流す前に 422 と理由");
    for (const [name, reason] of [["tilt", "volume-sheared"], ["gap", "npz-uneven-spacing"], ["mosaic", "nifti-mosaic"], ["uneven4d", "nifti-uneven-phases"]] as const) {
      const res = await exportOf(name);
      const body = (await res.text()).slice(0, 200);
      check(res.status === 422 && body.includes(reason) && !/gzip/.test(res.headers.get("content-type") ?? ""), `${name}: 422 ${reason}（200 の空ファイルを返さない）`, { status: res.status, body });
    }
    const bad = await fetch(`${base}/api/nifti/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studyUid: "" }) });
    check(bad.status === 400, "入力が足りないと 400", bad.status);

    console.log("\n[2b] 4D: 3 時相 × 16 枚（位置の逆順・時相をインターリーブして保管。TemporalPositionIdentifier と AcquisitionTime 2 秒間隔）");
    const dyn = await exportOf("dyn");
    check(dyn.status === 200 && dyn.headers.get("x-graphy-slices") === "48", "dyn: 200・48 枚", { status: dyn.status, sl: dyn.headers.get("x-graphy-slices") });
    const df = path.join(OUT_DIR, "dyn.nii.gz");
    fs.writeFileSync(df, Buffer.from(await dyn.arrayBuffer()));
    const dc = py([TOOL, "4d", df, ph]);
    console.log(dc.out.split("\n").filter(Boolean).map((l) => `    ${l.trim()}`).join("\n"));
    check(dc.status === 0, "dyn: nibabel の独立照合（形・時相間隔・各時相の画素のビット一致・単位・向き）がすべて合格");

    // 実モザイク（任意）: 環境変数 NIFTI_REAL_MOSAIC に、モザイク形式の DICOM シリーズのフォルダを渡したときだけ。データはリポジトリに入れない
    const realMosaic = process.env.NIFTI_REAL_MOSAIC;
    if (realMosaic && fs.existsSync(realMosaic)) {
      console.log("\n[2c] 実データのモザイク（ローカルのみ）は、書き出しが nifti-mosaic で断られる");
      const before = new Set(((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[]).map((x) => x.studyInstanceUid));
      const ri = await importPaths(driver.ports.http, [realMosaic]);
      check(ri.failed === 0 && ri.imported > 0, "（前提）実モザイクを取り込めた", ri);
      const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
      const sid = studies.find((x) => !before.has(x.studyInstanceUid))?.studyInstanceUid;
      const list = sid ? ((await (await fetch(`${base}/api/studies/${sid}/series`)).json()) as { seriesInstanceUid: string }[]) : [];
      check(list.length === 1, "（前提）実モザイクが 1 シリーズ", list.length);
      if (sid && list.length === 1) {
        const rr = await fetch(`${base}/api/nifti/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studyUid: sid, seriesUid: list[0].seriesInstanceUid }) });
        const rb = (await rr.text()).slice(0, 160);
        check(rr.status === 422 && rb.includes("nifti-mosaic"), "実モザイク: 422 nifti-mosaic（黙って誤った幾何の NIfTI を作らない）", { status: rr.status, body: rb });
      }
    } else {
      console.log("\n  [未達] 実データのモザイク（NIFTI_REAL_MOSAIC 未指定）");
    }

    console.log("\n[3] 往復: float の NIfTI（NaN を含む）→ Parametric Map として取り込み → 書き出し → 元と一致");
    const ir = await fetch(`${base}/api/nifti/import`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: floatNii, modality: "MR", patientId: "NIFTI-FLOAT", patientName: "Float^Nifti", seriesDescription: "ADC float", valueUnit: "mm2/s" }) });
    const imported = (await ir.json()) as { studyInstanceUid: string; seriesInstanceUid: string; error: string | null };
    check(ir.ok && !imported.error, "（前提）float の NIfTI を取り込めた", imported);
    const pr = await fetch(`${base}/api/nifti/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studyUid: imported.studyInstanceUid, seriesUid: imported.seriesInstanceUid }) });
    check(pr.status === 200, "Parametric Map を書き出せる", pr.status);
    const pf = path.join(OUT_DIR, "pm-roundtrip.nii.gz");
    fs.writeFileSync(pf, Buffer.from(await pr.arrayBuffer()));
    const pc = py([TOOL, "pm", floatNii, pf]);
    console.log(pc.out.split("\n").filter(Boolean).map((l) => `    ${l.trim()}`).join("\n"));
    check(pc.status === 0, "往復: 形・affine・NaN の位置と画素が元の NIfTI と一致");
    console.log(`\n出力: ${OUT_DIR}`);
    return summary();
  } finally {
    await driver.stop().catch(() => undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
