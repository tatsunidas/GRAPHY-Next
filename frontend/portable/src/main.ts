/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Portable 2D Viewer — エントリ。フォルダ選択 → DICOMDIR 解析 → シリーズ一覧 → StackViewport 表示。
// サーバ不要・Cornerstone3D をローカル File から直接読む（fw/export-portable-viewer.md 方式 A）。
import "./style.css";
import {
  parseDicomDir,
  findDicomDirFile,
  type DicomDirModel,
  type SeriesRec,
} from "./dicomdir";
import { PortableViewer, type ViewerElements } from "./viewer";
import { WL_PRESETS } from "./wlPresets";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`要素が見つかりません: ${sel}`);
  return el;
};

const folderInput = $<HTMLInputElement>("#folder-input");
const pickBtn = $<HTMLButtonElement>("#pick-btn");
const resetBtn = $<HTMLButtonElement>("#reset-btn");
const fitBtn = $<HTMLButtonElement>("#fit-btn");
const actualBtn = $<HTMLButtonElement>("#actual-btn");
const rotateBtn = $<HTMLButtonElement>("#rotate-btn");
const flipHBtn = $<HTMLButtonElement>("#fliph-btn");
const flipVBtn = $<HTMLButtonElement>("#flipv-btn");
const invertBtn = $<HTMLButtonElement>("#invert-btn");
const treeEl = $<HTMLDivElement>("#tree");
const statusEl = $<HTMLDivElement>("#status");
// P4.2 コントロール。
const wlPresetSel = $<HTMLSelectElement>("#wl-preset");
const wwInput = $<HTMLInputElement>("#ww-input");
const wcInput = $<HTMLInputElement>("#wc-input");
const wlSetBtn = $<HTMLButtonElement>("#wl-set-btn");
const pngBtn = $<HTMLButtonElement>("#png-btn");
const cinebar = $<HTMLDivElement>("#cinebar");
const playBtn = $<HTMLButtonElement>("#play-btn");
const sliceSlider = $<HTMLInputElement>("#slice-slider");
const sliceLabel = $<HTMLSpanElement>("#slice-label");
const fpsInput = $<HTMLInputElement>("#fps-input");

const viewerEls: ViewerElements = {
  viewport: $<HTMLDivElement>("#viewport"),
  overlayTL: $<HTMLDivElement>("#overlay-tl"),
  overlayTR: $<HTMLDivElement>("#overlay-tr"),
  overlayBL: $<HTMLDivElement>("#overlay-bl"),
  overlayBR: $<HTMLDivElement>("#overlay-br"),
  scalebarBar: $<HTMLDivElement>("#scalebar-bar"),
  scalebarLabel: $<HTMLDivElement>("#scalebar-label"),
};

let viewer: PortableViewer | null = null;
let model: DicomDirModel | null = null;
let activeSeriesEl: HTMLElement | null = null;
let cineTimer: number | null = null;
let syncing = false; // onChange 由来の DOM 更新中は入力ハンドラを抑止。

function setStatus(msg: string, kind: "info" | "error" = "info"): void {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

// W/L プリセット一覧を dropdown へ（先頭「既定 (DICOM)」は index.html の固定 option）。
for (const p of WL_PRESETS) {
  const opt = document.createElement("option");
  opt.value = p.key;
  opt.textContent = `${p.label}  (W${p.width}/L${p.center})`;
  wlPresetSel.appendChild(opt);
}

/** ビューア状態 → UI（スライダ・WW/WC 入力・スライスラベル）を同期。 */
function syncUi(): void {
  if (!viewer) return;
  syncing = true;
  const total = viewer.imageTotal();
  const idx = viewer.imageIndex();
  cinebar.hidden = total <= 1;
  sliceSlider.max = String(Math.max(0, total - 1));
  sliceSlider.value = String(idx);
  sliceLabel.textContent = `${idx + 1} / ${total}`;
  const wl = viewer.getWL();
  if (wl && document.activeElement !== wwInput && document.activeElement !== wcInput) {
    wwInput.value = String(wl.width);
    wcInput.value = String(wl.center);
  }
  syncing = false;
}

function stopCine(): void {
  if (cineTimer !== null) {
    clearInterval(cineTimer);
    cineTimer = null;
  }
  playBtn.textContent = "▶";
}

function toggleCine(): void {
  if (!viewer || viewer.imageTotal() <= 1) return;
  if (cineTimer !== null) {
    stopCine();
    return;
  }
  const fps = Math.max(1, Math.min(60, Number(fpsInput.value) || 12));
  playBtn.textContent = "⏸";
  cineTimer = window.setInterval(() => {
    if (!viewer) return;
    const total = viewer.imageTotal();
    const next = (viewer.imageIndex() + 1) % total;
    void viewer.setImageIndex(next);
  }, 1000 / fps);
}

async function ensureViewer(): Promise<PortableViewer> {
  if (!viewer) {
    setStatus("ビューアを初期化しています…");
    viewer = new PortableViewer(viewerEls);
    await viewer.setup();
    viewer.onChange = syncUi;
  }
  return viewer;
}

async function showSeries(series: SeriesRec): Promise<void> {
  try {
    const v = await ensureViewer();
    stopCine();
    const withFiles = series.images.filter((im) => im.file).length;
    setStatus(`表示中… (${withFiles}/${series.images.length} ファイル)`);
    await v.showSeries(series.images);
    syncUi();
    setStatus(`${series.images.length} 画像を読み込みました`);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "error");
  }
}

