/*
 * 実アプリで "MRA Vessels"（vis-mra-vessels）プラグインを最初から最後まで通す実機検証スパイク。
 * プラグイン本体はこのリポジトリの外にある（graphy-next-plugin-mra-vessels）。
 *
 * 通すもの（偽のホストでは確かめられないこと）:
 *   - 本体の `host.openWindow` の中で three.js の WebGL が動く（3D が実際に描かれる）
 *   - `loadVolume` の幾何で解析が通り、既定のまま（何も選ばずに）「解析」を押して完走する
 *   - 表示の切り替えで 3D の画が実際に変わる／暗い背景に暗い文字になっていない
 *   - `showLabelVolume` で 2D の画が実際に変わり、もう一度押すと元に戻る
 *   - アンカーの手直し（3D のクリック → 吸着 → 再命名）と、`saveStore` への保存・復元
 *   - `saveSegmentation`（確認ダイアログ付き）で DICOM SEG が保存され、取り出せる
 *
 * 実行（プラグイン側で `npm run build` 済み。backend jar は再ビルド済み）:
 *   AUTOMATOR_DATA_DIR=<専用のデータ置き場> npx tsx src/spike/mraVesselsPluginCheck.ts \
 *     --plugin=<プラグインリポジトリ> --dicom=<DICOM ディレクトリ> [--name=<出力名>] [--no-edit]
 *
 * 専用ポートは 28771 番台。結果は `automator/.results/mra-vessels-check/<name>/` に出る
 * （スクリーンショットと、取り出した SEG）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
function requireDir(value: string | null, label: string): string {
  if (!value || !fs.existsSync(path.resolve(value))) {
    console.error(`--${label} を指定してください（存在するパス）。`);
    process.exit(2);
  }
  return path.resolve(value);
}

const PLUGIN_REPO = requireDir(arg("plugin"), "plugin");
const DICOM_DIR = requireDir(arg("dicom"), "dicom");
const NAME = arg("name") ?? "case";
const DO_EDIT = !process.argv.includes("--no-edit");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mra-vessels-check", NAME);
const PLUGIN_ID = JSON.parse(fs.readFileSync(path.join(PLUGIN_REPO, "plugin.json"), "utf8")).id as string;
const RESULT_TIMEOUT_MS = 25 * 60_000;
/** 窓の言語は本体の locale で決まる（日本語・英語のどちらでも通す）。 */
const RE = {
  disclaimer: /診断機器ではない|Not a diagnostic device/,
  overlayOk: /重ねました|Overlaid on the 2D/,
  overlayOn: /重ねを消す|Remove overlay/,
  overlayOff: /2D に重ねる|Overlay on 2D/,
  edited: /手直し済み|edited/i,
  saved: /保存しました|saved\./i,
  restored: /保存済みのアンカーを適用|Applied the saved anchors/,
  segSaved: /DICOM SEG を保存しました|Saved a DICOM SEG/,
};

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

function installPlugin(): void {
  const bundle = path.join(PLUGIN_REPO, "dist", "ui.js");
  if (!fs.existsSync(bundle)) throw new Error(`${bundle} がありません。プラグイン側で npm run build を実行してください。`);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  // 前回の痕跡を消してから置く（古い ui.js を掴まない）
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_REPO, "plugin.json"), path.join(dst, "plugin.json"));
  fs.copyFileSync(bundle, path.join(dst, "ui.js"));
  console.log(`プラグインを配置: ${dst}（ui.js ${(fs.statSync(bundle).size / 1024).toFixed(0)} KB, ${fs.statSync(bundle).mtime.toISOString()}）`);
}

