/**
 * UVS の画面（設計 §画面）。
 *
 * <h3>作りの芯</h3>
 * - **走査（カラー / 静止）と予測は別のボタン**。走査は 1 秒、予測は 16 分——同じボタンにしない。
 * - **予測は区間に分けて呼ぶ**。進捗はここが持つ。中止＝次のチャンクを投げない。
 * - 🔴 **しきい値の再合成はここで完結する**（サーバへ往復しない）。往復すると「探る」操作にならない。
 * - 🚨 **押せる要素にはすべて `data-testid`**。v0.2.7 で「描画は出ているが押しても動かない」を
 *   緑のまま公開した反省（CLAUDE.md ルール 9）。
 */
import type { Viewer2DPluginHost } from "../../graphy-plugin";
import { createBars } from "./bars";
import { createChart } from "./chart";
import { createT } from "./i18n";
import { format, merge, parse, subtract, type Frame1 } from "./indices";
import { Ops, type PredictScore, type PrepareResult, type VideoInfo } from "./ops";
import { applyPredictionThreshold, compose, removalsFromScan, results, type Derived, type Results } from "./summaryComposer";

/** 1 チャンクのサンプル数。1 サンプル 2〜3 秒なので、10〜20 秒で 1 往復になる。 */
const CHUNK = 5;

interface DebugState {
  scan: { from: number; frames: number; cpr: number[]; mad: number[]; sampleIndices: number[] } | null;
  predict: { done: number; total: number; scores: PredictScore[]; anyPadded: boolean } | null;
  /**
   * 合成の**結果と入力の両方**。
   * 🔑 入力も載せるのは、実機検査で **Java の `op:"compose"` に同じものを渡して突き合わせる**ため
   *    （画面の答えが正本と一致することを、実データで示す）。
   */
  composed: {
    finalIndices: number[];
    heart: number[];
    results: Results;
    frameCount: number;
    interval: number;
    colorRemove: number[];
    staticRemove: number[];
    predScores: Record<string, number>;
  } | null;
  progress: number;
  backendCalls: number;
  threshold: number;
  madThreshold: number;
  info: VideoInfo | null;
  error: string | null;
}

export interface PanelHandle {
  dispose(): void;
}

