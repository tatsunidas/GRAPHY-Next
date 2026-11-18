/*
 * 研究用画像形式プラグイン（graphy-next-plugin-research-formats）の実アプリ検査（Electron＋実 backend＋プラグイン配信経路）。
 * NIfTI 2 ファイル形式（.hdr＋.img）の書き出し（PM-IO-901 段 4a）。
 *
 * 実行:  （先に）cd backend && mvn -q -Dfrontend.skip=true -DskipTests package    （今の版の jar）
 *        cd <plugin> && mvn -q -f backend/pom.xml -Dgraphy.version=0.6.3 package    （research-formats.jar）
 *        cd automator && RF_PY=<nibabel・pydicom・numpy の入った python> GRAPHY_AUTOMATOR_HTTP_PORT=28700 GRAPHY_AUTOMATOR_SCP_PORT=28701 \
 *          GRAPHY_AUTOMATOR_VITE_PORT=28703 timeout 1200 npx tsx src/spike/researchFormatsPluginCheck.ts
 * 環境変数: RF_PLUGIN_DIR（既定 ~/graphy-workspace/graphy-next-plugin-research-formats）、RF_REAL_CT（実 CT のフォルダ。無ければその検査は未達）。
 *
 * 確かめること（メニューを実際に押す。選択窓・保存先のフォルダ〔ネイティブのダイアログは差し替え〕も画面から）:
 *  1. 既定（何も選んでいない）では［書き出す］が押せない。矢状は**名前を触らず既定のまま**通す。
 *  2. 矢状・軸位・冠状・斜位・4D: 保存した .hdr/.img を nibabel で独立照合（形・画素のビット一致・印の RAS・軸の向き・時相）。
 *  3. プラグインの JAR を通さない対照: 本体の単一ファイルの書き出しを gunzip したものと、.hdr は magic・vox_offset の 2 欄だけが違い、
 *     .img は画素がバイト一致する。
 *  4. 往復: 書き出した .hdr を本体の NIfTI 取り込みで戻し、もう一度書き出して、最初のものと形・affine・画素が一致。
 *  5. 負例: チルト・モザイクは理由つきの文言が出て、フォルダに何も書かれない。同名のファイルがあるフォルダは警告が出る。
 *  6. 一時ファイル（host.nifti の置き場）が残らない。
 *  7. 実 CT（RF_REAL_CT）を書き出し、画素が pydicom の期待値とビット一致・向きを 1 枚描いて目視用の画像を作る。
 *  8. BIDS データセット（ZIP）: シリーズを 1 本ずつ追加（既定のまま通す経路を含む）→ 書き出し → 展開して名前・中身・nibabel・公式の検証器
 *     （RF_BIDS_VALIDATOR）で照合。負例: 4 次元・チルト・保存の取り消し・氏名らしいデータセット名。検証器の負例（順序を壊す）も確かめる。
 * 結果は 合格・失敗・未達 に分けて数える。患者情報を含まない合成データ（実 CT は手元のみ・画像はリポジトリに入れない）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const PLUGIN_ID = "vis-research-formats";
const PLUGIN_DIR = process.env.RF_PLUGIN_DIR ?? path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-research-formats");
const REAL_CT = process.env.RF_REAL_CT ?? path.join(os.homedir(), "graphy-demo-samples", "HCC_001", "PRE LIVER");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "research-formats");
const PY = process.env.RF_PY ?? "python3";
const TOOL = path.join(AUTOMATOR_ROOT, "scripts", "check-nifti-markers.py");
const RENDER = path.join(AUTOMATOR_ROOT, "scripts", "render-nifti-slice.py");
const { check, summary } = createChecker();

function py(args: string[]): { status: number; out: string } {
  const r = spawnSync(PY, ["-I", ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const show = (s: string) => console.log(s.split("\n").filter(Boolean).map((l) => `    ${l.trim()}`).join("\n"));

function installPlugin(): void {
  const jar = path.join(PLUGIN_DIR, "backend", "target", "research-formats.jar");
  if (!fs.existsSync(jar)) throw new Error(`プラグインの JAR がありません（先にビルド）: ${jar}`);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_DIR, f), path.join(dst, f));
  fs.copyFileSync(jar, path.join(dst, "research-formats.jar"));
}

async function main(): Promise<number> {
  const probe = py(["-c", "import nibabel, pydicom, numpy"]);
  if (probe.status !== 0) {
    console.log(`【未達】nibabel / pydicom / numpy が使えません（RF_PY=${PY}）。独立照合ができないので合格にしません。\n${probe.out}`);
    return 2;
  }
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rf-check-"));
  const ph = path.join(work, "ph");
  const made = py([TOOL, "make", ph]);
  if (made.status !== 0) throw new Error(`合成シリーズを作れませんでした: ${made.out}`);
  const truth = JSON.parse(fs.readFileSync(path.join(ph, "truth.json"), "utf8")) as Record<string, { study: string; series: string }>;
  installPlugin();

  const hostTmp = path.join(os.tmpdir(), "graphy-plugin-nifti", PLUGIN_ID);
  fs.rmSync(hostTmp, { recursive: true, force: true });
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    const names = Object.keys(truth);
    const imp = await importPaths(driver.ports.http, names.map((n) => path.join(ph, n)));
    const total = names.reduce((n, name) => n + fs.readdirSync(path.join(ph, name)).length, 0);
    check(imp.failed === 0 && imp.imported === total, `（前提）合成シリーズ（${total} 枚）を取り込めた`, imp);
    let realSeries: { study: string; series: string } | null = null;
    if (fs.existsSync(REAL_CT)) {
      const ri = await importPaths(driver.ports.http, [REAL_CT]);
      check(ri.failed === 0 && ri.imported > 0, `（前提）実 CT（${ri.imported} 枚）を取り込めた`, ri);
      const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId?: string }[];
      for (const s of studies) {
        const sr = (await (await fetch(`${base}/api/studies/${s.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; numberOfInstances?: number }[];
        const hit = sr.find((x) => x.numberOfInstances === ri.imported);
        if (hit && !Object.values(truth).some((t) => t.study === s.studyInstanceUid)) realSeries = { study: s.studyInstanceUid, series: hit.seriesInstanceUid };
      }
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);

    const openWindow = async () => {
      await page.getByTestId("mainscreen-menu-plugins").click();
      await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
      await page.getByTestId("rf-run").waitFor({ state: "visible", timeout: 20_000 });
    };
    const pick = async (ids: { study: string; series: string }) => {
      await page.getByTestId("rf-pick-series").click();
      await page.getByTestId("pickseries-dialog").waitFor({ state: "visible", timeout: 20_000 });
      await page.getByTestId(`pickseries-expand-${ids.study}`).click();
      await page.getByTestId(`pickseries-series-check-${ids.series}`).check();
      await page.getByTestId("pickseries-ok").click();
      await page.getByTestId("pickseries-dialog").waitFor({ state: "detached", timeout: 10_000 });
    };
    const pickDir = async (dir: string) => {
      await driver.mockNativeDirectoryPicker!(dir);
      await page.getByTestId("rf-pick-dir").click();
      await page.waitForFunction((d) => document.querySelector('[data-testid="rf-dir-label"]')?.textContent === d, dir, { timeout: 10_000 });
    };
    const statusText = async (re: RegExp, ms = 90_000) => {
      await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="rf-status"]')?.textContent ?? ""), re.source, { timeout: ms });
      return (await page.getByTestId("rf-status").textContent()) ?? "";
    };
    const run = async (ids: { study: string; series: string }, dir: string, name?: string) => {
      await pick(ids);
      await pickDir(dir);
      if (name !== undefined) await page.getByTestId("rf-name").fill(name);
      await page.getByTestId("rf-run").click();
    };

    console.log("\n[1] 既定: 何も選んでいないと［書き出す］が押せない");
    await openWindow();
    check(await page.getByTestId("rf-run").isDisabled(), "シリーズ・フォルダ未選択では押せない", null);
    check((await page.getByTestId("rf-name").inputValue()) === "volume", "ファイル名の既定は volume", null);
    await page.screenshot({ path: path.join(OUT_DIR, "1-window-default.png") });

    console.log("\n[2] 矢状は名前を触らず既定のまま通す → 軸位・冠状・斜位・4D");
    const saved: Record<string, string> = {};
    const cases: [string, string | undefined][] = [["sagittal", undefined], ["axial", "axial"], ["coronal", "coronal"], ["oblique", "oblique"], ["dyn", "dyn"]];
    for (const [name, fname] of cases) {
      if (name !== "sagittal") {
        // 窓を開いたままなので、直前の結果をそのまま使えるか（再実行できるか）も見る
        await page.getByTestId("rf-result").waitFor({ state: "attached" });
      }
      const dir = path.join(OUT_DIR, `out-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      await run(truth[name], dir, fname);
      const text = await statusText(/書き出しました|できませんでした|失敗|食い違い|保存できません/);
      check(/書き出しました/.test(text), `${name}: 成功の文言が出る`, text);
      const stem = fname ?? "volume";
      const hdr = path.join(dir, `${stem}.hdr`);
      const img = path.join(dir, `${stem}.img`);
      check(fs.existsSync(hdr) && fs.existsSync(img) && fs.readdirSync(dir).length === 2, `${name}: ${stem}.hdr と ${stem}.img の 2 つだけが保存された`, fs.readdirSync(dir));
      if (!fs.existsSync(hdr)) continue;
      check(fs.statSync(hdr).size === 348, `${name}: .hdr は 348 バイト`, fs.statSync(hdr).size);
      saved[name] = hdr;
      if (name === "sagittal") await page.screenshot({ path: path.join(OUT_DIR, "2-exported-sagittal.png") });
      const c = name === "dyn" ? py([TOOL, "4d", hdr, ph]) : py([TOOL, "check", name, hdr, ph]);
      show(c.out);
      check(c.status === 0, `${name}: nibabel の独立照合（${name === "dyn" ? "形・時相間隔・各時相の画素" : "形・画素のビット一致・印の RAS・軸の向き"}）がすべて合格`);
    }

    console.log("\n[3] 対照（JAR を通さない）: 本体の単一ファイル書き出しと、2 欄（magic・vox_offset）だけが違い、画素はバイト一致");
    for (const name of ["sagittal", "oblique", "dyn"]) {
      const r = await fetch(`${base}/api/nifti/export`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studyUid: truth[name].study, seriesUid: truth[name].series }),
      });
      check(r.status === 200, `${name}: 本体の単一ファイル書き出しが 200`, r.status);
      const single = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));
      const hdr = fs.readFileSync(saved[name]);
      const img = fs.readFileSync(saved[name].replace(/\.hdr$/, ".img"));
      const diff: number[] = [];
      for (let i = 0; i < 348; i++) if (single[i] !== hdr[i]) diff.push(i);
      const allowed = new Set([108, 109, 110, 111, 345, 346]); // vox_offset（352→0）と magic（n+1→ni1: 345 '+'→'i'、346 '1'→'1'は同じ）
      check(diff.length > 0 && diff.every((i) => allowed.has(i) || (i >= 108 && i < 112) || i === 345), `${name}: ヘッダの差は vox_offset と magic だけ（差のバイト位置 ${JSON.stringify(diff)}）`);
      check(hdr.subarray(344, 348).equals(Buffer.from([0x6e, 0x69, 0x31, 0x00])) && hdr.readFloatLE(108) === 0, `${name}: magic = ni1・vox_offset = 0`);
      check(single.subarray(352).equals(img), `${name}: .img の画素が単一ファイルの画素とバイト一致（${img.length} バイト）`);
    }

    console.log("\n[4] 往復: 書き出した .hdr を本体の取り込みで戻し、もう一度書き出す");
    const imported = await fetch(`${base}/api/nifti/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: saved.sagittal, modality: "CT", patientId: "RF-ROUNDTRIP", patientName: "Round^Trip", seriesDescription: "rf-roundtrip" }),
    });
    const ij = (await imported.json()) as { studyInstanceUid: string; seriesInstanceUid: string; error: string | null };
    check(imported.ok && !ij.error, "（前提）書き出した .hdr を本体の取り込みで戻せた", ij);
    if (imported.ok && !ij.error) {
      const again = await fetch(`${base}/api/nifti/export`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studyUid: ij.studyInstanceUid, seriesUid: ij.seriesInstanceUid }),
      });
      check(again.status === 200, "取り込み直したシリーズをもう一度書き出せる", again.status);
      const f2 = path.join(OUT_DIR, "sagittal-roundtrip.nii.gz");
      fs.writeFileSync(f2, Buffer.from(await again.arrayBuffer()));
      const pc = py([TOOL, "pm", saved.sagittal, f2, "allow-no-nan"]);
      show(pc.out);
      check(pc.status === 0, "往復: 形・affine（1e-4）・画素が最初に書き出した .hdr/.img と一致");
    }

    console.log("\n[5] 負例: 断る形はフォルダに何も書かない。同名のファイルがあるフォルダは警告");
    for (const [name, word] of [["tilt", /ガントリーチルト/], ["mosaic", /モザイク/]] as const) {
      const dir = path.join(OUT_DIR, `out-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      await run(truth[name], dir, name);
      const text = await statusText(/書き出せませんでした|書き出しました|失敗/);
      check(word.test(text), `${name}: 理由の文言が出る`, text);
      check(fs.readdirSync(dir).length === 0, `${name}: フォルダに何も書かれない`, fs.readdirSync(dir));
      await page.screenshot({ path: path.join(OUT_DIR, `5-refused-${name}.png`) });
    }
    // 同名のファイルがあるフォルダ: 本体は上書きせず、2 つとも「名前 (2)」に揃えて保存する（観測済み）。対が保たれるので成功。
    const clash = path.join(OUT_DIR, "out-clash");
    fs.mkdirSync(clash, { recursive: true });
    fs.writeFileSync(path.join(clash, "axial.hdr"), "existing-hdr");
    fs.writeFileSync(path.join(clash, "axial.img"), "existing-img");
    await run(truth.axial, clash, "axial");
    const ctext = await statusText(/書き出しました|食い違い|保存できません|失敗/);
    console.log(`    観測: 両方が同名のフォルダの結果 → ${ctext}`);
    console.log(`    観測: フォルダの中身 → ${JSON.stringify(fs.readdirSync(clash).sort())}`);
    check(fs.readFileSync(path.join(clash, "axial.hdr"), "utf8") === "existing-hdr" && fs.readFileSync(path.join(clash, "axial.img"), "utf8") === "existing-img",
      "既存の同名ファイルは上書きされない");
    const renamedHdr = fs.readdirSync(clash).find((f) => /^axial \(\d+\)\.hdr$/.test(f));
    const renamedImg = fs.readdirSync(clash).find((f) => /^axial \(\d+\)\.img$/.test(f));
    check(!!renamedHdr && !!renamedImg && renamedHdr.replace(/\.hdr$/, "") === renamedImg.replace(/\.img$/, ""), "2 つとも同じ「名前 (N)」に揃って保存された（対が保たれる）", fs.readdirSync(clash));
    check(/書き出しました/.test(ctext) && /同じ名前のファイルがあったため/.test(ctext), "成功の文言に、別名で保存したことが出る", ctext);
    if (renamedHdr) {
      const c2 = py([TOOL, "check", "axial", path.join(clash, renamedHdr), ph]);
      check(c2.status === 0, "別名で保存した対も、nibabel の独立照合がすべて合格");
    }
    await page.screenshot({ path: path.join(OUT_DIR, "5-clash-renamed.png") });
    // 片方だけ同名（.img だけある）: 名前が揃わないので警告し、「書き出しました」とは言わない
    const half = path.join(OUT_DIR, "out-half");
    fs.mkdirSync(half, { recursive: true });
    fs.writeFileSync(path.join(half, "axial.img"), "existing-img");
    await run(truth.axial, half, "axial");
    const htext = await statusText(/書き出しました|食い違い|保存できません|失敗/);
    console.log(`    観測: 片方だけ同名のフォルダの結果 → ${htext}`);
    console.log(`    観測: フォルダの中身 → ${JSON.stringify(fs.readdirSync(half).sort())}`);
    check(/食い違いました/.test(htext) && !/書き出しました/.test(htext), "片方だけ同名のときは、名前が食い違った警告が出る（成功と言わない）", htext);
    check(fs.readFileSync(path.join(half, "axial.img"), "utf8") === "existing-img", "既存の .img は上書きされない");
    await page.screenshot({ path: path.join(OUT_DIR, "5-half-clash.png") });

    console.log("\n[6] 一時ファイルが残らない");
    const left = fs.existsSync(hostTmp) ? fs.readdirSync(hostTmp) : [];
    check(left.length === 0, `host.nifti の置き場（${hostTmp}）にファイルが残らない`, left);
    const mine = path.join(os.tmpdir(), "graphy-plugin-research-formats");
    const stray: string[] = [];
    if (fs.existsSync(mine)) for (const d of fs.readdirSync(mine)) for (const f of fs.readdirSync(path.join(mine, d))) stray.push(`${d}/${f}`);
    check(stray.length === 0, "プラグインの一時フォルダにファイルが残らない（空のフォルダは次回の掃除で消える）", stray);

    console.log("\n[7] 実 CT（手元のみ）: 画素が pydicom の期待値とビット一致・向きを目視");
    if (!realSeries) {
      console.log(`  [未達] 実 CT が無い／取り込めていません（RF_REAL_CT=${REAL_CT}）。この項目は合格に数えません。`);
    } else {
      const dir = path.join(OUT_DIR, "out-real");
      fs.mkdirSync(dir, { recursive: true });
      await run(realSeries, dir, "realct");
      const text = await statusText(/書き出しました|できませんでした|失敗|食い違い/, 180_000);
      check(/書き出しました/.test(text), "実 CT: 書き出せた", text);
      const hdr = path.join(dir, "realct.hdr");
      const code = [
        "import os,sys,numpy as np,pydicom,nibabel as nib",
        "root,hdr=sys.argv[1],sys.argv[2]",
        "ds=[pydicom.dcmread(os.path.join(root,f)) for f in os.listdir(root)]",
        "n=np.cross(np.array(ds[0].ImageOrientationPatient[:3],float),np.array(ds[0].ImageOrientationPatient[3:],float))",
        "ds.sort(key=lambda d:float(np.dot(n,np.array(d.ImagePositionPatient,float))))",
        "vol=np.stack([(d.pixel_array.astype(np.float32)*np.float32(d.RescaleSlope)+np.float32(d.RescaleIntercept)).astype(np.float32) for d in ds])",
        "a=np.asarray(nib.load(hdr).dataobj); e=np.ascontiguousarray(np.transpose(vol,(2,1,0)))",
        "ok=a.shape==e.shape and np.array_equal(a.view(np.uint32),e.view(np.uint32))",
        "print('shape',a.shape,'bit-identical',ok); sys.exit(0 if ok else 1)",
      ].join("\n");
      const r = py(["-c", code, REAL_CT, hdr]);
      show(r.out);
      check(r.status === 0, "実 CT: .hdr/.img の画素が pydicom の期待値（HU・float32）とビット一致");
      const png = path.join(OUT_DIR, "real-ct-axial.png");
      const rr = py([RENDER, hdr, png, "axial", "auto"]);
      show(rr.out);
      check(rr.status === 0 && fs.existsSync(png), `実 CT: 目視用の画像を作った（${png}。A が上・肝臓が画像左であることを目で確かめる）`);
    }

    console.log("\n[8] BIDS データセット（ZIP）: シリーズを 1 本ずつ追加 → 書き出し → 展開して独立照合");
    {
      const zipPath = path.join(OUT_DIR, "bids-out", "dataset.zip");
      fs.mkdirSync(path.dirname(zipPath), { recursive: true });
      const mockSave = async (target: string | null) => {
        await driver.app.evaluate(({ dialog }, p) => {
          dialog.showSaveDialog = (async () => (p ? { canceled: false, filePath: p } : { canceled: true, filePath: undefined })) as unknown as typeof dialog.showSaveDialog;
        }, target);
      };
      const addSeries = async (ids: { study: string; series: string }, o: { suffix?: string; subject?: string; session?: string } = {}) => {
        if (o.suffix) await page.getByTestId("rf-bids-suffix").selectOption(o.suffix);
        if (o.subject !== undefined) await page.getByTestId("rf-bids-subject").fill(o.subject);
        if (o.session !== undefined) await page.getByTestId("rf-bids-session").fill(o.session);
        await page.getByTestId("rf-bids-add").click();
        await page.getByTestId("pickseries-dialog").waitFor({ state: "visible", timeout: 20_000 });
        await page.getByTestId(`pickseries-expand-${ids.study}`).click();
        await page.getByTestId(`pickseries-series-check-${ids.series}`).check();
        await page.getByTestId("pickseries-ok").click();
        await page.getByTestId("pickseries-dialog").waitFor({ state: "detached", timeout: 10_000 });
      };
      const rows = async () => page.getByTestId("rf-bids-list").locator('[data-testid^="rf-bids-row-"]').count();
      const clearRows = async () => {
        while ((await rows()) > 0) await page.getByTestId("rf-bids-remove-0").click();
      };
      await page.getByTestId("rf-format").selectOption("bids");
      check(await page.getByTestId("rf-run").isDisabled(), "BIDS: シリーズ 0 本では［書き出す］が押せない（既定）", null);
      check((await page.getByTestId("rf-bids-name").inputValue()) === "dataset", "BIDS: データセット名の既定は dataset", null);

      // 既定のまま通す経路: 被験者・セッション・名前を触らない（種類だけ T1w の既定）
      await mockSave(zipPath);
      await addSeries(truth.axial);                                  // T1w・被験者 1・セッションなし（既定のまま）
      await addSeries(truth.coronal);                                // T1w・被験者 1 → run-01/02 になる
      await addSeries(truth.sagittal, { suffix: "T2w", subject: "2", session: "1" });
      await addSeries(truth.oblique, { suffix: "FLAIR", subject: "2", session: "1" });
      check((await rows()) === 4, "BIDS: 4 本が表に並ぶ", await rows());
      await page.screenshot({ path: path.join(OUT_DIR, "8-bids-rows.png") });
      await page.getByTestId("rf-run").click();
      const t8 = await statusText(/書き出しました|作れませんでした|書き出せませんでした|失敗|保存できません|保存をやめました/, 120_000);
      check(/書き出しました（4 シリーズ・被験者 2 人）/.test(t8), "BIDS: 成功の文言（4 シリーズ・被験者 2 人）", t8);
      await page.screenshot({ path: path.join(OUT_DIR, "8-bids-done.png") });
      check(fs.existsSync(zipPath), "BIDS: ZIP が保存された", null);
      const ds = path.join(OUT_DIR, "bids-out", "ds");
      fs.rmSync(ds, { recursive: true, force: true });
      py(["-c", "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, ds]);
      const listing = (function walk(d: string, rel = ""): string[] {
        return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();
      })(ds);
      const expected = [
        "README", "dataset_description.json", "participants.tsv",
        "sub-001/anat/sub-001_run-01_T1w.nii.gz", "sub-001/anat/sub-001_run-02_T1w.nii.gz",
        "sub-002/ses-01/anat/sub-002_ses-01_FLAIR.nii.gz", "sub-002/ses-01/anat/sub-002_ses-01_T2w.nii.gz",
      ].sort();
      check(JSON.stringify(listing) === JSON.stringify(expected), "BIDS: ファイルの構成・名前が仕様どおり（sub・ses・run の順）", listing);
      const desc = JSON.parse(fs.readFileSync(path.join(ds, "dataset_description.json"), "utf8")) as Record<string, string>;
      check(desc.Name === "dataset" && desc.BIDSVersion === "1.10.1" && desc.DatasetType === "raw", "BIDS: dataset_description.json（Name・BIDSVersion・DatasetType）", desc);
      check(fs.readFileSync(path.join(ds, "participants.tsv"), "utf8") === "participant_id\nsub-001\nsub-002\n", "BIDS: participants.tsv は連番の participant_id だけ");
      const wholeText = listing.filter((f) => !f.endsWith(".nii.gz")).map((f) => fs.readFileSync(path.join(ds, f), "utf8")).join("\n") + listing.join("\n");
      check(!/RF-|PH-NIFTI|PHANTOM|HCC|Round\^Trip/i.test(wholeText), "BIDS: 患者 ID・氏名らしき文字列がファイル名・中身に無い（合成データの ID・名前を検索）");
      // 各 NIfTI を nibabel で独立照合（向き・画素。シリーズ名 → 期待の真値）
      for (const [rel, name] of [
        ["sub-001/anat/sub-001_run-01_T1w.nii.gz", "axial"], ["sub-001/anat/sub-001_run-02_T1w.nii.gz", "coronal"],
        ["sub-002/ses-01/anat/sub-002_ses-01_T2w.nii.gz", "sagittal"], ["sub-002/ses-01/anat/sub-002_ses-01_FLAIR.nii.gz", "oblique"],
      ] as const) {
        const c = py([TOOL, "check", name, path.join(ds, rel), ph]);
        check(c.status === 0, `BIDS: ${rel} が ${name} の真値と一致（形・画素のビット一致・印の RAS・軸の向き）`);
      }
      // 公式の検証器（npm の bids-validator）。正例: エラー 0。想定外の警告（NIFTI_UNIT など）が無いこと
      const validator = process.env.RF_BIDS_VALIDATOR;
      if (!validator || !fs.existsSync(validator)) {
        console.log("  [未達] BIDS の検証器（RF_BIDS_VALIDATOR=bids-validator の実行ファイル）が無い。この項目は合格に数えません。");
      } else {
        const v = spawnSync(validator, [ds], { encoding: "utf8" });
        const out = `${v.stdout ?? ""}${v.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
        fs.writeFileSync(path.join(OUT_DIR, "bids-validator.txt"), out);
        const errs = (out.match(/\[ERR\]/g) ?? []).length;
        const warnCodes = [...out.matchAll(/\[WARN\][^\n]*\(code: (\d+) - ([A-Z_]+)\)/g)].map((m) => m[2]);
        check(errs === 0, `BIDS: 公式の検証器でエラー 0（警告: ${JSON.stringify(warnCodes)}）`, out.slice(0, 600));
        const unexpected = warnCodes.filter((c) => !["INCONSISTENT_SUBJECTS", "MISSING_SESSION", "NO_AUTHORS"].includes(c));
        check(unexpected.length === 0, `BIDS: 想定外の警告が無い（被験者ごとに構成が違う・Authors なしは想定どおり。本体の NIfTI は単位つきなので NIFTI_UNIT も出ない）`, unexpected);
        // 検出器の負例: 同じデータセットの名前の順序を壊すと検証器が実際に落ちる
        const bad = path.join(OUT_DIR, "bids-out", "ds-bad");
        fs.rmSync(bad, { recursive: true, force: true });
        fs.cpSync(ds, bad, { recursive: true });
        fs.renameSync(path.join(bad, "sub-002/ses-01/anat/sub-002_ses-01_T2w.nii.gz"), path.join(bad, "sub-002/ses-01/anat/sub-002_run-01_ses-01_T2w.nii.gz"));
        const vb = spawnSync(validator, [bad], { encoding: "utf8" });
        check(((`${vb.stdout}${vb.stderr}`).match(/\[ERR\]/g) ?? []).length > 0, "BIDS（負例）: エンティティの順序を壊すと、同じ検証器がエラーを出す（検出器が効いている）");
      }

      // 負例: 4 次元は anat にできない。理由つきで断られ、保存ダイアログも出ない・ファイルも出ない
      await clearRows();
      const zip2 = path.join(OUT_DIR, "bids-out", "should-not-exist.zip");
      await mockSave(zip2);
      await addSeries(truth.dyn);
      await page.getByTestId("rf-run").click();
      const t9 = await statusText(/書き出しました|作れませんでした|書き出せませんでした|失敗|保存できません/, 120_000);
      check(/4 次元/.test(t9), "BIDS（負例）: 4 次元（dyn）は anat にできないと理由つきで断る", t9);
      check(!fs.existsSync(zip2), "BIDS（負例）: ZIP は保存されない", null);
      await page.screenshot({ path: path.join(OUT_DIR, "8-bids-refused-4d.png") });
      await clearRows();
      // 負例: チルトは本体が断る
      await addSeries(truth.tilt);
      await page.getByTestId("rf-run").click();
      const t10 = await statusText(/書き出しました|作れませんでした|書き出せませんでした|失敗|保存できません/, 120_000);
      check(/ガントリーチルト/.test(t10), "BIDS（負例）: チルトは本体の理由で断る", t10);
      check(!fs.existsSync(zip2), "BIDS（負例）: ZIP は保存されない（チルト）", null);
      await clearRows();
      // 負例: 保存ダイアログを取り消すと保存しない
      await mockSave(null);
      await addSeries(truth.axial);
      await page.getByTestId("rf-run").click();
      const t11 = await statusText(/書き出しました|作れませんでした|書き出せませんでした|失敗|保存できません|保存をやめました/, 120_000);
      check(/保存をやめました/.test(t11), "BIDS（負例）: 保存ダイアログの取り消しは「保存をやめました」", t11);
      // 不正なデータセット名では押せない（氏名の入力を防ぐ）
      await page.getByTestId("rf-bids-name").fill("山田太郎");
      check(await page.getByTestId("rf-run").isDisabled(), "BIDS（負例）: 英数字以外のデータセット名（氏名など）では押せない", null);
      await page.getByTestId("rf-bids-name").fill("dataset");
      await clearRows();
      check((await page.getByTestId("rf-bids-list").innerText()).includes("まだありません"), "BIDS: 削除で表が空に戻る");
      await page.screenshot({ path: path.join(OUT_DIR, "8-bids-empty.png") });
    }
    {
      const left2 = fs.existsSync(hostTmp) ? fs.readdirSync(hostTmp) : [];
      check(left2.length === 0, `BIDS 後も host.nifti の置き場にファイルが残らない`, left2);
      const mine2 = path.join(os.tmpdir(), "graphy-plugin-research-formats");
      const stray2: string[] = [];
      if (fs.existsSync(mine2)) for (const d of fs.readdirSync(mine2)) for (const f of fs.readdirSync(path.join(mine2, d))) stray2.push(`${d}/${f}`);
      check(stray2.length === 0, "BIDS 後もプラグインの一時フォルダにファイルが残らない（本体が成果物を預かって移す）", stray2);
    }

    console.log("\n【未達】実行中のジョブを［中止］で止める経路（小さい合成では一瞬で終わる）。JAR の取り消しは単体で確認。");
    console.log(`\n出力: ${OUT_DIR}`);
    return summary();
  } catch (e) {
    await driver.page.screenshot({ path: path.join(OUT_DIR, "failure.png") }).catch(() => undefined);
    throw e;
  } finally {
    await driver.stop().catch(() => undefined);
    fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID), { recursive: true, force: true });
    fs.rmSync(hostTmp, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
