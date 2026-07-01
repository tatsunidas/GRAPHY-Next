/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Slicer ウィンドウ（P2 改2）。2×2 レイアウト:
 *   左上=Axial / 右上=Coronal / 左下=Sagittal / 右下=再構成スタック。
 * スラブ（各出力スライスの立方体）を AX/COR/SAG にバンド投影し、**中央ハンドル=平行移動 /
 * 四隅ハンドル=回転** で直接操作する。再構成は進捗バー付きで、結果を右下にスタック表示。
 * CT はガントリチルトを起動時に自動補正（`buildMprVolume`）。
 *
 * 起動: `localStorage("graphy-slicer-ctx")` 経由。ビューポート/幾何は `viewer/slicer.ts`、確定リスライスは `viewer/reslice.ts`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RenderingEngine } from "@cornerstonejs/core";
import { fetchSeries, fetchInstances, fetchSeriesLayout, type AppStatus, type Study, type Series, type SeriesLayoutDto } from "../api";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import { imageIdForInstance, imageIdForCell } from "../viewer/imageId";
import {
  setupSlicerMpr,
  teardownSlicer,
  readSlicerGeometry,
  computeSlabBands,
  computeSlabHandles,
  translateGeomInPlane,
  rotateGeomInPlane,
  extractResliceVolume,
  volumeMinSpacing,
  volumeModality,
  displayReconStack,
  buildMprVolume,
  geometryToAngles,
  anglesToGeometry,
  worldToIndex,
  indexToWorld,
  planeFromGeometry,
  type SlicerGeometry,
  type SlicerVpIds,
  type BandPolygon,
  type SlabHandles,
} from "../viewer/slicer";
import { createReslicer, type ReconMode, type Interpolation, type Vec3 } from "../viewer/reslice";
import { fetchSettings } from "../settings/settingsApi";
import { httpSend } from "../http";
import { emitDbChanged } from "../dbEvents";
import { useI18n } from "../i18n/i18n";

const ENGINE_ID = "graphy-slicer-engine";
const TOOL_GROUP_ID = "graphy-slicer-tg";
const VP: SlicerVpIds = {
  axial: "slicer-axial",
  coronal: "slicer-coronal",
  sagittal: "slicer-sagittal",
  recon: "slicer-recon",
};
const SRC_IDS = [VP.axial, VP.coronal, VP.sagittal];

const RECON_MODES: ReconMode[] = ["SLICECUT", "MEAN", "MAX", "MIN", "MEDIAN", "MODE"];

interface SlicerContext {
  study: Study;
  series?: Series;
  /** マルチC/T シリーズをソースにする場合の表示中インデックス（任意）。無ければ 0。 */
  c?: number;
  t?: number;
  ts: number;
}

/** レイアウトから (c,t) 固定の単一 Z スタックの imageIds を取り出す（z 昇順、モザイク/多フレーム対応）。 */
function imageIdsForCT(layout: SeriesLayoutDto, mode: "standalone" | "web", c: number, t: number): string[] {
  return layout.cells
    .filter((cell) => cell.c === c && cell.t === t)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((cell) => imageIdForCell(mode, cell.sopInstanceUid, cell.frame));
}
type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

interface SlabParams {
  fovWidth: number;
  fovHeight: number;
  thickness: number;
  gap: number;
  numSlices: number;
  mode: ReconMode;
}
const DEFAULT_SLAB: SlabParams = { fovWidth: 200, fovHeight: 200, thickness: 3, gap: 0, numSlices: 20, mode: "SLICECUT" };

interface Progress {
  active: boolean;
  done: number;
  total: number;
}
type DragKind = "move" | "rotate";
interface DragState {
  kind: DragKind;
  vpId: string;
  lastX: number;
  lastY: number;
  rect: DOMRect;
}

/** 直近の再構成結果（canonical 正順）。保存時に reverse を適用して並び替える。 */
interface GenResult {
  framesCanon: Int16Array[];
  ippsCanon: Vec3[];
  rows: number;
  cols: number;
  rowDir: Vec3;
  colDir: Vec3;
  pixelSpacing: [number, number]; // DICOM [row, col]
  sliceThickness: number;
  spacingBetweenSlices: number;
}