function buildTree(m: DicomDirModel): void {
  treeEl.replaceChildren();
  if (m.patients.length === 0) {
    treeEl.textContent = "DICOMDIR にレコードがありません";
    return;
  }
  for (const pat of m.patients) {
    const patNode = document.createElement("div");
    patNode.className = "node patient";
    patNode.textContent = `👤 ${pat.name || pat.id || "(no name)"}`;
    treeEl.appendChild(patNode);

    for (const st of pat.studies) {
      const styNode = document.createElement("div");
      styNode.className = "node study";
      const styLabel = [st.date, st.description].filter(Boolean).join("  ") || "(study)";
      styNode.textContent = `📁 ${styLabel}`;
      treeEl.appendChild(styNode);

      for (const se of st.series) {
        const seNode = document.createElement("div");
        seNode.className = "node series";
        const missing = se.images.filter((im) => !im.file).length;
        const seLabel =
          se.description || `${se.modality} Series ${se.number ?? ""}`.trim() || "(series)";
        seNode.textContent = `🖼 ${seLabel}  [${se.modality}] ${se.images.length}`;
        if (missing > 0) seNode.title = `${missing} 件の参照ファイルが見つかりません`;
        seNode.addEventListener("click", () => {
          if (activeSeriesEl) activeSeriesEl.classList.remove("active");
          seNode.classList.add("active");
          activeSeriesEl = seNode;
          void showSeries(se);
        });
        treeEl.appendChild(seNode);
      }
    }
  }
}

