/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * フーリエ解析ダイアログ（2D Viewer > 解析 > フーリエ解析、fw/fourier-design.md）。
 *
 * <p>対象タイルで**いま表示しているスライス 1 枚だけ**を 2D-DFT する（スタックで束ねない）。
 * RGB は 8bit グレースケールにしてから処理する。スペクトル（|Re|・|Im|・|F|）の表示と
 * 四象限入れ替え、2D-iDFT、周波数フィルタ（長方形・円形・ドーナツ、縁のガウシアン σ）と
 * その適用後プレビュー、座標ごとの基底関数の表示、32-bit TIFF 書き出しを持つ。
 * 新規シリーズとしては保存しない。計算は `fourierWorker.ts` で行う。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { ViewerTilePixelData } from "../viewer/viewerCommands";
import { readImageInfo } from "../viewer/imageInfo";
import {
  MAX_FFT_SIZE,
  complexExportSlices,
  complexStackInfo,
  imageJComplexProperties,
  fftshift,
  isMaskActive,
  logScale,
  multiplyMask,
  nextPow2,
  rectCenterLimit,
  toGray8,
  type FilterMode,
  type FilterSpec,
} from "../viewer/fourier";
import type { FourierWorkerRequest, FourierWorkerResponse } from "../viewer/fourierProtocol";
import { encodeFloat32Tiff, encodeFloat32TiffStack } from "../viewer/tiffFloat32";
import { downloadBytes } from "../viewer/xaFrameExport";

const SIDE = 300;
const SPEC = 420;
const BASIS = 260;

type SpecView = "real" | "imag" | "mag";
type FilterKind = FilterSpec["kind"];
/** 判別共用体のまま requestId だけを外す（素の Omit は共用体を潰す）。 */
type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never;
type DragMode = null | "rect" | "rectMirror" | "radius" | "donutRadius" | "donutWidth" | "click";

interface Source {
  values: Float32Array;
  width: number;
  height: number;
  sliceIndex: number;
  isRgb: boolean;
  unit: string;
}
interface Spectrum {
  n: number;
  offX: number;
  offY: number;
  /** シフト後・符号付き。 */
  real: Float32Array;
  imag: Float32Array;
  /** 表示と絶対値の書き出し用（シフト後）。 */
  realAbs: Float32Array;
  imagAbs: Float32Array;
  magnitude: Float32Array;
}
interface Inverse {
  real: Float32Array;
  magnitude: Float32Array;
  mask: Float32Array;
  /** マスクが実際に何かを落としているか（「なし」や全通過なら false）。 */
  filtered: boolean;
  maxImag: number;
}
interface Basis {
  u: number;
  v: number;
  image: Float32Array;
  coeffRe: number;
  coeffIm: number;
}