/** Int16Array を Int16LE のバイト列とみなして Base64 化（ブラウザは LE 前提）。 */
function framePixelsBase64(frame: Int16Array): string {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

const raf = () => new Promise<void>((res) => requestAnimationFrame(() => res()));
const crossVec = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalizeVec = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

export function SlicerScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const axialRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const reconRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const startedRef = useRef(false);
  const geomRef = useRef<SlicerGeometry | null>(null);
  const baseRef = useRef<SlicerGeometry | null>(null); // 起動時の Axial 整列フレーム（回転角の基準）
  const slabRef = useRef<SlabParams>(DEFAULT_SLAB);
  const dragRef = useRef<DragState | null>(null);
  const reconSeqRef = useRef(0);
  const srcStudyRef = useRef<string>("");
  const srcSeriesRef = useRef<string>("");
  const srcDescRef = useRef<string>("");
  const genResultRef = useRef<GenResult | null>(null);
  const layoutRef = useRef<SeriesLayoutDto | null>(null);
  const modalityRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [tilt, setTilt] = useState<number | null>(null);
  const [slab, setSlab] = useState<SlabParams>(DEFAULT_SLAB);
  const [geom, setGeom] = useState<SlicerGeometry | null>(null);
  const [bands, setBands] = useState<Record<string, BandPolygon[]>>({});
  const [handles, setHandles] = useState<Record<string, SlabHandles>>({});
  const [progress, setProgress] = useState<Progress>({ active: false, done: 0, total: 0 });
  const [genInfo, setGenInfo] = useState("");
  const [reverse, setReverse] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dims, setDims] = useState<{ nC: number; nT: number; cDim: string | null; tDim: string | null }>({ nC: 1, nT: 1, cDim: null, tDim: null });
  const [cSel, setCSel] = useState(0);
  const [tSel, setTSel] = useState(0);
  slabRef.current = slab;
  geomRef.current = geom;

  const mode = status?.mode === "standalone" ? "standalone" : "web";

  const elFor = useCallback((id: string): HTMLDivElement | null => {
    if (id === VP.axial) return axialRef.current;
    if (id === VP.coronal) return coronalRef.current;
    if (id === VP.sagittal) return sagittalRef.current;
    return reconRef.current;
  }, []);

  const recompute = useCallback((g: SlicerGeometry | null) => {
    const engine = engineRef.current;
    if (!engine || !g) return;
    const s = slabRef.current;
    const params = { numSlices: s.numSlices, thickness: s.thickness, gap: s.gap, fovWidth: s.fovWidth, fovHeight: s.fovHeight };
    const nb: Record<string, BandPolygon[]> = {};
    const nh: Record<string, SlabHandles> = {};
    for (const id of SRC_IDS) {
      nb[id] = computeSlabBands(engine, id, g, params);
      nh[id] = computeSlabHandles(engine, id, g, params);
    }
    setBands(nb);
    setHandles(nh);
  }, []);

  const start = useCallback(async () => {
    let ctx: SlicerContext | null = null;
    try {
      const raw = localStorage.getItem("graphy-slicer-ctx");
      if (raw) ctx = JSON.parse(raw) as SlicerContext;
    } catch {
      ctx = null;
    }
    if (!ctx?.study) {
      setPhase("error");
      setMessage(t("slicer.noContext"));
      return;
    }
    if (mode !== "standalone") {
      setPhase("unsupported");
      setMessage(t("slicer.webUnsupported"));
      return;
    }
    setPhase("loading");
    setMessage(t("slicer.loading"));
    try {
      await ensureCornerstoneInitialized();
      let series = ctx.series;
      if (!series) {
        const list = await fetchSeries(ctx.study.studyInstanceUid);
        series = list.slice().sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
      }
      if (!series) {
        setPhase("error");
        setMessage(t("slicer.noSeries"));
        return;
      }
      setTitle(series.seriesDescription || series.seriesInstanceUid);
      srcStudyRef.current = ctx.study.studyInstanceUid;
      srcSeriesRef.current = series.seriesInstanceUid;
      srcDescRef.current = series.seriesDescription || "";
      modalityRef.current = series.modality;

      // ZCT レイアウトを取得。マルチ C/T のときは単一（c,t）Z スタックを取り出してから volume 化する。
      let imageIds: string[];
      let c0 = 0;
      let t0 = 0;
      try {
        const layout = await fetchSeriesLayout(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        layoutRef.current = layout;
        setDims({ nC: layout.nC, nT: layout.nT, cDim: layout.cDimension, tDim: layout.tDimension });
        // 初期 C/T: ctx（2D ビューアの表示中インデックス）があれば採用、無ければ 0。範囲クランプ。
        c0 = Math.min(Math.max(0, ctx.c ?? 0), Math.max(0, layout.nC - 1));
        t0 = Math.min(Math.max(0, ctx.t ?? 0), Math.max(0, layout.nT - 1));
        setCSel(c0);
        setTSel(t0);
        imageIds = imageIdsForCT(layout, mode, c0, t0);
        if (imageIds.length < 3) {
          // フォールバック（レイアウト導出が不十分な場合は全インスタンス）。
          const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
          imageIds = instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid));
        }
      } catch {
        layoutRef.current = null;
        const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        imageIds = instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid));
      }
      if (imageIds.length < 3) {
        setPhase("error");
        setMessage(t("slicer.needVolume"));
        return;
      }
      const volumeId = `graphy-slicer-vol:${series.seriesInstanceUid}:c${c0}t${t0}`;
      // CT はガントリチルトを必要に応じて自動補正（buildMprVolume 内で判定）。
      const built = await buildMprVolume(imageIds, series.modality, volumeId);
      setTilt(built.corrected ? (built.tiltAngleDeg ?? null) : null);

      if (!axialRef.current || !coronalRef.current || !sagittalRef.current || !reconRef.current) {
        setPhase("error");
        setMessage(t("slicer.error"));
        return;
      }
      const engine = new RenderingEngine(ENGINE_ID);
      engineRef.current = engine;
      await setupSlicerMpr(
        engine,
        ENGINE_ID,
        { axial: axialRef.current, coronal: coronalRef.current, sagittal: sagittalRef.current, recon: reconRef.current },
        VP,
        volumeId,
        TOOL_GROUP_ID,
      );
      setPhase("ready");
      requestAnimationFrame(() => {
        const g = readSlicerGeometry(engine, VP.axial);
        if (g) {
          baseRef.current = g; // 回転角の基準フレーム
          setGeom(g);
          recompute(g);
        }
      });
    } catch (e) {
      setPhase("error");
      setMessage(`${t("slicer.error")}: ${String(e)}`);
    }
  }, [mode, t, recompute]);

  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  useEffect(() => {
    return () => {
      teardownSlicer(engineRef.current, TOOL_GROUP_ID);
      engineRef.current = null;
    };
  }, []);

  // geom / slab 変更でバンド・ハンドル再計算。
  useEffect(() => {
    if (phase === "ready") recompute(geom);
  }, [phase, geom, slab, recompute]);

  // ── ハンドルドラッグ ──
  const onHandleDown = useCallback(
    (kind: DragKind, vpId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const el = elFor(vpId);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      dragRef.current = { kind, vpId, lastX: e.clientX - rect.left, lastY: e.clientY - rect.top, rect };
      e.stopPropagation();
      e.preventDefault();
    },
    [elFor],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const engine = engineRef.current;
      if (!d || !engine) return;
      const nx = e.clientX - d.rect.left;
      const ny = e.clientY - d.rect.top;
      const last: [number, number] = [d.lastX, d.lastY];
      const now: [number, number] = [nx, ny];
      const cur = geomRef.current;
      if (!cur) return;
      const ng =
        d.kind === "move"
          ? translateGeomInPlane(engine, d.vpId, cur, last, now)
          : rotateGeomInPlane(engine, d.vpId, cur, last, now);
      if (ng) {
        setGeom(ng);
        recompute(ng);
      }
      d.lastX = nx;
      d.lastY = ny;
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [recompute]);

  // ── 確定リスライス（進捗バー付き）＋ 右下にスタック表示 ──
  const onGenerate = useCallback(async () => {
    const engine = engineRef.current;
    const g = geomRef.current;
    if (!engine || !g || progress.active) return;
    try {
    const vol = extractResliceVolume(engine, VP.axial);
    if (!vol) {
      setGenInfo(t("slicer.error"));
      return;
    }
    const outSpacing = volumeMinSpacing(engine, VP.axial);
    const modality = volumeModality(engine, VP.axial);
    // Settings で指定された補間アルゴリズムを毎回最新で取得（別ウィンドウで変更されても反映）。
    let interpolation: Interpolation = "linear";
    try {
      const s = await fetchSettings();
      if (s["slicer.interpolation"] === "nearest") interpolation = "nearest";
    } catch {
      /* 既定 linear */
    }
    // 断面平面は geom（colDir=画面下）から直接構成。IOP は geom の rowDir/colDir をそのまま採用。
    const plane = planeFromGeometry(g, slab.fovWidth, slab.fovHeight, outSpacing, outSpacing);
    const r = createReslicer(vol, plane, { numSlices: slab.numSlices, thickness: slab.thickness, gap: slab.gap, mode: slab.mode, interpolation });
    setGenInfo("");
    setProgress({ active: true, done: 0, total: r.numSlices });
    // 常に正順（canonical, s=0..N-1）で再構成。IOP=rowDir/colDir は不変。
    const frames: Int16Array[] = [];
    const ipps: Vec3[] = [];
    for (let s = 0; s < r.numSlices; s++) {
      frames.push(r.sliceAt(s));
      ipps.push(r.imagePositionPatientAt(s));
      setProgress({ active: true, done: s + 1, total: r.numSlices });
      await raf();
    }
    // recon の幾何（IOP・視点・積層方向）は **reverse に関係なく canonical で固定**する。
    // 積層方向は LPS 実空間座標（正順 IPP の差分）から導出。これで reverse でも視点が変わらず
    // 左右ミラー等の「見た目変化」が起きない。
    const rowDir: Vec3 = [plane.rowDir[0], plane.rowDir[1], plane.rowDir[2]];
    const colDir: Vec3 = [plane.colDir[0], plane.colDir[1], plane.colDir[2]];
    const dir3: Vec3 =
      ipps.length >= 2
        ? normalizeVec([ipps[1][0] - ipps[0][0], ipps[1][1] - ipps[0][1], ipps[1][2] - ipps[0][2]])
        : crossVec(rowDir, colDir);
    // 保存用に canonical（正順）の結果を保持（保存時に reverse を適用して並び替える）。
    genResultRef.current = {
      framesCanon: frames,
      ippsCanon: ipps,
      rows: r.rows,
      cols: r.cols,
      rowDir,
      colDir,
      pixelSpacing: [r.pixelSpacing[0], r.pixelSpacing[1]],
      sliceThickness: r.sliceThickness,
      spacingBetweenSlices: r.spacingBetweenSlices,
    };
    setHasResult(true);
    // reverse は「再構成後にスライス表示順を並び替えるだけ」＝表示フレーム列のみ反転。
    const displayFrames = reverse ? frames.slice().reverse() : frames;
    const reconVolId = `graphy-slicer-recon:${++reconSeqRef.current}`;
    try {
      await displayReconStack(engine, VP.recon, reconVolId, {
        frames: displayFrames,
        cols: r.cols,
        rows: r.rows,
        numSlices: r.numSlices,
        origin: ipps[0],
        rowDir,
        colDir,
        normal: dir3,
        colSpacing: r.pixelSpacing[1],
        rowSpacing: r.pixelSpacing[0],
        spacingBetweenSlices: r.spacingBetweenSlices,
        modality,
      });
    } catch {
      /* ignore */
    }
    setProgress({ active: false, done: r.numSlices, total: r.numSlices });
    setGenInfo(t("slicer.generated", { n: String(r.numSlices), rows: String(r.rows), cols: String(r.cols) }));
    } catch (e) {
      setProgress({ active: false, done: 0, total: 0 });
      setGenInfo(`${t("slicer.error")}: ${String(e)}`);
      // eslint-disable-next-line no-console
      console.error("[slicer] reconstruct failed:", e);
    }
  }, [slab, progress.active, reverse, t]);

  // ── 派生（セカンダリ）シリーズとして DICOM 保存 ──
  const onSave = useCallback(async () => {
    const g = genResultRef.current;
    if (!g || saving) return;
    setSaving(true);
    setGenInfo("");
    try {
      const n = g.framesCanon.length;
      // 出力順（reverse は InstanceNumber と IPP の並び順で表現。IOP は不変）。
      const order = reverse ? Array.from({ length: n }, (_, k) => n - 1 - k) : Array.from({ length: n }, (_, k) => k);
      const frames = order.map((idx, k) => ({
        instanceNumber: k + 1,
        imagePositionPatient: g.ippsCanon[idx],
        pixels: framePixelsBase64(g.framesCanon[idx]),
      }));
      const desc = `${srcDescRef.current || "Series"} Reslice`;
      const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUids: string[] }>(
        "/api/series/derived",
        "POST",
        {
          studyInstanceUid: srcStudyRef.current,
          seriesInstanceUid: srcSeriesRef.current,
          seriesDescription: desc,
          seriesNumber: null,
          rows: g.rows,
          columns: g.cols,
          pixelSpacing: g.pixelSpacing,
          sliceThickness: g.sliceThickness,
          spacingBetweenSlices: g.spacingBetweenSlices,
          imageOrientationPatient: [...g.rowDir, ...g.colDir],
          frames,
        },
      );
      // 他ウィンドウ（MainScreen）へ DB 変更を通知し、現在の検索条件でツリーを再読込させる。
      emitDbChanged({ reason: "series-create", studyUids: [srcStudyRef.current] });
      setGenInfo(t("slicer.saved", { n: String(res.sopInstanceUids.length) }));
    } catch (e) {
      setGenInfo(`${t("slicer.saveFailed")}: ${String(e)}`);
      // eslint-disable-next-line no-console
      console.error("[slicer] save failed:", e);
    } finally {
      setSaving(false);
    }
  }, [reverse, saving, t]);

  // マルチ C/T シリーズで表示チャンネル/時相を切り替える（単一 Z スタックを差し替え。幾何は保持）。
  const applyCT = useCallback(
    async (cIdx: number, tIdx: number) => {
      const engine = engineRef.current;
      const layout = layoutRef.current;
      if (!engine || !layout) return;
      const ids = imageIdsForCT(layout, mode, cIdx, tIdx);
      if (ids.length < 3) return;
      const volId = `graphy-slicer-vol:${srcSeriesRef.current}:c${cIdx}t${tIdx}`;
      try {
        const built = await buildMprVolume(ids, modalityRef.current, volId);
        setTilt(built.corrected ? (built.tiltAngleDeg ?? null) : null);
        for (const id of SRC_IDS) {
          const vp = engine.getViewport(id) as unknown as {
            setVolumes: (v: Array<{ volumeId: string }>) => Promise<void>;
          };
          await vp.setVolumes([{ volumeId: volId }]);
        }
        engine.renderViewports(SRC_IDS);
        // 同一空間・同一 IPP のため geom は保持。recon 結果はクリア（内容が変わるため）。
        genResultRef.current = null;
        setHasResult(false);
        setGenInfo("");
        requestAnimationFrame(() => recompute(geomRef.current));
      } catch (e) {
        setGenInfo(`${t("slicer.error")}: ${String(e)}`);
      }
    },
    [mode, recompute, t],
  );

  const busy = phase === "loading" || phase === "idle";
  const commit = (key: keyof SlabParams) => (v: number) => setSlab((s) => ({ ...s, [key]: v }));
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  // ── 回転角(XYZ, deg) と 中心ボクセル座標(IJK) の表示値（小数切り捨て） ──
  const base = baseRef.current;
  const anglesRaw = geom && base ? geometryToAngles(base, geom) : [0, 0, 0];
  const angles: [number, number, number] = [Math.trunc(anglesRaw[0]), Math.trunc(anglesRaw[1]), Math.trunc(anglesRaw[2])];
  const engineNow = engineRef.current;
  const centerIjkRaw = engineNow && geom ? worldToIndex(engineNow, VP.axial, geom.center) : null;
  const centerIjk: [number, number, number] | null = centerIjkRaw
    ? [Math.trunc(centerIjkRaw[0]), Math.trunc(centerIjkRaw[1]), Math.trunc(centerIjkRaw[2])]
    : null;

  // 回転角のマニュアル入力 → base に Euler を適用して geom を再構成。
  const onAngleCommit = (axis: 0 | 1 | 2) => (v: number) => {
    const b = baseRef.current;
    const g = geomRef.current;
    if (!b || !g) return;
    const cur = geometryToAngles(b, g);
    cur[axis] = v;
    const ng = anglesToGeometry(b, g.center, [cur[0], cur[1], cur[2]]);
    setGeom(ng);
    recompute(ng);
  };
  // 中心ボクセル座標のマニュアル入力 → world へ変換して center を更新。
  const onCenterCommit = (axis: 0 | 1 | 2) => (v: number) => {
    const engine = engineRef.current;
    const g = geomRef.current;
    if (!engine || !g) return;
    const cur = worldToIndex(engine, VP.axial, g.center);
    if (!cur) return;
    const ijk: Vec3 = [cur[0], cur[1], cur[2]];
    ijk[axis] = v;
    const w = indexToWorld(engine, VP.axial, ijk);
    if (!w) return;
    const ng = { ...g, center: w };
    setGeom(ng);
    recompute(ng);
  };

  return (
    <div style={root}>
      <div style={header}>
        <span style={hTitle}>{t("main.toolbar.slicer")}</span>
        {title && <span style={hSeries}>{title}</span>}
        {tilt !== null && (
          <span style={tiltChip} title={t("mpr.tiltCorrectedHint")}>
            {t("mpr.tiltCorrected", { deg: tilt.toFixed(1) })}
          </span>
        )}
      </div>

      {phase === "ready" && (
        <div style={ctrlBar}>
          {(dims.nC > 1 || dims.nT > 1) && (
            <>
              {dims.nC > 1 && (
                <label style={selWrap}>
                  <span style={ctrlGroupLabel}>{dims.cDim || "C"}</span>
                  <select style={select} value={cSel} onChange={(e) => { const c = Number(e.target.value); setCSel(c); void applyCT(c, tSel); }}>
                    {Array.from({ length: dims.nC }, (_, i) => (<option key={i} value={i}>{i}</option>))}
                  </select>
                </label>
              )}
              {dims.nT > 1 && (
                <label style={selWrap}>
                  <span style={ctrlGroupLabel}>{dims.tDim || "T"}</span>
                  <select style={select} value={tSel} onChange={(e) => { const tt = Number(e.target.value); setTSel(tt); void applyCT(cSel, tt); }}>
                    {Array.from({ length: dims.nT }, (_, i) => (<option key={i} value={i}>{i}</option>))}
                  </select>
                </label>
              )}
              <span style={ctrlSep} />
            </>
          )}
          <span style={ctrlGroupLabel}>{t("slicer.rotation")}</span>
          <Field label="X" value={angles[0]} min={-360} step={1} onCommit={onAngleCommit(0)} unit="°" />
          <Field label="Y" value={angles[1]} min={-360} step={1} onCommit={onAngleCommit(1)} unit="°" />
          <Field label="Z" value={angles[2]} min={-360} step={1} onCommit={onAngleCommit(2)} unit="°" />
          <span style={ctrlSep} />
          <span style={ctrlGroupLabel}>{t("slicer.centerVox")}</span>
          <Field label="I" value={centerIjk ? centerIjk[0] : 0} min={0} step={1} onCommit={onCenterCommit(0)} />
          <Field label="J" value={centerIjk ? centerIjk[1] : 0} min={0} step={1} onCommit={onCenterCommit(1)} />
          <Field label="K" value={centerIjk ? centerIjk[2] : 0} min={0} step={1} onCommit={onCenterCommit(2)} />
          <span style={ctrlSep} />
          <label style={selWrap}>
            <input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} />
            <span style={fieldLabel}>{t("slicer.reverse")}</span>
          </label>
        </div>
      )}

      <div style={grid}>
        <Cell label={t("mpr.axial")} color="#00dc00" refEl={axialRef} vpId={VP.axial} bands={bands[VP.axial]} handles={handles[VP.axial]} onHandleDown={onHandleDown} reverse={reverse} />
        <Cell label={t("mpr.coronal")} color="#00a0ff" refEl={coronalRef} vpId={VP.coronal} bands={bands[VP.coronal]} handles={handles[VP.coronal]} onHandleDown={onHandleDown} reverse={reverse} />
        <Cell label={t("mpr.sagittal")} color="#dcdc00" refEl={sagittalRef} vpId={VP.sagittal} bands={bands[VP.sagittal]} handles={handles[VP.sagittal]} onHandleDown={onHandleDown} reverse={reverse} />
        <Cell label={t("slicer.recon")} color="#ff9a5a" refEl={reconRef} vpId={VP.recon} />
        {phase !== "ready" && (
          <div style={overlay}>
            <div style={overlayBox}>{busy ? t("slicer.loading") : message}</div>
          </div>
        )}
      </div>

      {phase === "ready" && (
        <div style={panel}>
          <Field label={t("slicer.fovW")} value={slab.fovWidth} min={1} onCommit={commit("fovWidth")} unit="mm" />
          <Field label={t("slicer.fovH")} value={slab.fovHeight} min={1} onCommit={commit("fovHeight")} unit="mm" />
          <Field label={t("slicer.thickness")} value={slab.thickness} min={0.1} step={0.5} onCommit={commit("thickness")} unit="mm" />
          <Field label={t("slicer.gap")} value={slab.gap} min={0} step={0.5} onCommit={commit("gap")} unit="mm" />
          <Field label={t("slicer.numSlices")} value={slab.numSlices} min={1} step={1} onCommit={commit("numSlices")} />
          <label style={selWrap}>
            <span style={fieldLabel}>{t("slicer.reconMode")}</span>
            <select style={select} value={slab.mode} onChange={(e) => setSlab((s) => ({ ...s, mode: e.target.value as ReconMode }))}>
              {RECON_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <span style={hint}>{t("slicer.handleHint")}</span>
          <div style={{ flex: 1 }} />
          {progress.active ? (
            <div style={progWrap}>
              <div style={progBarOuter}>
                <div style={{ ...progBarInner, width: `${pct}%` }} />
              </div>
              <span style={progText}>
                {t("slicer.reconstructing")} {progress.done}/{progress.total}
              </span>
            </div>
          ) : (
            genInfo && <span style={genInfoStyle}>{genInfo}</span>
          )}
          <button style={progress.active ? genBtnDisabled : genBtn} onClick={onGenerate} disabled={progress.active}>
            {t("slicer.generate")}
          </button>
          <button
            style={hasResult && !saving && !progress.active ? genBtn : genBtnDisabled}
            onClick={onSave}
            disabled={!hasResult || saving || progress.active}
            title={hasResult ? "" : t("slicer.saveNeedGen")}
          >
            {saving ? t("slicer.saving") : t("slicer.save")}
          </button>
        </div>
      )}
    </div>
  );
}