const files = (dir: string): string[] =>
  fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  const driver = new DesktopDriver({ http: 28771, scp: 28772, vite: 28773 });
  const recorder = createStepRecorder();
  await driver.start();
  let v: Page | null = null;
  try {
    await resetDb(driver.ports.http);
    const imported = await importPaths(driver.ports.http, files(DICOM_DIR));
    console.log(`import: ${JSON.stringify(imported)}`);
    const main = driver.page;
    main.on("console", (m) => m.type() === "error" && console.log(`  [renderer error] ${m.text()}`));
    try {
      await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      await main.reload({ waitUntil: "domcontentloaded" });
      await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await openFirstSeriesInViewer(main, recorder);
    v = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    v.on("console", (m) => m.type() === "error" && console.log(`  [viewer error] ${m.text()}`));
    v.on("pageerror", (e) => console.log(`  [viewer pageerror] ${e.message}`));
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await v.waitForTimeout(2000);
    const shot = (n: string) => v!.screenshot({ path: path.join(OUT_DIR, n) });
    await shot("1-viewer.png");

    console.log("\n[1] Plug-ins メニューから窓を開く");
    await v.getByTestId("viewer2d-menu-plugins").click();
    const item = v.getByTestId(`plugin-item-${PLUGIN_ID}`);
    await item.waitFor({ state: "visible", timeout: 10_000 });
    check(true, "Plug-ins メニューにプラグインが出る");
    await item.click();
    const root = v.locator(".gnmv").first();
    await root.waitFor({ state: "visible", timeout: 15_000 });
    check(true, "窓が開く（.gnmv）");
    const disclaimer = (await root.locator("[data-role=disclaimer]").textContent()) ?? "";
    check(RE.disclaimer.test(disclaimer), "常時の注意書き（診断機器ではない）が出る", disclaimer.slice(0, 40));
    const series = (await root.locator("[data-role=series]").textContent()) ?? "";
    check(series.trim().length > 1 && series.includes("MR"), "対象のシリーズ（MR）が窓に出る", series);
    check(await root.locator("[data-act=analyze]").isEnabled(), "「解析」ボタンが押せる");
    check(await root.locator("[data-act=overlay]").isDisabled(), "結果が出るまで「2D に重ねる」は押せない");
    await shot("2-window.png");

    console.log("\n[2] 既定のまま（何も選ばずに）解析を押す");
    const t0 = Date.now();
    await root.locator("[data-act=analyze]").click();
    let state = "";
    while (Date.now() - t0 < RESULT_TIMEOUT_MS) {
      state = (await root.getAttribute("data-state")) ?? "";
      if (state === "result" || state === "error") break;
      const st = (await root.locator("[data-role=status]").textContent()) ?? "";
      console.log(`  … ${Math.round((Date.now() - t0) / 1000)}s [${state}] ${st.replace(/\s+/g, " ")}`);
      await v.waitForTimeout(10_000);
    }
    const elapsed = Math.round((Date.now() - t0) / 1000);
    check(state === "result", `解析が完走する（${elapsed}s）`, { state, status: await root.locator("[data-role=status]").textContent() });
    if (state !== "result") throw new Error("解析が結果に至らなかった");
    await shot("3-result.png");

    console.log("\n[3] 一覧と 3D");
    const rows = await root.locator(".gnmv-item").evaluateAll((els) => els.map((e) => ({ label: (e as HTMLElement).dataset.label, name: e.querySelector(".gnmv-nm")?.textContent ?? "", vol: e.querySelector(".gnmv-vol")?.textContent ?? "" })));
    console.log(`  一覧: ${rows.map((r) => `${r.name}(${r.vol})`).join(", ")}`);
    fs.writeFileSync(path.join(OUT_DIR, "rows.json"), JSON.stringify(rows, null, 1));
    check(rows.length >= 6, "血管の行が 6 種類以上ある", rows.length);
    check(rows.every((r) => /^\d+\.\d\d mL$/.test(r.vol)), "体積が mL で出ている（数値）");
    const anchorsText = (await root.locator("[data-role=anchors]").textContent()) ?? "";
    check(anchorsText.length > 0, "アンカーの状態（自動／手直し済み）が出る", anchorsText);

    const view = root.locator("[data-role=view]");
    const canvasSize = await view.locator("canvas").evaluate((c) => ({ w: (c as HTMLCanvasElement).clientWidth, h: (c as HTMLCanvasElement).clientHeight }));
    check(canvasSize.w > 200 && canvasSize.h > 200, "3D の canvas に大きさがある", canvasSize);
    const allShot = await view.screenshot({ path: path.join(OUT_DIR, "4a-3d-all.png") });
    await root.locator("[data-act=hide-all]").click();
    await v.waitForTimeout(500);
    const noneShot = await view.screenshot({ path: path.join(OUT_DIR, "4b-3d-none.png") });
    check(Buffer.compare(allShot, noneShot) !== 0 && allShot.length > noneShot.length * 1.15, "3D に血管が描かれている（全表示と全非表示で画が違い、全表示のほうが情報量が多い）", { all: allShot.length, none: noneShot.length });
    await root.locator("[data-act=show-all]").click();
    await root.locator(".gnmv-item [data-act=solo]").first().click();
    await v.waitForTimeout(500);
    const soloShot = await view.screenshot({ path: path.join(OUT_DIR, "4c-3d-solo.png") });
    check(Buffer.compare(allShot, soloShot) !== 0 && soloShot.length < allShot.length, "「だけ表示」で、画が変わり、情報量が減る", { all: allShot.length, solo: soloShot.length });
    const unchecked = await root.locator(".gnmv-item input[type=checkbox]:not(:checked)").count();
    check(unchecked === rows.length - 1, "「だけ表示」で、ほかの行のチェックが外れる", { unchecked, rows: rows.length });
    await root.locator("[data-act=show-all]").click();
    await v.waitForTimeout(500);

    // コントラスト（暗い背景に暗い文字ではない）
    const CONTRAST_BODY = `
      const lum = function (c) {
        const m = (c.match(/\\d+(\\.\\d+)?/g) || []).map(Number);
        const f = function (x) { const s = x / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
      };
      const bg = lum(getComputedStyle(el).backgroundColor);
      const out = {};
      for (const sel of ["[data-role=status]", ".gnmv-nm", ".gnmv-vol", "[data-role=disclaimer]", "[data-act=analyze]"]) {
        const t = el.querySelector(sel);
        if (!t) continue;
        const own = sel === "[data-role=disclaimer]" || sel === "[data-act=analyze]";
        const b = own ? lum(getComputedStyle(t).backgroundColor) : bg;
        const fg = lum(getComputedStyle(t).color);
        out[sel] = (Math.max(fg, b) + 0.05) / (Math.min(fg, b) + 0.05);
      }
      return out;
    `;
    // tsx の __name が page 側に無いので、本体は文字列で渡して new Function で実行する
    const contrast = (await root.evaluate((el, body) => new Function("el", body)(el), CONTRAST_BODY)) as Record<string, number>;
    console.log(`  コントラスト比: ${JSON.stringify(contrast)}`);
    check(Object.values(contrast).every((r) => r >= 4.5), "文字のコントラスト比が 4.5 以上（暗い背景に暗い文字ではない）", contrast);

    console.log("\n[4] 2D への重ね");
    const hideWin = () => v!.evaluate(() => { let e = document.querySelector(".gnmv") as HTMLElement | null; while (e && e.parentElement && e.parentElement !== document.body) e = e.parentElement; if (e) e.style.visibility = "hidden"; });
    const showWin = () => v!.evaluate(() => { let e = document.querySelector(".gnmv") as HTMLElement | null; while (e && e.parentElement && e.parentElement !== document.body) e = e.parentElement; if (e) e.style.visibility = "visible"; });
    // 既定の 2D は最下端のスライス（背景の雑音だけ）。血管の無い画では重ねが見えないので、中央のスライスへ送る
    const movedTo = await v.evaluate(() => {
      const sliders = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="range"]')).filter((x) => Number(x.max) >= 50);
      if (sliders.length === 0) return -1;
      const slider = sliders[0];
      const z = Math.round(Number(slider.max) * 0.5);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(slider, String(z));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      return z;
    });
    check(movedTo >= 0, `血管のある中央のスライス（${movedTo + 1}）へ移動できる`);
    await v.waitForTimeout(1500);
    const viewerEl = v.getByTestId("series-viewer-root").first();
    // 画像の領域だけを撮る（履歴ボタンなど、画像の外の UI の状態を混ぜない）。差は画素数で数える（canvas で復号）。
    const DIFF_BODY = `
      const dec = function (b64) {
        const bin = atob(b64); const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return createImageBitmap(new Blob([u8], { type: "image/png" })).then(function (bmp) {
          const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
          const x = c.getContext("2d"); x.drawImage(bmp, 0, 0); return x.getImageData(0, 0, bmp.width, bmp.height);
        });
      };
      return Promise.all([dec(a), dec(b)]).then(function (r) {
        const p = r[0], q = r[1];
        if (p.width !== q.width || p.height !== q.height) return -1;
        let n = 0;
        for (let i = 0; i < p.data.length; i += 4) {
          const d = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));
          if (d > 24) n++;
        }
        return n;
      });
    `;
    const diffPixels = (x: Buffer, y: Buffer): Promise<number> =>
      v!.evaluate(([aa, bb, body]) => new Function("a", "b", body)(aa, bb), [x.toString("base64"), y.toString("base64"), DIFF_BODY] as [string, string, string]) as Promise<number>;
    await hideWin(); await v.waitForTimeout(400);
    const before = await viewerEl.screenshot({ path: path.join(OUT_DIR, "5a-2d-before.png") });
    await showWin();
    await root.locator("[data-act=overlay]").click();
    await v.waitForTimeout(2500);
    const st1 = (await root.locator("[data-role=status]").textContent()) ?? "";
    check(RE.overlayOk.test(st1), "重ねた旨が出る", st1);
    check(RE.overlayOn.test((await root.locator("[data-act=overlay]").textContent()) ?? ""), "ボタンが「重ねを消す」に変わる");
    await hideWin(); await v.waitForTimeout(400);
    const after = await viewerEl.screenshot({ path: path.join(OUT_DIR, "5b-2d-overlay.png") });
    await showWin();
    const dOverlay = await diffPixels(before, after);
    check(dOverlay > 300, "重ねで、2D の画の相当数の画素が実際に変わる（300 画素超）", { changedPixels: dOverlay });
    await root.locator("[data-act=overlay]").click();
    await v.waitForTimeout(1500);
    await hideWin(); await v.waitForTimeout(400);
    const removed = await viewerEl.screenshot({ path: path.join(OUT_DIR, "5c-2d-removed.png") });
    await showWin();
    const dRemoved = await diffPixels(before, removed);
    check(dRemoved >= 0 && dRemoved < 20, "「重ねを消す」で、2D の画が元に戻る（差 20 画素未満）", { changedPixels: dRemoved });

    if (DO_EDIT) {
      console.log("\n[5] アンカーの手直し（3D のクリック）と、保存・復元");
      await root.locator("[data-act=pick-TL]").click();
      const box = await view.boundingBox();
      let manual = false;
      if (box) {
        // 3D 上の格子状の点を順にクリックして、血管に当たるまで探す（当たれば再命名が走り「手直し済み」になる）
        outer: for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
          for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7, 0.45, 0.55, 0.35, 0.65, 0.25, 0.75]) {
            await v.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
            await v.waitForTimeout(700);
            const stt = (await root.getAttribute("data-state")) ?? "";
            const a = (await root.locator("[data-role=anchors]").textContent()) ?? "";
            if (stt === "renaming" || RE.edited.test(a)) {
              for (let i = 0; i < 60 && (await root.getAttribute("data-state")) === "renaming"; i++) await v.waitForTimeout(1000);
              manual = RE.edited.test((await root.locator("[data-role=anchors]").textContent()) ?? "");
              break outer;
            }
          }
          if (!(await root.locator("[data-act=pick-TL]").evaluate((b) => b.classList.contains("on")))) break; // 取り消された
        }
      }
      check(manual, "3D 上のクリックでアンカーが手直しされる（吸着 → 再命名 → 手直し済み）", await root.locator("[data-role=status]").textContent());
      await shot("6-edited.png");
      if (manual) {
        await v.waitForTimeout(1500);
        const stSave = (await root.locator("[data-role=status]").textContent()) ?? "";
        check(RE.saved.test(stSave), "手直しが saveStore に保存される", stSave);
        // 再解析すると、保存済みのアンカーが自動で適用される（復元）
        await root.locator("[data-act=analyze]").click();
        let s2 = "";
        const t1 = Date.now();
        while (Date.now() - t1 < RESULT_TIMEOUT_MS) {
          s2 = (await root.getAttribute("data-state")) ?? "";
          const stx = (await root.locator("[data-role=status]").textContent()) ?? "";
          if (s2 === "error" || (s2 === "result" && RE.restored.test(stx))) break;
          await v.waitForTimeout(5_000);
        }
        const stRestore = (await root.locator("[data-role=status]").textContent()) ?? "";
        check(RE.restored.test(stRestore), "再解析で、保存済みのアンカーが復元される", stRestore);
        await shot("7-restored.png");
      }
    }

    console.log("\n[6] DICOM SEG の保存");
    await root.locator("[data-act=save-seg]").click();
    const dialog = v.getByTestId("plugin-save-confirm");
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    check(true, "本体の保存確認ダイアログが出る（抑止されない）");
    await shot("8-confirm.png");
    await v.getByTestId("plugin-save-confirm-button").click();
    await v.waitForTimeout(4000);
    const stSeg = (await root.locator("[data-role=status]").textContent()) ?? "";
    check(RE.segSaved.test(stSeg), "SEG を保存した旨が出る", stSeg);

    // 取り出す（REST）
    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid?: string; studyUid?: string }[];
    const studyUid = studies[0]?.studyInstanceUid ?? studies[0]?.studyUid ?? "";
    const seriesList = (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as { seriesInstanceUid: string; seriesDescription?: string; modality?: string }[];
    console.log(`  シリーズ: ${seriesList.map((s) => `${s.modality}:${s.seriesDescription}`).join(" | ")}`);
    const seg = seriesList.find((s) => s.modality === "SEG" || /MRA Vessels/.test(s.seriesDescription ?? ""));
    check(!!seg, "SEG のシリーズが保管庫に増える", seriesList.map((s) => s.modality));
    if (seg) {
      const dir = path.join(OUT_DIR, "seg");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const insts = (await (await fetch(`${base}/api/studies/${studyUid}/series/${seg.seriesInstanceUid}/instances`)).json()) as { sopInstanceUid: string }[];
      for (const [i, o] of insts.entries()) {
        const r = await fetch(`${base}/api/studies/${studyUid}/series/${seg.seriesInstanceUid}/instances/${o.sopInstanceUid}/file`);
        fs.writeFileSync(path.join(dir, `${i}.dcm`), Buffer.from(await r.arrayBuffer()));
      }
      check(insts.length >= 1, `SEG を取り出した（${insts.length} 個。${dir}）`);
    }
    console.log(`\n=== ${passed} 件合格 / ${failures.length} 件不合格 ===`);
    if (failures.length) {
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e);
    if (v) await v.screenshot({ path: path.join(OUT_DIR, "error.png") }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await driver.stop().catch(() => undefined);
  }
}

void main();