async function handleFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  setStatus("DICOMDIR を探しています…");
  const dicomdir = findDicomDirFile(files);
  if (!dicomdir) {
    setStatus(
      "選択フォルダに DICOMDIR が見つかりません。Export のルート（DICOMDIR を含む）を選んでください。",
      "error",
    );
    return;
  }
  try {
    setStatus("DICOMDIR を解析しています…");
    model = await parseDicomDir(dicomdir, files);
    buildTree(model);
    const totalSeries = model.patients.reduce(
      (n, p) => n + p.studies.reduce((k, s) => k + s.series.length, 0),
      0,
    );
    const miss = model.missingFiles > 0 ? `（未解決参照 ${model.missingFiles} 件）` : "";
    setStatus(`${model.patients.length} 患者 / ${totalSeries} シリーズを読み込みました${miss}`);
  } catch (e) {
    setStatus(`DICOMDIR 解析に失敗: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

pickBtn.addEventListener("click", () => folderInput.click());
folderInput.addEventListener("change", () => {
  const files = folderInput.files ? Array.from(folderInput.files) : [];
  void handleFiles(files);
});
resetBtn.addEventListener("click", () => viewer?.resetView());
fitBtn.addEventListener("click", () => viewer?.fit());
actualBtn.addEventListener("click", () => viewer?.actualSize());
rotateBtn.addEventListener("click", () => viewer?.rotate90());
flipHBtn.addEventListener("click", () => viewer?.flipH());
flipVBtn.addEventListener("click", () => viewer?.flipV());
invertBtn.addEventListener("click", () => viewer?.invert());
window.addEventListener("resize", () => viewer?.resize());

// W/L プリセット選択（空値=既定 DICOM）。
wlPresetSel.addEventListener("change", () => {
  if (!viewer) return;
  const key = wlPresetSel.value;
  if (!key) {
    viewer.defaultWL();
  } else {
    const p = WL_PRESETS.find((x) => x.key === key);
    if (p) viewer.setWL(p.center, p.width);
  }
  wlPresetSel.value = ""; // プリセットは一度きり適用（以後は手動調整を反映）。
});
// WW/WC 直接入力。
function applyWlInput(): void {
  if (!viewer || syncing) return;
  const ww = Number(wwInput.value);
  const wc = Number(wcInput.value);
  if (ww > 0 && Number.isFinite(wc)) viewer.setWL(wc, ww);
}
wlSetBtn.addEventListener("click", applyWlInput);
wwInput.addEventListener("keydown", (e) => e.key === "Enter" && applyWlInput());
wcInput.addEventListener("keydown", (e) => e.key === "Enter" && applyWlInput());
// PNG 保存。
pngBtn.addEventListener("click", () => {
  if (!viewer) return;
  const idx = viewer.imageIndex() + 1;
  viewer.savePng(`graphy-portable-${String(idx).padStart(3, "0")}.png`);
});
// スライス送り／シネ。
sliceSlider.addEventListener("input", () => {
  if (!viewer || syncing) return;
  stopCine();
  void viewer.setImageIndex(Number(sliceSlider.value));
});
playBtn.addEventListener("click", toggleCine);
fpsInput.addEventListener("change", () => {
  if (cineTimer !== null) {
    stopCine();
    toggleCine(); // 新しい fps で再開。
  }
});

/**
 * 自己検証モード（本番非影響。`?selfTest=<baseUrl>` 指定時のみ）。ネイティブのフォルダ選択ダイアログは
 * 自動化できないため、媒体ルート（VIEWER/ の親）から manifest.json と各ファイルを fetch して File[] を合成し、
 * 通常の handleFiles → parseDicomDir → 先頭シリーズ表示を通す。webkitdirectory の webkitRelativePath を
 * 模すため、File 名にルート接頭辞付き相対パスを持たせる（indexFiles が先頭セグメントを剥がす前提）。
 * 進捗は window.__selfTest に出す（ヘッドレスからのポーリング用）。
 */
async function runSelfTest(rawBase: string): Promise<void> {
  const base = rawBase === "1" ? "../" : rawBase.endsWith("/") ? rawBase : rawBase + "/";
  const w = window as unknown as { __selfTest: Record<string, unknown> };
  w.__selfTest = { status: "loading", base };
  try {
    const manifest: string[] = await (await fetch(base + "manifest.json")).json();
    const files: File[] = [];
    for (const rel of manifest) {
      const buf = await (await fetch(base + rel)).arrayBuffer();
      files.push(new File([buf], "media/" + rel)); // "media/" = 疑似ルートフォルダ名
    }
    await handleFiles(files);
    const first = model?.patients[0]?.studies[0]?.series[0];
    if (first) await showSeries(first);
    // P4.2 回帰: 肺野プリセット適用 → W/L が変わることを確認。
    let wlAfterPreset = "";
    if (viewer) {
      viewer.setWL(-600, 1500);
      const wl = viewer.getWL();
      wlAfterPreset = wl ? `W${wl.width}/L${wl.center}` : "";
    }
    w.__selfTest = {
      status: "ok",
      patients: model?.patients.length ?? 0,
      seriesImages: first?.images.length ?? 0,
      missingFiles: model?.missingFiles ?? -1,
      overlayTL: viewerEls.overlayTL.textContent ?? "",
      scalebar: viewerEls.scalebarLabel.textContent ?? "",
      total: viewer?.imageTotal() ?? 0,
      wlAfterPreset,
      cinebarVisible: !cinebar.hidden,
    };
    console.log("SELFTEST_RESULT " + JSON.stringify(w.__selfTest));
  } catch (e) {
    w.__selfTest = { status: "error", error: e instanceof Error ? e.message : String(e) };
    console.log("SELFTEST_RESULT " + JSON.stringify(w.__selfTest));
    setStatus(`selfTest 失敗: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

const selfTest = new URLSearchParams(location.search).get("selfTest");
if (selfTest) {
  void runSelfTest(selfTest);
} else {
  setStatus("「フォルダを選択」から Export の媒体（DICOMDIR を含むフォルダ）を選んでください。");
}