function Cell({
  label,
  color,
  refEl,
  vpId,
  bands,
  handles,
  onHandleDown,
  reverse,
}: {
  label: string;
  color: string;
  refEl: React.RefObject<HTMLDivElement>;
  vpId: string;
  bands?: BandPolygon[];
  handles?: SlabHandles;
  onHandleDown?: (kind: "move" | "rotate", vpId: string, e: React.PointerEvent) => void;
  reverse?: boolean;
}) {
  const n = bands?.length ?? 0;
  const centroid = (p: BandPolygon): [number, number] => {
    let x = 0;
    let y = 0;
    for (const pt of p) {
      x += pt[0];
      y += pt[1];
    }
    return [x / p.length, y / p.length];
  };
  return (
    <div style={cell}>
      <div ref={refEl} style={vpEl} onContextMenu={(e) => e.preventDefault()} />
      <svg style={svgOverlay}>
        {(bands ?? []).map((p, i) =>
          p.length >= 3 ? (
            <polygon key={i} points={p.map((pt) => `${pt[0]},${pt[1]}`).join(" ")} fill="rgba(255,120,80,0.10)" stroke="#ff7a50" strokeWidth={1} />
          ) : null,
        )}
        {(bands ?? []).map((p, i) => {
          if (p.length < 3) return null;
          const [cx, cy] = centroid(p);
          // 番号は再構成ビューの表示スライス順に合わせる（cornerstone は volume を逆向きに表示するため反転）。
          const num = reverse ? i + 1 : n - i;
          return (
            <text key={`n${i}`} x={cx} y={cy} fill="#ffd27a" fontSize={10} textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none", textShadow: "0 0 3px #000" }}>
              {num}
            </text>
          );
        })}
        {handles?.corners.map((c, i) => (
          <circle
            key={`c${i}`}
            cx={c[0]}
            cy={c[1]}
            r={6}
            fill="#ffd27a"
            stroke="#7a4a2a"
            style={{ pointerEvents: "auto", cursor: "crosshair" }}
            onPointerDown={(e) => onHandleDown?.("rotate", vpId, e)}
          />
        ))}
        {handles?.center && (
          <circle
            cx={handles.center[0]}
            cy={handles.center[1]}
            r={7}
            fill="rgba(255,120,80,0.85)"
            stroke="#fff"
            style={{ pointerEvents: "auto", cursor: "move" }}
            onPointerDown={(e) => onHandleDown?.("move", vpId, e)}
          />
        )}
      </svg>
      <span style={{ ...cellLabel, color }}>{label}</span>
    </div>
  );
}