export function FourierDialog({
  seriesLabel,
  loadPixels,
  onClose,
}: {
  seriesLabel: string;
  loadPixels: () => Promise<ViewerTilePixelData | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [source, setSource] = useState<Source | null>(null);
  const [spectrum, setSpectrum] = useState<Spectrum | null>(null);
  const [inverse, setInverse] = useState<Inverse | null>(null);
  const [basis, setBasis] = useState<Basis | null>(null);
  const [status, setStatus] = useState<string | null>(t("fourier.loading"));

  const [view, setView] = useState<SpecView>("mag");
  const [logDisplay, setLogDisplay] = useState(true);
  const [swapped, setSwapped] = useState(true);
  const [resultView, setResultView] = useState<"real" | "magnitude">("real");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [runTick, setRunTick] = useState(0);
  const [tab, setTab] = useState<"filter" | "basis">("filter");

  const [filterKind, setFilterKind] = useState<FilterKind>("none");
  const [rectOrientation, setRectOrientation] = useState<"vertical" | "horizontal">("vertical");
  const [rectCenter, setRectCenter] = useState(20);
  const [rectWidth, setRectWidth] = useState(4);
  const [mirror, setMirror] = useState(true);
  const [circleRadius, setCircleRadius] = useState(30);
  const [circleMode, setCircleMode] = useState<FilterMode>("pass");
  const [donutRadius, setDonutRadius] = useState(40);
  const [donutWidth, setDonutWidth] = useState(16);
  const [donutMode, setDonutMode] = useState<FilterMode>("pass");
  const [sigma, setSigma] = useState(0);

  const [u, setU] = useState(0);
  const [v, setV] = useState(0);
  const [weighted, setWeighted] = useState(false);

  const n = spectrum?.n ?? 0;
  const h = n >> 1;
  // 長方形の帯がスペクトルからはみ出さない位置の上限（幅を変えたときも収め直す）。
  const rectLimit = n ? rectCenterLimit(n, rectWidth) : 0;
  const setRectCenterClamped = useCallback((c: number) => setRectCenter(clamp(Math.round(c), -rectLimit, rectLimit)), [rectLimit]);
  useEffect(() => {
    if (n && Math.abs(rectCenter) > rectLimit) setRectCenter(clamp(rectCenter, -rectLimit, rectLimit));
  }, [n, rectCenter, rectLimit]);

  // ── Worker ──────────────────────────────────────────────────────
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(1);
  const latest = useRef<Record<string, number>>({});

  const post = useCallback((req: WithoutId<FourierWorkerRequest>, transfer: Transferable[] = []) => {
    const w = workerRef.current;
    if (!w) return;
    const requestId = nextId.current++;
    latest.current[req.type] = requestId;
    w.postMessage({ ...req, requestId } as FourierWorkerRequest, transfer);
  }, []);

  useEffect(() => {
    const w = new Worker(new URL("../viewer/fourierWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (ev: MessageEvent<FourierWorkerResponse>) => {
      const res = ev.data;
      if (res.type === "error") {
        setStatus(res.message);
        return;
      }
      const kind = res.type === "transformDone" ? "transform" : res.type === "inverseDone" ? "inverse" : "basis";
      // 古い応答（スライダーを動かしている間に追い越されたもの）は捨てる。
      if (latest.current[kind] !== res.requestId) return;
      if (res.type === "transformDone") {
        setSpectrum({
          n: res.n,
          offX: res.offX,
          offY: res.offY,
          real: res.real,
          imag: res.imag,
          realAbs: res.real.map(Math.abs),
          imagAbs: res.imag.map(Math.abs),
          magnitude: res.magnitude,
        });
        const half = res.n >> 1;
        // 初期表示は DC（スペクトルの中央）。十字線が中央に来る。
        setU(half);
        setV(half);
        setStatus(null);
      } else if (res.type === "inverseDone") {
        setInverse({ real: res.real, magnitude: res.magnitude, mask: res.mask, filtered: isMaskActive(res.mask), maxImag: res.maxImag });
      } else {
        setBasis({ u: res.u, v: res.v, image: res.image, coeffRe: res.coeffRe, coeffIm: res.coeffIm });
      }
    };
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  // ── 入力（表示中スライス）──────────────────────────────────────
  const fetchSource = useCallback(async () => {
    setStatus(t("fourier.loading"));
    setSpectrum(null);
    setInverse(null);
    setBasis(null);
    const px = await loadPixels();
    if (!px) {
      setSource(null);
      setStatus(t("fourier.noImage"));
      return;
    }
    const pi = readImageInfo(px.imageId).photometricInterpretation?.toUpperCase() ?? "";
    const isRgb = px.unit === "raw" || pi.startsWith("RGB") || pi.startsWith("YBR") || pi === "PALETTE COLOR";
    const values = isRgb ? toGray8(px.data) : new Float32Array(px.data);
    const size = nextPow2(Math.max(px.cols, px.rows));
    setSource({ values, width: px.cols, height: px.rows, sliceIndex: px.sliceIndex, isRgb, unit: px.unit });
    if (size > MAX_FFT_SIZE) {
      setStatus(t("fourier.tooLarge", { n: size, max: MAX_FFT_SIZE }));
      return;
    }
    setStatus(t("fourier.computing"));
    // Worker へはコピーを transfer する（表示用の values は手元に残す）。
    const copy = values.slice();
    post({ type: "transform", values: copy, width: px.cols, height: px.rows }, [copy.buffer]);
  }, [loadPixels, post, t]);

  useEffect(() => {
    void fetchSource();
    // 開いた時に 1 回だけ。以降は「再取得」ボタン。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── フィルタ → 逆変換 ──────────────────────────────────────────
  const filter = useMemo<FilterSpec>(() => {
    switch (filterKind) {
      case "rect":
        return { kind: "rect", orientation: rectOrientation, center: rectCenter, width: rectWidth, mirror };
      case "circle":
        return { kind: "circle", radius: circleRadius, mode: circleMode };
      case "donut":
        return { kind: "donut", radius: donutRadius, width: donutWidth, mode: donutMode };
      default:
        return { kind: "none" };
    }
  }, [filterKind, rectOrientation, rectCenter, rectWidth, mirror, circleRadius, circleMode, donutRadius, donutWidth, donutMode]);

  const lastRun = useRef({ tick: -1, spectrum: null as Spectrum | null });
  useEffect(() => {
    if (!spectrum) return;
    const fresh = lastRun.current.spectrum !== spectrum || lastRun.current.tick !== runTick;
    if (!autoUpdate && !fresh) return;
    const id = window.setTimeout(() => {
      lastRun.current = { tick: runTick, spectrum };
      post({ type: "inverse", filter, sigma: Math.max(0, sigma) });
    }, 50);
    return () => window.clearTimeout(id);
  }, [spectrum, filter, sigma, autoUpdate, runTick, post]);

  // ── 基底 ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!spectrum) return;
    const id = window.setTimeout(() => post({ type: "basis", u, v, weighted }), 30);
    return () => window.clearTimeout(id);
  }, [spectrum, u, v, weighted, post]);

  // ── 表示データ ─────────────────────────────────────────────────
  const specDisplay = useMemo(() => {
    if (!spectrum) return null;
    const raw = view === "real" ? spectrum.realAbs : view === "imag" ? spectrum.imagAbs : spectrum.magnitude;
    const shown = logDisplay ? logScale(raw) : raw;
    return swapped ? shown : fftshift(shown, spectrum.n);
  }, [spectrum, view, logDisplay, swapped]);

  const maskDisplay = useMemo(() => {
    if (!inverse || !spectrum || filterKind === "none") return null;
    return swapped ? inverse.mask : fftshift(inverse.mask, spectrum.n);
  }, [inverse, spectrum, swapped, filterKind]);

  // ── スペクトル上の操作 ─────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<DragMode>(null);

  const toFreq = (e: React.PointerEvent): { sx: number; sy: number; fx: number; fy: number } | null => {
    const svg = svgRef.current;
    if (!svg || !n) return null;
    const r = svg.getBoundingClientRect();
    const px = clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, n - 1);
    const py = clamp(Math.floor(((e.clientY - r.top) / r.height) * n), 0, n - 1);
    const sx = swapped ? px : (px + h) % n;
    const sy = swapped ? py : (py + h) % n;
    return { sx, sy, fx: sx - h, fy: sy - h };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toFreq(e);
    if (!p) return;
    const tol = Math.max(1.5, (n / SPEC) * 6);
    drag.current = "click";
    if (swapped && filterKind === "rect") {
      const pos = rectOrientation === "vertical" ? p.fx : p.fy;
      if (Math.abs(pos - rectCenter) <= rectWidth / 2 + tol) drag.current = "rect";
      else if (mirror && Math.abs(pos + rectCenter) <= rectWidth / 2 + tol) drag.current = "rectMirror";
    } else if (swapped && filterKind === "circle") {
      if (Math.abs(Math.hypot(p.fx, p.fy) - circleRadius) <= tol) drag.current = "radius";
    } else if (swapped && filterKind === "donut") {
      const d = Math.abs(Math.hypot(p.fx, p.fy) - donutRadius);
      if (Math.abs(d - donutWidth / 2) <= tol) drag.current = "donutWidth";
      else if (d < donutWidth / 2) drag.current = "donutRadius";
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const mode = drag.current;
    if (!mode || mode === "click") return;
    const p = toFreq(e);
    if (!p) return;
    const pos = rectOrientation === "vertical" ? p.fx : p.fy;
    const r = Math.hypot(p.fx, p.fy);
    if (mode === "rect") setRectCenterClamped(pos);
    else if (mode === "rectMirror") setRectCenterClamped(-pos);
    else if (mode === "radius") setCircleRadius(round1(clamp(r, 0, h * Math.SQRT2)));
    else if (mode === "donutRadius") setDonutRadius(round1(clamp(r, 0, h * Math.SQRT2)));
    else if (mode === "donutWidth") setDonutWidth(round1(clamp(2 * Math.abs(r - donutRadius), 1, n)));
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current === "click") {
      const p = toFreq(e);
      if (p) {
        setU(p.sx);
        setV(p.sy);
      }
    }
    drag.current = null;
  };

  // ── 書き出し ───────────────────────────────────────────────────
  const baseName = useMemo(() => {
    const s = (seriesLabel || "series").replace(/[^\w.-]+/g, "_").slice(0, 60);
    return `${s}_s${(source?.sliceIndex ?? 0) + 1}`;
  }, [seriesLabel, source]);

  const exportTiff = (values: Float32Array, w: number, hh: number, suffix: string) => {
    downloadBytes(encodeFloat32Tiff(values, w, hh), `${baseName}_${suffix}.tif`, "image/tiff");
  };
  // 書き出しは「いま表示している解析状態」を反映する。逆変換画像と同じマスク（最後に計算した
  // inverse のもの）を使うので、自動更新 OFF で未実行の設定変更は、プレビュー同様まだ反映しない。
  const appliedMask = inverse?.filtered && spectrum && inverse.mask.length === spectrum.n * spectrum.n ? inverse.mask : null;
  const filteredSuffix = appliedMask ? "_filtered" : "";

  const exportSpectrum = (which: "real" | "imag") => {
    if (!spectrum) return;
    const raw = which === "real" ? spectrum.realAbs : spectrum.imagAbs;
    const masked = appliedMask ? multiplyMask(raw, appliedMask) : raw;
    const data = swapped ? masked : fftshift(masked, spectrum.n);
    exportTiff(data, spectrum.n, spectrum.n, `${which === "real" ? "re_abs" : "im_abs"}${filteredSuffix}${swapped ? "_shifted" : ""}`);
  };

  /**
   * 符号付きの Re・Im を 2 スライスの 32-bit TIFF で保存する。**ImageJ の「Complex Fourier Transform」と
   * 同じ形**（四象限入れ替え済み・スライスラベル Real / Imaginary・プロパティ Original width/height）にするので、
   * ImageJ で開いて Process > FFT > Inverse FFT で元の大きさの画像に戻せる。ImageJ は入れ替え済みを前提に
   * 逆変換するため、画面の入れ替えトグルに関係なく常に入れ替え後で保存する。
   */
  const exportComplexStack = () => {
    if (!spectrum || !source) return;
    const { n: size } = spectrum;
    const slices = complexExportSlices(spectrum.real, spectrum.imag, size, appliedMask, true);
    const bytes = encodeFloat32TiffStack(slices, size, size, {
      labels: ["Real", "Imaginary"],
      properties: imageJComplexProperties(source.width, source.height),
      info: complexStackInfo({
        seriesLabel,
        sliceIndex: source.sliceIndex,
        n: size,
        width: source.width,
        height: source.height,
        filtered: !!appliedMask,
      }),
    });
    downloadBytes(bytes, `${baseName}_complex${filteredSuffix}.tif`, "image/tiff");
  };

  // ── 描画 ───────────────────────────────────────────────────────
  const basisIndex = v * n + u;
  // 重み付けの基底はフィルタ後の係数 F·m(u,v) で見せる（全座標の和＝逆変換画像になる）。
  const basisGain = basis && weighted && appliedMask ? appliedMask[basis.v * n + basis.u] : 1;
  const basisImage = useMemo(() => {
    if (!basis) return null;
    if (basisGain === 1) return basis.image;
    const out = new Float32Array(basis.image.length);
    for (let i = 0; i < out.length; i++) out[i] = basis.image[i] * basisGain;
    return out;
  }, [basis, basisGain]);
  const coeffMag = basis ? Math.hypot(basis.coeffRe, basis.coeffIm) * (weighted ? basisGain : 1) : 0;
  const coeffPhase = basis ? Math.atan2(basis.coeffIm, basis.coeffRe) : 0;
  const crossX = swapped ? u : (u + h) % Math.max(1, n);
  const crossY = swapped ? v : (v + h) % Math.max(1, n);

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()} data-testid="fourier-dialog">
        <div style={header}>
          <span>{t("fourier.title")}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "#8a98a6", fontWeight: 400 }}>
            {seriesLabel}
            {source &&
              ` — ${t("fourier.sourceInfo", {
                slice: source.sliceIndex + 1,
                w: source.width,
                h: source.height,
                n: nextPow2(Math.max(source.width, source.height)),
              })}`}
            {source?.isRgb && ` — ${t("fourier.rgbNote")}`}
          </span>
          <button style={{ ...chip, marginLeft: 10 }} onClick={() => void fetchSource()} data-testid="fourier-refetch">
            {t("fourier.refetch")}
          </button>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          {/* 原画像 */}
          <div style={column}>
            <div style={colTitle}>{t("fourier.source")}</div>
            <FloatCanvas values={source?.values ?? null} width={source?.width ?? 0} height={source?.height ?? 0} size={SIDE} testId="fourier-source" />
          </div>

          {/* スペクトル */}
          <div style={column}>
            <div style={{ ...colTitle, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t("fourier.spectrum")}</span>
              {(["real", "imag", "mag"] as SpecView[]).map((k) => (
                <button key={k} style={view === k ? chipOn : chip} onClick={() => setView(k)} data-testid={`fourier-view-${k}`}>
                  {t(`fourier.view.${k}`)}
                </button>
              ))}
            </div>
            <div style={{ position: "relative", width: SPEC + 2, height: SPEC + 2 }}>
              <FloatCanvas values={specDisplay} width={n} height={n} size={SPEC} testId="fourier-spectrum" />
              <MaskTint mask={maskDisplay} n={n} size={SPEC} />
              <svg
                ref={svgRef}
                width={SPEC}
                height={SPEC}
                viewBox={`0 0 ${Math.max(1, n)} ${Math.max(1, n)}`}
                style={{ position: "absolute", left: 1, top: 1, cursor: "crosshair", touchAction: "none" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                data-testid="fourier-spectrum-overlay"
              >
                {n > 0 && swapped && (
                  <FilterOutline
                    n={n}
                    kind={filterKind}
                    orientation={rectOrientation}
                    center={rectCenter}
                    width={rectWidth}
                    mirror={mirror}
                    circleRadius={circleRadius}
                    donutRadius={donutRadius}
                    donutWidth={donutWidth}
                  />
                )}
                {n > 0 && (
                  <g stroke="#ffb020" strokeWidth={(n / SPEC) * 1.2} vectorEffect="non-scaling-stroke">
                    <line x1={crossX + 0.5} y1={0} x2={crossX + 0.5} y2={n} strokeOpacity={0.45} />
                    <line x1={0} y1={crossY + 0.5} x2={n} y2={crossY + 0.5} strokeOpacity={0.45} />
                    <rect x={crossX} y={crossY} width={1} height={1} fill="none" />
                  </g>
                )}
              </svg>
            </div>
            <div style={row}>
              <label style={checkLabel}>
                <input type="checkbox" checked={logDisplay} onChange={(e) => setLogDisplay(e.target.checked)} data-testid="fourier-log" />
                {t("fourier.log")}
              </label>
              <label style={checkLabel}>
                <input type="checkbox" checked={swapped} onChange={(e) => setSwapped(e.target.checked)} data-testid="fourier-swap" />
                {t("fourier.swap")}
              </label>
            </div>
            <div style={hint}>{swapped ? t("fourier.dragHint") : t("fourier.swapOffHint")}</div>
          </div>

          {/* 逆変換 */}
          <div style={column}>
            <div style={{ ...colTitle, display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t("fourier.result")}</span>
              {(["real", "magnitude"] as const).map((k) => (
                <button key={k} style={resultView === k ? chipOn : chip} onClick={() => setResultView(k)} data-testid={`fourier-result-${k}`}>
                  {t(`fourier.result.${k}`)}
                </button>
              ))}
            </div>
            <FloatCanvas
              values={inverse ? (resultView === "real" ? inverse.real : inverse.magnitude) : null}
              width={source?.width ?? 0}
              height={source?.height ?? 0}
              size={SIDE}
              testId="fourier-result"
            />
            <div style={row}>
              <label style={checkLabel}>
                <input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} data-testid="fourier-auto" />
                {t("fourier.autoUpdate")}
              </label>
              <button style={btnPrimary} disabled={!spectrum} onClick={() => setRunTick((x) => x + 1)} data-testid="fourier-run-idft">
                {t("fourier.runIdft")}
              </button>
            </div>
            {inverse && <div style={hint}>{t("fourier.maxImag", { v: fmt(inverse.maxImag) })}</div>}
            {status && <div style={{ ...hint, color: "#e0b050" }}>{status}</div>}
          </div>
        </div>

        {/* 下段: フィルタ / 基底 */}
        <div style={{ display: "flex", gap: 6 }}>
          <button style={tab === "filter" ? chipOn : chip} onClick={() => setTab("filter")} data-testid="fourier-tab-filter">
            {t("fourier.tab.filter")}
          </button>
          <button style={tab === "basis" ? chipOn : chip} onClick={() => setTab("basis")} data-testid="fourier-tab-basis">
            {t("fourier.tab.basis")}
          </button>
        </div>

        {tab === "filter" ? (
          <div style={box}>
            <div style={row}>
              {(["none", "rect", "circle", "donut"] as FilterKind[]).map((k) => (
                <button key={k} style={filterKind === k ? chipOn : chip} onClick={() => setFilterKind(k)} data-testid={`fourier-filter-${k}`}>
                  {t(`fourier.filter.${k}`)}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              <NumField label={t("fourier.sigma")} value={sigma} min={0} max={Math.max(1, h)} step={0.5} onChange={setSigma} testId="fourier-sigma" />
            </div>
            {filterKind === "rect" && (
              <div style={row}>
                {(["vertical", "horizontal"] as const).map((k) => (
                  <button key={k} style={rectOrientation === k ? chipOn : chip} onClick={() => setRectOrientation(k)} data-testid={`fourier-rect-${k}`}>
                    {t(`fourier.rect.${k}`)}
                  </button>
                ))}
                <SliderField label={t("fourier.rect.position")} value={rectCenter} min={-rectLimit} max={rectLimit} step={1} onChange={setRectCenterClamped} testId="fourier-rect-position" />
                <SliderField label={t("fourier.rect.width")} value={rectWidth} min={1} max={Math.max(1, h)} step={1} onChange={setRectWidth} testId="fourier-rect-width" />
                <label style={checkLabel}>
                  <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} data-testid="fourier-rect-mirror" />
                  {t("fourier.rect.mirror")}
                </label>
                <span style={hint}>{t("fourier.rect.stopOnly")}</span>
              </div>
            )}
            {filterKind === "circle" && (
              <div style={row}>
                <ModeButtons mode={circleMode} onChange={setCircleMode} testId="fourier-circle-mode" />
                <SliderField label={t("fourier.radius")} value={circleRadius} min={0} max={Math.max(1, Math.round(h * Math.SQRT2))} step={0.5} onChange={setCircleRadius} testId="fourier-circle-radius" />
              </div>
            )}
            {filterKind === "donut" && (
              <div style={row}>
                <ModeButtons mode={donutMode} onChange={setDonutMode} testId="fourier-donut-mode" />
                <SliderField label={t("fourier.radius")} value={donutRadius} min={0} max={Math.max(1, Math.round(h * Math.SQRT2))} step={0.5} onChange={setDonutRadius} testId="fourier-donut-radius" />
                <SliderField label={t("fourier.donut.width")} value={donutWidth} min={1} max={Math.max(1, h)} step={0.5} onChange={setDonutWidth} testId="fourier-donut-width" />
              </div>
            )}
          </div>
        ) : (
          <div style={{ ...box, flexDirection: "row", gap: 14, alignItems: "flex-start" }}>
            <FloatCanvas values={basisImage} width={n} height={n} size={BASIS} testId="fourier-basis" />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
              <div style={row}>
                <span style={{ color: "#8a98a6" }}>{t("fourier.basis.index")}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, n * n - 1)}
                  value={n ? basisIndex : 0}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    setU(idx % n);
                    setV(Math.floor(idx / n));
                  }}
                  style={{ flex: 1, minWidth: 240 }}
                  disabled={!n}
                  data-testid="fourier-basis-slider"
                />
                <span style={{ fontFamily: "monospace" }}>
                  {n ? basisIndex + 1 : 0}/{n * n}
                </span>
              </div>
              <div style={row}>
                <NumField label="u" value={u} min={0} max={Math.max(0, n - 1)} step={1} onChange={(x) => setU(Math.round(x))} testId="fourier-basis-u" />
                <NumField label="v" value={v} min={0} max={Math.max(0, n - 1)} step={1} onChange={(x) => setV(Math.round(x))} testId="fourier-basis-v" />
                <label style={checkLabel}>
                  <input type="checkbox" checked={weighted} onChange={(e) => setWeighted(e.target.checked)} data-testid="fourier-basis-weighted" />
                  {t("fourier.basis.weighted")}
                </label>
              </div>
              {n > 0 && (
                <div style={{ fontFamily: "monospace", color: "#c3ccd5", lineHeight: 1.6 }}>
                  <div>{t("fourier.basis.freq", { u: u - h, v: v - h })}</div>
                  {basis && <div>{t("fourier.basis.coeff", { mag: fmt(coeffMag), phase: coeffPhase.toFixed(3) })}</div>}
                </div>
              )}
              <div style={hint}>{t("fourier.basis.hint")}</div>
            </div>
          </div>
        )}

        <div style={{ ...footer, gap: 6 }}>
          <span style={{ color: "#8a98a6", alignSelf: "center" }}>{t("fourier.export")}</span>
          {appliedMask && (
            <span style={{ color: "#e0a050", alignSelf: "center" }} data-testid="fourier-export-filtered-note">
              {t("fourier.export.filteredNote")}
            </span>
          )}
          <button style={chip} disabled={!spectrum} onClick={() => exportSpectrum("real")} data-testid="fourier-export-real">
            {t("fourier.export.real")}
          </button>
          <button style={chip} disabled={!spectrum} onClick={() => exportSpectrum("imag")} data-testid="fourier-export-imag">
            {t("fourier.export.imag")}
          </button>
          <button
            style={chip}
            disabled={!spectrum || !source}
            onClick={exportComplexStack}
            title={t("fourier.export.complexHint")}
            data-testid="fourier-export-complex"
          >
            {t("fourier.export.complex")}
          </button>
          <button
            style={chip}
            disabled={!inverse || !source}
            onClick={() => inverse && source && exportTiff(resultView === "real" ? inverse.real : inverse.magnitude, source.width, source.height, `idft${filteredSuffix}${resultView === "magnitude" ? "_abs" : ""}`)}
            data-testid="fourier-export-filtered"
          >
            {t("fourier.export.filtered")}
          </button>
          <button
            style={chip}
            disabled={!basis}
            onClick={() => basis && basisImage && exportTiff(basisImage, n, n, `basis_u${basis.u - h}_v${basis.v - h}${weighted ? `_weighted${filteredSuffix}` : ""}`)}
            data-testid="fourier-export-basis"
          >
            {t("fourier.export.basis")}
          </button>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={btnPrimary} data-testid="fourier-close">
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 部品 ────────────────────────────────────────────────────────

/** float 画像を min/max で自動スケールし、正方形の枠に最近傍でフィットして描く。 */
function FloatCanvas({
  values,
  width,
  height,
  size,
  testId,
}: {
  values: Float32Array | null;
  width: number;
  height: number;
  size: number;
  testId: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    if (!values || !width || !height || values.length !== width * height) return;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      if (!Number.isFinite(x)) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    const range = max > min ? max - min : 1;
    const img = new ImageData(width, height);
    const d = img.data;
    for (let i = 0; i < values.length; i++) {
      const g = Number.isFinite(values[i]) ? Math.round(((values[i] - min) / range) * 255) : 0;
      const o = i * 4;
      d[o] = d[o + 1] = d[o + 2] = g;
      d[o + 3] = 255;
    }
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    off.getContext("2d")!.putImageData(img, 0, 0);
    const scale = Math.min(size / width, size / height);
    const dw = Math.round(width * scale);
    const dh = Math.round(height * scale);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);
  }, [values, width, height, size]);
  return <canvas ref={ref} width={size} height={size} style={canvasStyle} data-testid={testId} />;
}