export function mountPanel(
  root: HTMLElement,
  host: Viewer2DPluginHost,
  context: { apiBase: string; sopInstanceUid: string | null },
  onDispose?: () => void,
): PanelHandle {
  const doc = root.ownerDocument;
  const t = createT(host.locale);
  const ops = new Ops(host, context);

  // ── 状態 ────────────────────────────────────────────────────────
  let info: VideoInfo | null = null;
  let sessionId: string | null = null;
  let scan: PrepareResult | null = null;
  let scores: PredictScore[] = [];
  let predictTotal = 0;
  let cancelled = false;
  let running = false;
  let userAdd: Frame1[] = [];
  let userRemove: Frame1[] = [];
  let threshold = 0.75;
  let madThreshold = 0.19;
  let colorRatio = 0.0035;

  const debug: DebugState = {
    scan: null, predict: null, composed: null, progress: 0,
    backendCalls: 0, threshold, madThreshold, info: null, error: null,
  };
  const publishDebug = (): void => {
    debug.backendCalls = ops.calls;
    debug.threshold = threshold;
    debug.madThreshold = madThreshold;
    debug.info = info;
    (doc.defaultView as unknown as { __uvsDebug?: DebugState }).__uvsDebug = debug;
  };

  // ── 部品 ────────────────────────────────────────────────────────
  const panel = doc.createElement("div");
  panel.setAttribute("data-testid", "uvs-panel");
  panel.style.font = "12px/1.6 system-ui, sans-serif";
  panel.style.padding = "10px";
  panel.style.color = "#18181b";
  root.appendChild(panel);

  const h = (tag: string, style?: string, text?: string): HTMLElement => {
    const el = doc.createElement(tag);
    if (style) el.setAttribute("style", style);
    if (text != null) el.textContent = text;
    return el;
  };
  const section = (title: string): HTMLElement => {
    const box = h("div", "margin:8px 0;padding:8px;border:1px solid #e4e4e7;border-radius:4px");
    box.appendChild(h("div", "font-weight:600;margin-bottom:6px", title));
    panel.appendChild(box);
    return box;
  };
  const button = (testId: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.setAttribute("data-testid", testId);
    b.textContent = label;
    b.style.marginRight = "6px";
    b.addEventListener("click", onClick);
    return b;
  };
  const numberInput = (testId: string, value: number, step: number, onChange: (v: number) => void): HTMLInputElement => {
    const i = doc.createElement("input");
    i.setAttribute("data-testid", testId);
    i.type = "number";
    i.step = String(step);
    i.value = String(value);
    i.style.width = "90px";
    i.addEventListener("change", () => {
      const v = Number(i.value);
      if (Number.isFinite(v)) onChange(v);
    });
    return i;
  };
  const field = (box: HTMLElement, label: string, input: HTMLElement, note?: string): void => {
    const row = h("div", "display:flex;align-items:center;gap:8px;margin:3px 0");
    const l = h("div", "flex:1;color:#52525b", label);
    row.appendChild(l);
    row.appendChild(input);
    box.appendChild(row);
    if (note) box.appendChild(h("div", "font-size:11px;color:#b45309;margin:0 0 4px 0", note));
  };

  panel.appendChild(h("div", "font-weight:700;font-size:13px", t("title")));
  panel.appendChild(h("div", "font-size:11px;color:#71717a;margin-bottom:4px", t("research")));

  const sourceBox = section(t("source"));
  const sourceText = h("div", "font-size:11px;color:#3f3f46;white-space:pre-wrap");
  sourceBox.appendChild(sourceText);

  const settingsBox = section(t("settings"));
  const fromInput = numberInput("uvs-range-from", 0, 1, (v) => { rangeFrom = Math.max(0, Math.round(v)); });
  const countInput = numberInput("uvs-range-count", 0, 1, (v) => { rangeCount = Math.max(0, Math.round(v)); });
  const intervalInput = numberInput("uvs-interval-input", 15, 1, (v) => { interval = Math.max(1, Math.round(v)); });
  const strideInput = numberInput("uvs-stride-input", 6, 1, (v) => { stride = Math.max(1, Math.round(v)); });
  const colorRatioInput = numberInput("uvs-color-ratio-input", colorRatio, 0.0001, (v) => { colorRatio = v; recompose(); });
  const madInput = numberInput("uvs-mad-input", madThreshold, 0.01, (v) => { madThreshold = v; recompose(); });
  const probInput = numberInput("uvs-threshold-input", threshold, 0.01, (v) => { setThreshold(v); });
  let rangeFrom = 0;
  let rangeCount = 0;
  let interval = 15;
  let stride = 6;

  field(settingsBox, t("rangeFrom"), fromInput);
  field(settingsBox, t("rangeCount"), countInput);
  field(settingsBox, t("interval"), intervalInput);
  field(settingsBox, t("stride"), strideInput);
  field(settingsBox, t("colorRatio"), colorRatioInput);
  const madNote = h("div", "font-size:11px;color:#b45309");
  field(settingsBox, t("madThreshold"), madInput);
  settingsBox.appendChild(madNote);
  field(settingsBox, t("probThreshold"), probInput);
  const extractorText = h("div", "font-size:11px;color:#52525b");
  settingsBox.appendChild(extractorText);

  const runBox = section(t("run"));
  const runRow = h("div");
  runRow.appendChild(button("uvs-run-color", t("runColor"), () => void doScan({ color: true, static: false })));
  runRow.appendChild(button("uvs-run-static", t("runStatic"), () => void doScan({ color: false, static: true })));
  runRow.appendChild(button("uvs-run-both", t("runBoth"), () => void doScan({ color: true, static: true })));
  runRow.appendChild(button("uvs-run-predict", t("runPredict"), () => void doPredict()));
  const cancelBtn = button("uvs-cancel-predict", t("cancel"), () => { cancelled = true; });
  cancelBtn.disabled = true;
  runRow.appendChild(cancelBtn);
  runBox.appendChild(runRow);
  const statusText = h("div", "margin-top:6px;font-size:11px;color:#3f3f46");
  statusText.setAttribute("data-testid", "uvs-status");
  runBox.appendChild(statusText);

  const curveBox = section(t("curve"));
  const chart = createChart(curveBox, { onThreshold: (v) => setThreshold(v) });

  const barsBox = section(t("bars"));
  const bars = createBars(barsBox, {
    labels: {
      final: t("barFinal"), pred: t("barPred"), color: t("barColor"),
      static: t("barStatic"), manual: t("barManual"),
    },
    onToggle: (f) => toggleManual(f),
    onSeek: (f) => seekPreview(f),
  });

  const manualBox = section(t("manual"));
  const manualAddInput = doc.createElement("input");
  manualAddInput.setAttribute("data-testid", "uvs-manual-input");
  manualAddInput.type = "text";
  manualAddInput.placeholder = "1,5-8,12";
  manualAddInput.style.width = "160px";
  manualAddInput.addEventListener("change", () => {
    userAdd = parse(manualAddInput.value);
    recompose();
  });
  const manualRemoveInput = doc.createElement("input");
  manualRemoveInput.setAttribute("data-testid", "uvs-manual-remove-input");
  manualRemoveInput.type = "text";
  manualRemoveInput.placeholder = "20-30";
  manualRemoveInput.style.width = "160px";
  manualRemoveInput.addEventListener("change", () => {
    userRemove = parse(manualRemoveInput.value);
    recompose();
  });
  field(manualBox, t("manualAdd"), manualAddInput);
  field(manualBox, t("manualRemove"), manualRemoveInput);
  manualBox.appendChild(h("div", "font-size:11px;color:#71717a", t("manualHint")));

  const resultsBox = section(t("results"));
  const resultsText = h("div", "font-size:12px;white-space:pre-wrap");
  resultsText.setAttribute("data-testid", "uvs-results");
  resultsBox.appendChild(resultsText);
  // 🚨 **「ほぼ全滅」を黙って出さない。** 実データ（このサンプル）は既定のカラー比率で
  //    全フレームがカラー扱いになった。空の要約を涼しい顔で見せるのがいちばん悪い。
  const warnText = h("div", "font-size:11px;color:#b91c1c;white-space:pre-wrap;margin-top:4px");
  warnText.setAttribute("data-testid", "uvs-warning");
  resultsBox.appendChild(warnText);
  resultsBox.appendChild(h("div", "font-size:11px;color:#b45309;margin-top:4px", t("overlapNote")));
  const publishBtn = button("uvs-publish-report", t("publish"), () => void doPublish());
  resultsBox.appendChild(publishBtn);
  const publishText = h("div", "font-size:11px;color:#3f3f46;margin-top:4px");
  publishText.setAttribute("data-testid", "uvs-publish-status");
  resultsBox.appendChild(publishText);

  const previewBox = section(t("preview"));
  const video = doc.createElement("video");
  video.setAttribute("data-testid", "uvs-preview");
  video.controls = true;
  video.style.width = "100%";
  video.style.maxHeight = "220px";
  video.style.background = "#000";
  previewBox.appendChild(video);
  previewBox.appendChild(h("div", "font-size:11px;color:#71717a", t("previewHint")));

  const errorText = h("div", "color:#b91c1c;font-size:11px;white-space:pre-wrap");
  errorText.setAttribute("data-testid", "uvs-error");
  panel.appendChild(errorText);

  // ── 合成（🔴 ここはサーバへ往復しない）──────────────────────────
  let derived: Derived | null = null;

  function currentHeart(): { heart: Frame1[]; interpolated: number[] } | null {
    if (!scan || scores.length === 0) return null;
    // 🔴 **穴あきのまま合成しない。** Java 側は値の並び順しか見ないので、失敗したチャンクを
    //    詰めると以降がまるごと 1 サンプルぶんずれる（それらしい形のまま）。
    const dense = scores.slice().sort((a, b) => a.frameIndex - b.frameIndex).map((s) => s.probability);
    if (dense.length !== predictTotal || dense.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
      return null;
    }
    return applyPredictionThreshold(dense as number[], scan.frames, scan.interval, threshold);
  }

  function recompose(): void {
    if (!scan) {
      statusText.textContent = t("needScan");
      return;
    }
    const { colorRemove, staticRemove } = removalsFromScan(
      scan.from, scan.cpr, scan.mad, colorRatio, madThreshold,
    );
    const heart = currentHeart();
    const incomplete = scores.length > 0 && heart === null;
    derived = compose({
      frameCount: scan.frames,
      colorRemove,
      staticRemove,
      heart: heart ? heart.heart : scores.length === 0 ? null : null,
      userAdd,
      userRemove,
    });
    const res = results(scan.frames, derived, userAdd, userRemove);

    bars.setFrameCount(scan.frames);
    bars.set("final", derived.finalIndices);
    bars.set("pred", heart ? heart.heart : []);
    bars.set("color", colorRemove);
    bars.set("static", staticRemove);
    bars.set("manual", merge(userAdd, userRemove));
    chart.setCurve(heart?.interpolated ?? []);
    chart.setThreshold(threshold);

    resultsText.textContent =
      `${t("total")}: ${res.numberOfFrames}\n` +
      `${t("kept")}: ${derived.finalIndices.length}\n` +
      `${t("removed")}: ${res.totalRemoved} (${(res.totalRate * 100).toFixed(1)}%)\n` +
      `  ${t("byColor")}: ${res.colorRemoved}\n` +
      `  ${t("byStatic")}: ${res.staticRemoved}\n` +
      `  ${t("byProb")}: ${res.probaRemoved}\n` +
      `  ${t("byUser")}: ${res.userRemoved} / +${res.userAdded}`;
    if (incomplete) statusText.textContent = t("incomplete");

    const warns: string[] = [];
    const nearlyAll = Math.floor(scan.frames * 0.95);
    if (colorRemove.length >= nearlyAll && colorRemove.length > 0) {
      warns.push(t("warnAllColor", { n: colorRemove.length, total: scan.frames }));
    }
    if (staticRemove.length >= nearlyAll && staticRemove.length > 0) {
      warns.push(t("warnAllStatic", { n: staticRemove.length, total: scan.frames }));
    }
    if (derived.finalIndices.length === 0) warns.push(t("warnEmpty"));
    warnText.textContent = warns.join("\n");

    const predScores: Record<string, number> = {};
    for (const sc of scores) {
      if (typeof sc.probability === "number") predScores[String(sc.frameIndex + 1)] = sc.probability;
    }
    debug.composed = {
      finalIndices: derived.finalIndices as number[],
      heart: derived.heart as number[],
      results: res,
      frameCount: scan.frames,
      interval: scan.interval,
      colorRemove: colorRemove as number[],
      staticRemove: staticRemove as number[],
      predScores,
    };
    publishDebug();
  }

  function setThreshold(v: number): void {
    threshold = Math.min(1, Math.max(0, v));
    probInput.value = threshold.toFixed(4);
    chart.setThreshold(threshold);
    recompose(); // 🔴 サーバへ往復しない
  }

  function toggleManual(f: Frame1): void {
    if (!derived) return;
    const kept = new Set<number>(derived.finalIndices);
    if (kept.has(f)) {
      userAdd = subtract(userAdd, [f]);
      userRemove = merge(userRemove, [f]);
    } else {
      userRemove = subtract(userRemove, [f]);
      userAdd = merge(userAdd, [f]);
    }
    manualAddInput.value = format(userAdd);
    manualRemoveInput.value = format(userRemove);
    recompose();
  }

  function seekPreview(f: Frame1): void {
    if (!info || !info.fps) return;
    // フレーム番号は 1-based。動画の時間は 0 起点なので (f-1)/fps。
    video.currentTime = (f - 1) / info.fps;
  }

  // ── 実行 ────────────────────────────────────────────────────────
  const fail = (e: unknown): void => {
    const msg = String((e as { message?: string })?.message ?? e);
    errorText.textContent = `${t("error")}: ${msg}`;
    debug.error = msg;
    publishDebug();
  };

  async function ensureSession(): Promise<VideoInfo> {
    if (info && sessionId) return info;
    const got = await ops.info();
    info = got;
    sessionId = got.sessionId;
    interval = got.defaults.interval;
    stride = got.defaults.stride;
    madThreshold = got.defaults.staticMeanAbsDiffThreshold;
    colorRatio = got.defaults.colorPixelRatioThreshold;
    threshold = got.defaults.predictionThreshold;
    intervalInput.value = String(interval);
    strideInput.value = String(stride);
    madInput.value = String(madThreshold);
    colorRatioInput.value = String(colorRatio);
    probInput.value = String(threshold);
    chart.setThreshold(threshold);
    // 🚨 「0.19 は圧縮動画向け」と画面に書く。数字だけ見せると AVI の 0.5 と比較されて混乱する。
    madNote.textContent = t("madCompressed", { avi: got.defaults.aviEquivalentMeanAbsDiff });
    extractorText.textContent = `${t("extractor")}: ${got.defaults.extractor} — ${t("extractorFixed")}`;
    sourceText.textContent =
      `${got.numberOfFrames} ${t("frames")} / ${got.fps.toFixed(2)} ${t("fps")}` +
      ` / ${got.width}×${got.height}\n` +
      `${t("transferSyntax")}: ${got.transferSyntaxUid ?? "-"}\n` +
      `${t("transcode")}: ${got.transcodeRequired ? t("needed") : t("notNeeded")}`;
    if (context.sopInstanceUid) {
      video.src = `${context.apiBase}/api/instances/${encodeURIComponent(context.sopInstanceUid)}/rendered`;
    }
    publishDebug();
    return got;
  }

  async function doScan(which: { color: boolean; static: boolean }): Promise<void> {
    if (running) return;
    running = true;
    errorText.textContent = "";
    statusText.textContent = t("scanning");
    try {
      const meta = await ensureSession();
      // 🔑 「カラーだけ」「静止だけ」でも走査は 1 パス（どちらも同じ列から出る）。
      //    片方だけ押したときは、使わない列を捨てるのではなく**表示から外す**。
      const res = await ops.prepare({
        sessionId: meta.sessionId,
        from: rangeFrom,
        count: rangeCount,
        interval,
        stride,
        cacheForPredict: true,
      });
      scan = res;
      if (!which.color) scan = { ...res, cpr: res.cpr.map(() => 0) };
      if (!which.static) scan = { ...scan, mad: scan.mad.map(() => Number.POSITIVE_INFINITY) };
      predictTotal = res.sampleIndices.length;
      scores = [];
      debug.scan = {
        from: res.from, frames: res.frames, cpr: res.cpr, mad: res.mad,
        sampleIndices: res.sampleIndices,
      };
      debug.predict = null;
      statusText.textContent = t("cacheUsage", { mb: Math.round(res.cacheBytes / 1024 / 1024) });
      recompose();
    } catch (e) {
      fail(e);
    } finally {
      running = false;
    }
  }

  async function doPredict(): Promise<void> {
    if (running) return;
    if (!scan || !sessionId) {
      statusText.textContent = t("needScan");
      return;
    }
    running = true;
    cancelled = false;
    cancelBtn.disabled = false;
    errorText.textContent = "";
    scores = [];
    try {
      let from = 0;
      const total = predictTotal;
      let msPerSample = 2500;
      while (from < total) {
        // 🔑 **中止は「次を投げない」だけ。** 止める仕掛けを別に作らない。
        if (cancelled) {
          statusText.textContent = t("cancelled");
          break;
        }
        const t0 = Date.now();
        const res = await ops.predict({ sessionId, sampleFrom: from, sampleCount: CHUNK });
        const n = res.scores.length || 1;
        msPerSample = (Date.now() - t0) / n;
        scores = scores.concat(res.scores);
        from = res.nextFrom;
        debug.predict = { done: scores.length, total, scores, anyPadded: res.anyPadded };
        debug.progress = total > 0 ? scores.length / total : 0;
        const left = Math.max(0, total - scores.length);
        statusText.textContent = t("predicting", {
          done: scores.length, total,
          min: Math.max(1, Math.round((left * msPerSample) / 60000)),
        });
        publishDebug();
        recompose();
        if (res.done) break;
      }
    } catch (e) {
      fail(e);
    } finally {
      running = false;
      cancelBtn.disabled = true;
      recompose();
    }
  }

  async function doPublish(): Promise<void> {
    if (!scan || !derived || !info) {
      publishText.textContent = t("needScan");
      return;
    }
    try {
      const res = results(scan.frames, derived, userAdd, userRemove);
      // ⚠️ **丸めは渡す側の責任**（表示と保存でずれないように）。数値は文字列にして渡す。
      const num = (v: number, digits = 0): string => v.toFixed(digits);
      const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
      const out = host.publishAnalysisResult?.(undefined, {
        id: `uvs-${scan.from}-${scan.frames}`,
        kind: "plugin",
        title: t("title"),
        frameLabel: `${scan.from}–${scan.from + scan.frames - 1}`,
        sopInstanceUids: context.sopInstanceUid ? [context.sopInstanceUid] : [],
        metrics: [
          { label: t("total"), value: num(res.numberOfFrames) },
          { label: t("kept"), value: num(derived.finalIndices.length) },
          { label: t("removed"), value: `${num(res.totalRemoved)} (${pct(res.totalRate)})` },
          { label: t("byColor"), value: num(res.colorRemoved) },
          { label: t("byStatic"), value: num(res.staticRemoved) },
          { label: t("byProb"), value: num(res.probaRemoved) },
          { label: t("byUser"), value: num(res.userRemoved) },
          { label: t("probThreshold"), value: num(threshold, 4) },
          { label: t("madThreshold"), value: num(madThreshold, 3) },
          { label: t("interval"), value: num(scan.interval) },
          { label: t("rangeFrom"), value: num(scan.from) },
          { label: t("rangeCount"), value: num(scan.frames) },
        ],
        provenance: [
          { label: "model", value: "uvs-lr-20250611" },
          { label: "extractor", value: info.defaults.extractor },
          { label: "samplingPoints", value: String(info.defaults.samplingPoints) },
          { label: "randomSeed", value: String(info.defaults.randomSeed) },
          { label: "ffmpeg", value: info.ffmpeg },
          { label: "transferSyntaxUid", value: info.transferSyntaxUid ?? "" },
        ],
        caveats: [
          t("research"),
          // 🔴 caveats は空だと拒否される。**この解析に固有の限界**を書くのはプラグインだけ。
          t("madCompressed", { avi: info.defaults.aviEquivalentMeanAbsDiff }),
          t("overlapNote"),
          `解析した区間: ${scan.from} 〜 ${scan.from + scan.frames - 1}（動画全体ではない場合がある）`,
          "要約シリーズ（動画）は書き出していない。採用フレームの一覧のみ。",
        ],
      });
      publishText.textContent = out && out.ok === false
        ? t("publishFailed", { error: out.error ?? "" })
        : t("published");
    } catch (e) {
      publishText.textContent = t("publishFailed", { error: String((e as { message?: string })?.message ?? e) });
    }
  }

  // 開いた時点で諸元だけ取りに行く（重い処理は押されるまでしない）。
  void ensureSession().catch(fail);
  publishDebug();

  return {
    dispose() {
      chart.dispose();
      bars.dispose();
      panel.remove();
      // 🔴 窓を閉じたら一時ファイルを返す（3 経路のうちの 1 つ）。
      if (sessionId) void ops.release(sessionId).catch(() => undefined);
      onDispose?.();
    },
  };
}