/** 手入力を許可する数値フィールド。入力中は文字列を保持し、妥当な値は即コミット、blur で min クランプ。 */
function Field({
  label,
  value,
  min,
  step,
  unit,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  step?: number;
  unit?: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const focusedRef = useRef(false);
  // 外部から値が変わったら（未フォーカス時のみ）表示を同期。
  useEffect(() => {
    if (!focusedRef.current) setText(String(value));
  }, [value]);
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const tt = e.target.value;
    setText(tt);
    const v = parseFloat(tt);
    if (Number.isFinite(v)) onCommit(v); // 入力途中の妥当値は即反映（下限は下流でガード）
  };
  const onBlur = () => {
    focusedRef.current = false;
    let v = parseFloat(text);
    if (!Number.isFinite(v)) v = value;
    v = Math.max(min, v);
    onCommit(v);
    setText(String(v));
  };
  return (
    <label style={selWrap}>
      <span style={fieldLabel}>{label}</span>
      <input
        type="number"
        style={input}
        value={text}
        step={step ?? 1}
        min={min}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={onChange}
        onBlur={onBlur}
      />
      {unit && <span style={fieldUnit}>{unit}</span>}
    </label>
  );
}

// ── styles ────────────────────────────────────────────────────
const root: React.CSSProperties = { position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "#000", color: "#e6eaee", fontFamily: "system-ui, sans-serif" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "6px 12px", background: "#14181c", borderBottom: "1px solid #23292f", fontSize: 13 };
const hTitle: React.CSSProperties = { fontWeight: 600 };
const hSeries: React.CSSProperties = { color: "#9aa6b2" };
const tiltChip: React.CSSProperties = { marginLeft: "auto", fontSize: 11, color: "#ffd27a", border: "1px solid #5a4a2a", background: "#2a220f", borderRadius: 4, padding: "1px 7px" };
const ctrlBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "5px 12px", background: "#0d1013", borderBottom: "1px solid #23292f", fontSize: 12, flexWrap: "wrap" };
const ctrlGroupLabel: React.CSSProperties = { color: "#7f8b96", fontWeight: 600 };
const ctrlSep: React.CSSProperties = { width: 1, height: 16, background: "#2c343b", margin: "0 4px" };
const grid: React.CSSProperties = { position: "relative", flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", minHeight: 0 };
const cell: React.CSSProperties = { position: "relative", minWidth: 0, minHeight: 0, border: "1px solid #23292f" };
const vpEl: React.CSSProperties = { position: "absolute", inset: 0 };
const svgOverlay: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" };
const cellLabel: React.CSSProperties = { position: "absolute", top: 6, left: 8, fontSize: 12, fontWeight: 600, textShadow: "0 0 3px #000", pointerEvents: "none" };
const overlay: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" };
const overlayBox: React.CSSProperties = { padding: "10px 18px", background: "#1b2126", border: "1px solid #2c343b", borderRadius: 8, fontSize: 13, maxWidth: "80%", textAlign: "center" };
const panel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 14, padding: "8px 12px", background: "#14181c", borderTop: "1px solid #23292f", fontSize: 12, flexWrap: "wrap" };
const selWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5 };
const fieldLabel: React.CSSProperties = { color: "#9aa6b2" };
const fieldUnit: React.CSSProperties = { color: "#7f8b96" };
const hint: React.CSSProperties = { color: "#6b7680", fontSize: 11 };
const input: React.CSSProperties = { width: 62, background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const select: React.CSSProperties = { background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const genInfoStyle: React.CSSProperties = { color: "#8fe08f", fontSize: 12 };
const progWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 220 };
const progBarOuter: React.CSSProperties = { flex: 1, height: 8, background: "#1b2126", border: "1px solid #2c343b", borderRadius: 4, overflow: "hidden", minWidth: 120 };
const progBarInner: React.CSSProperties = { height: "100%", background: "#0b8f4d", transition: "width 0.05s linear" };
const progText: React.CSSProperties = { color: "#9aa6b2", whiteSpace: "nowrap" };
const genBtn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 5, fontSize: 12, padding: "5px 12px", cursor: "pointer" };
const genBtnDisabled: React.CSSProperties = { ...genBtn, background: "#2c343b", color: "#7f8b96", cursor: "not-allowed" };