/** 除去される周波数（マスク < 1）を半透明の赤で重ねる。 */
function MaskTint({ mask, n, size }: { mask: Float32Array | null; n: number; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, size, size);
    if (!mask || !n || mask.length !== n * n) return;
    const img = new ImageData(n, n);
    const d = img.data;
    for (let i = 0; i < mask.length; i++) {
      const o = i * 4;
      d[o] = 230;
      d[o + 1] = 60;
      d[o + 2] = 60;
      d[o + 3] = Math.round((1 - mask[i]) * 110);
    }
    const off = document.createElement("canvas");
    off.width = n;
    off.height = n;
    off.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, size, size);
  }, [mask, n, size]);
  return <canvas ref={ref} width={size} height={size} style={{ position: "absolute", left: 1, top: 1, pointerEvents: "none" }} />;
}

/** フィルタの枠（シフト後座標、viewBox = 0..n）。 */
function FilterOutline(props: {
  n: number;
  kind: FilterKind;
  orientation: "vertical" | "horizontal";
  center: number;
  width: number;
  mirror: boolean;
  circleRadius: number;
  donutRadius: number;
  donutWidth: number;
}) {
  const { n, kind } = props;
  const c = n / 2 + 0.5;
  const common = { fill: "none", stroke: "#4fc3ff", strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" as const };
  if (kind === "rect") {
    const bands = props.mirror && props.center !== 0 ? [props.center, -props.center] : [props.center];
    return (
      <g>
        {bands.map((b, i) => {
          const lo = c + b - props.width / 2;
          return props.orientation === "vertical" ? (
            <rect key={i} x={lo} y={0} width={props.width} height={n} {...common} strokeDasharray={i ? "4 3" : undefined} />
          ) : (
            <rect key={i} x={0} y={lo} width={n} height={props.width} {...common} strokeDasharray={i ? "4 3" : undefined} />
          );
        })}
      </g>
    );
  }
  if (kind === "circle") return <circle cx={c} cy={c} r={Math.max(0, props.circleRadius)} {...common} />;
  if (kind === "donut") {
    return (
      <g>
        <circle cx={c} cy={c} r={Math.max(0, props.donutRadius + props.donutWidth / 2)} {...common} />
        <circle cx={c} cy={c} r={Math.max(0, props.donutRadius - props.donutWidth / 2)} {...common} />
        <circle cx={c} cy={c} r={Math.max(0, props.donutRadius)} {...common} strokeOpacity={0.4} strokeDasharray="4 3" />
      </g>
    );
  }
  return null;
}

function ModeButtons({ mode, onChange, testId }: { mode: FilterMode; onChange: (m: FilterMode) => void; testId: string }) {
  const { t } = useI18n();
  return (
    <>
      {(["pass", "stop"] as FilterMode[]).map((m) => (
        <button key={m} style={mode === m ? chipOn : chip} onClick={() => onChange(m)} data-testid={`${testId}-${m}`}>
          {t(`fourier.mode.${m}`)}
        </button>
      ))}
    </>
  );
}

function SliderField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  testId: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: "#8a98a6" }}>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ width: 140 }}
        data-testid={props.testId}
      />
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => {
          const x = Number(e.target.value);
          if (Number.isFinite(x)) props.onChange(clamp(x, props.min, props.max));
        }}
        style={numInput}
        data-testid={`${props.testId}-num`}
      />
    </label>
  );
}

function NumField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  testId: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: "#8a98a6" }}>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => {
          const x = Number(e.target.value);
          if (Number.isFinite(x)) props.onChange(clamp(x, props.min, props.max));
        }}
        style={numInput}
        data-testid={props.testId}
      />
    </label>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(Math.max(lo, hi), v));
}
function round1(v: number): number {
  return Math.round(v * 2) / 2;
}
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "-";
  const a = Math.abs(v);
  return a !== 0 && (a >= 1e5 || a < 1e-3) ? v.toExponential(3) : v.toFixed(3);
}

// ── スタイル（HistogramDialog と揃える）──────────────────────────

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 200,
};
const panel: React.CSSProperties = {
  background: "#1a2129",
  border: "1px solid #2c3742",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
  padding: 14,
  color: "#dbe3ea",
  fontSize: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxWidth: "96vw",
  maxHeight: "94vh",
  overflow: "auto",
};
const header: React.CSSProperties = { display: "flex", alignItems: "center", fontWeight: 600, fontSize: 14, color: "#7fb2ec" };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", marginTop: 2 };
const column: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const colTitle: React.CSSProperties = { color: "#9fb0c0", fontWeight: 600 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const hint: React.CSSProperties = { fontSize: 11, color: "#7a8896", maxWidth: SPEC };
const checkLabel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, cursor: "pointer" };
const canvasStyle: React.CSSProperties = { border: "1px solid #26313d", background: "#000", display: "block" };
const box: React.CSSProperties = {
  background: "#10161d",
  border: "1px solid #26313d",
  borderRadius: 6,
  padding: "8px 10px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const chip: React.CSSProperties = {
  border: "1px solid #3a4650",
  borderRadius: 5,
  background: "#232c35",
  color: "#c3ccd5",
  cursor: "pointer",
  fontSize: 11,
  padding: "3px 9px",
};
const chipOn: React.CSSProperties = { ...chip, background: "#2b8aef", color: "#fff", border: "1px solid #2b8aef" };
const btnPrimary: React.CSSProperties = {
  border: "1px solid #2b8aef",
  borderRadius: 6,
  background: "#2b8aef",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  padding: "5px 16px",
};
const numInput: React.CSSProperties = {
  width: 64,
  border: "1px solid #3a4650",
  borderRadius: 4,
  background: "#10161d",
  color: "#e8edf2",
  fontSize: 12,
  padding: "2px 5px",
};
