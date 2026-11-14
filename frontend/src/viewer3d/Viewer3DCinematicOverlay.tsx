/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Cinematic v2（パストレース）オーバーレイ（`fw/3d-viewer-design.md` §6.4 v2 / P7）。
 *
 * pure-vtk ビューポートの上に **独立した WebGL2 canvas** を重ね、`cinematicPathTracer` エンジンで
 * プログレッシブ・パストレースを表示する。vtk のカメラ（回転/Pan/Zoom は下の vtk が処理）を毎フレーム読み取り、
 * 変化したら蓄積をリセット、静止中は指定フレーム数まで蓄積して収束させる。
 *
 * ボリューム/LUT/W-L は vtk ビュー（`getSceneParts`/`getLut256`）から取得＝表示と同じ実空間・単一入口の輝度校正。
 * canvas は不透明（背景黒）でボリュームを置き換え表示する（メッシュ/ROI の重畳は非対応＝ボリュームのみ）。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";
import { geomFromImageData } from "../viewer/labelVolume";
import { inverseViewProj } from "./measure3d";
import {
  createCinematicPathTracer,
  defaultPathTraceParams,
  type CinematicEngine,
} from "../viewer/cinematicPathTracer";
import {
  gpuBudget,
  isSharedMemoryGpu,
  parseGpuRecords,
  planCinematicGrid,
  TEXEL_BYTES,
  updateGpuRecord,
  type BudgetSource,
  type GridReason,
  type Vec3,
} from "../viewer/cinematicBudget";
import { getAppliedVolumeMaxMb, getMax3dTextureSize, volumeCopyCount, volumeMaxBytes } from "../viewer/volumeMemory";
import {
  cinematicScaleForQuality,
  estimateFrameSeconds,
  fitCostModel,
  medianInterval,
  predictMs,
  settleHoldMs,
  type CinematicStats,
  type CostSample,
} from "../viewer/cinematicScale";
import {
  getCinematicBudgetOverride,
  publishCinematicBench,
  publishCinematicForce,
  publishCinematicStats,
  publishCinematicTexture,
} from "../viewer/debugApi";
import { probeRenderEnv, type RenderKind, type RenderQuality } from "../viewer/renderEnv";

const MAX_FRAMES = 400; // 収束目安（これ以上は蓄積を止めて GPU を休める）
/** 画面の更新間隔を測る rAF の数（中央値を取る。数を倍にしても値は変わらない）。 */
const BUDGET_SAMPLES = 30;
/** 縮小率ごとに覚える直近の実測の数（中央値を取る）。 */
const SAMPLES_PER_K = 3;
/** 全解像度（k=1）で止まっているとき、リセット直後のこの数のフレームだけ実時間を測る（毎フレームは測らない）。 */
const STATIC_TIMED_FRAMES = 5;
/**
 * 1 フレームの予測がこの倍数 × 更新間隔以内なら、GPU の完了を待って正確に測る（メインスレッドを止めるのはその間だけ）。
 * それより長いと予測されるフレームは待たず、フェンスの完了を後のフレームで見て測る（遅い機械で操作を止めないため）。
 */
const SYNC_MAX_FRAMES = 4;
/**
 * ソフトウェア描画の確認用の試し描きの縮小率。全解像度の 1/4 の費用で描いて 4 倍する。
 * 実測では k=8 だと固定の待ち（約 65 ms）に埋もれて見積もりが 6 倍に膨らんだので、固定費が見えない大きさにしている。
 */
const PROBE_SCALE = 2;

type Phase = CinematicStats["phase"];

/** この PC・この GPU で描けた／失敗した 3D テクスチャの大きさの記録（localStorage。GPU ごと。設定 KV には載せない＝機械固有）。 */
const GPU_RECORD_KEY = "graphy.cinematic.gpuRecord";
const MIB = 1024 * 1024;

function readGpuRecords() {
  try {
    return parseGpuRecords(localStorage.getItem(GPU_RECORD_KEY));
  } catch {
    return {};
  }
}
function saveGpuRecord(name: string, ev: { ok?: number; fail?: number }): void {
  try {
    localStorage.setItem(GPU_RECORD_KEY, JSON.stringify(updateGpuRecord(readGpuRecords(), name, ev)));
  } catch {
    /* 保存できなくても描画は続ける */
  }
}

/** 画面に出す 3D テクスチャの状態。 */
interface TexView {
  texDims: Vec3;
  srcDims: Vec3;
  srcSpacingMm: Vec3;
  spacingMm: Vec3;
  textureBytes: number;
  gpuBytes: number;
  budgetBytes: number | null;
  source: BudgetSource;
  reason: GridReason;
}
interface Failure {
  kind: "create" | "lost";
  needBytes: number;
  budgetBytes: number | null;
}
const reducedAxes = (v: TexView): number[] => {
  const idx = [0, 1, 2].filter((i) => v.texDims[i] < v.srcDims[i]);
  return idx.length > 0 ? idx : [0, 1, 2];
};
const dimStr = (d: Vec3) => `${d[0]}×${d[1]}×${d[2]}`;
export function Viewer3DCinematicOverlay({
  view,
  active,
  renderKind,
  quality,
  gpuMemoryMb,
  onCancel,
}: {
  view: VtkVolumeView;
  active: boolean;
  /** 描画の種別。null（検出中）の間は始めない。software のときだけ開始前に確認を出す。 */
  renderKind: RenderKind | null;
  /** 設定「3D の画質」。full は操作中も全解像度。 */
  quality: RenderQuality;
  /** 設定「GPU メモリ（MB）」。0・未設定は null（不明）。 */
  gpuMemoryMb: number | null;
  /** 確認で［やめる］が押された。 */
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string>("");
  const [frames, setFrames] = useState(0);
  const [phase, setPhase] = useState<Phase>("measuring");
  const [scale, setScale] = useState(1);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [texView, setTexView] = useState<TexView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** ［間引いて再開］で下げた予算（バイト）。次の開始だけに効く。 */
  const retryBytesRef = useRef<number | null>(null);
  const gpuMemoryMbRef = useRef(gpuMemoryMb);
  gpuMemoryMbRef.current = gpuMemoryMb;
  // effect を作り直さずに最新値を読む。
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const decisionRef = useRef<"start" | "cancel" | null>(null);

  useEffect(() => {
    if (!active) retryBytesRef.current = null;
  }, [active]);

  useEffect(() => {
    if (!active || renderKind === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    decisionRef.current = null;

    // ビューポートの実サイズに canvas を合わせる。
    const parent = canvas.parentElement;
    const rect = parent?.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect?.width ?? canvas.clientWidth));
    const h = Math.max(1, Math.floor(rect?.height ?? canvas.clientHeight));
    canvas.width = w;
    canvas.height = h;

    const parts = view.getSceneParts();
    const geom = geomFromImageData(parts.imageData);
    if (!geom) {
      setError(t("cine2.error"));
      return;
    }

    // ── 3D テクスチャの大きさ: 予算（分かる量だけから）→ 格子（mm で決めて箱平均で間引く）──
    const rendererName = probeRenderEnv().defaultCtx?.renderer ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scalarData: any = parts.imageData.getPointData().getScalars().getData();
    const srcBytes: number = scalarData?.byteLength ?? geom.dims[0] * geom.dims[1] * geom.dims[2] * 4;
    const internalBytes = 2 * w * h * 16 + 1024; // 蓄積（RGBA32F の ping-pong）＋ LUT
    const override = getCinematicBudgetOverride();
    const b = gpuBudget({
      userMb: gpuMemoryMbRef.current,
      shared: isSharedMemoryGpu(rendererName),
      appliedVolumeMaxBytes: volumeMaxBytes(getAppliedVolumeMaxMb()),
      srcBytes,
      srcCopies: volumeCopyCount("viewer3d", "CT") + 1, // CT は 2 本＋vtk 用 1 本＋image キャッシュ 1（保守側）
      vtkBytes: srcBytes, // vtk が持つ 3D テクスチャ（元と同じ型）の見積もり
      internalBytes,
      record: readGpuRecords()[rendererName] ?? null,
    });
    let budgetBytes: number | null = b.textureBytes;
    let source: BudgetSource = b.source;
    if (override.bytes !== null) {
      budgetBytes = override.bytes;
      source = "user";
    }
    if (retryBytesRef.current !== null) {
      budgetBytes = budgetBytes === null ? retryBytesRef.current : Math.min(budgetBytes, retryBytesRef.current);
      source = "record";
    }
    if (override.forceFull) budgetBytes = null; // 検査用: 予算を無視して元の解像度（3D テクスチャの上限だけ守る）
    const grid = planCinematicGrid({
      dims: [geom.dims[0], geom.dims[1], geom.dims[2]],
      spacingMm: [geom.spacing[0], geom.spacing[1], geom.spacing[2]],
      budgetTexels: budgetBytes === null ? null : Math.floor(budgetBytes / TEXEL_BYTES),
      max3d: getMax3dTextureSize(),
    });
    const created = createCinematicPathTracer(canvas, parts.imageData, geom, defaultPathTraceParams(), grid.dims);
    if (!created.ok) {
      if (created.reason === "unsupported" || created.reason === "shader") {
        setError(t("cine2.unsupported"));
      } else {
        // テクスチャの確保に失敗（GPU のメモリ不足など）。その大きさを記録し、再開は下げた予算で。
        saveGpuRecord(rendererName, { fail: grid.bytes });
        setTexView(null);
        setFailure({ kind: "create", needBytes: grid.bytes, budgetBytes });
      }
      return;
    }
    const engine: CinematicEngine = created.engine;
    const info = engine.getTexInfo();
    const view0: TexView = {
      texDims: info.texDims,
      srcDims: info.srcDims,
      srcSpacingMm: [geom.spacing[0], geom.spacing[1], geom.spacing[2]],
      spacingMm: info.spacingMm,
      textureBytes: info.textureBytes,
      gpuBytes: info.textureBytes + 2 * w * h * 16,
      budgetBytes,
      source,
      reason: grid.reason,
    };
    setTexView(view0);
    setFailure(null);
    let okRecorded = false;
    let failedNow: Failure | null = null;
    publishCinematicTexture({
      stats: () => ({
        texDims: info.texDims,
        srcDims: info.srcDims,
        spacingMm: info.spacingMm,
        gpuBytes: view0.gpuBytes,
        textureBytes: info.textureBytes,
        budgetBytes,
        budgetSource: source,
        reason: grid.reason,
        lost: engine.isLost(),
        failure: failedNow ? failedNow.kind : null,
      }),
      loseContext: () => {
        try {
          const g = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
          g?.getExtension("WEBGL_lose_context")?.loseContext();
          return !!g;
        } catch {
          return false;
        }
      },
      readTexLayer: (z) => engine.readTexLayer(z),
      setSeedOffset: (n) => engine.setSeedOffset(n),
      reset: () => engine.reset(),
      frameCount: () => engine.getFrameCount(),
    });
    setError("");
    setScale(1);
    setEstimate(null);
    setPhase("measuring");
    engine.setLut(view.getLut256());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderer: any = parts.renderer;
    let raf = 0;
    let lastFingerprint = "";
    let lastW = w;
    let lastH = h;

    // 状態機械: measuring（画面の更新間隔を測る）→［software のときだけ］probing → confirm → running
    let phaseNow: Phase = "measuring";
    const goto = (p: Phase) => {
      phaseNow = p;
      setPhase(p);
    };
    const intervals: number[] = [];
    let lastRaf = 0;
    let tBudget = Number.NaN;
    let hold = Number.NaN;
    // 縮小率ごとの 1 フレームの実時間（費用のモデル t(k) = fixed + perFull/k² の当てはめに使う）
    const samples: CostSample[] = [];
    const addSample = (k: number, ms: number) => {
      samples.push({ k, ms });
      // 縮小率ごとに直近 SAMPLES_PER_K 個だけ残す
      const same = samples.filter((x) => x.k === k);
      if (same.length > SAMPLES_PER_K) samples.splice(samples.indexOf(same[0]), 1);
    };
    let estimateSec: number | null = null;
    let lastMoveAt = Number.NEGATIVE_INFINITY;
    let moving = false;

    const stats = (): CinematicStats => {
      const size = engine.getInternalSize();
      const model = fitCostModel(samples);
      return {
        phase: phaseNow,
        scale: engine.getRenderScale(),
        internalWidth: size.width,
        internalHeight: size.height,
        canvasWidth: lastW,
        canvasHeight: lastH,
        frameCount: engine.getFrameCount(),
        tBudgetMs: tBudget,
        fixedMs: model ? model.fixedMs : Number.NaN,
        perFullMs: model ? model.perFullMs : Number.NaN,
        tFullMs: model ? predictMs(model, 1) : Number.NaN,
        estimateSeconds: estimateSec,
        quality: qualityRef.current,
        moving,
        samples: samples.map((x) => ({ k: x.k, ms: Math.round(x.ms * 10) / 10 })),
      };
    };
    publishCinematicStats(stats);

    const cameraFingerprint = (): string => {
      try {
        const cam = renderer.getActiveCamera();
        const p = cam.getPosition();
        const f = cam.getFocalPoint();
        const u = cam.getViewUp();
        const s = cam.getParallelScale();
        return [...p, ...f, ...u, s].map((x: number) => x.toFixed(3)).join(",");
      } catch {
        return "";
      }
    };

    /** カメラが変わっていれば（LUT も取り直して）エンジンへ渡し、蓄積をリセットする。変わったら true。 */
    const syncCamera = (): boolean => {
      const fp = cameraFingerprint();
      if (fp === lastFingerprint) return false;
      lastFingerprint = fp;
      const ivp = inverseViewProj(renderer, lastW, lastH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cam: any = renderer.getActiveCamera();
      if (ivp) {
        engine.setCamera(ivp, cam.getPosition() as [number, number, number]);
        engine.setLut(view.getLut256()); // W/L 変更に追従
        engine.reset();
      }
      return true;
    };

    // 待たずに測っている最中のフレーム（出した時刻と縮小率）。フェンスが終わったら実測として覚える
    /** パストレーサのコンテキストが失われた（GPU のメモリ不足など）。その大きさを記録し、案内を出す。vtk の 3D は止めない。 */
    const handleLost = () => {
      if (failedNow) return;
      cancelAnimationFrame(raf);
      failedNow = { kind: "lost", needBytes: info.textureBytes, budgetBytes };
      saveGpuRecord(rendererName, { fail: info.textureBytes });
      setTexView(null); // 古い解像度の行を残さない
      setFailure(failedNow);
    };
    const offLost = engine.onLost(handleLost);

    let pending: { k: number; t0: number } | null = null;
    // 直前の全解像度フレームが終わった時刻とかかった時間（遅い機械で GPU を空けるために使う）
    let doneAt = 0;
    let lastDurMs = 0;

    const timedFrame = (): number => {
      const t0 = performance.now();
      engine.renderFrame();
      engine.finish();
      return performance.now() - t0;
    };

    // DEV のみ: 縮小率ごとの 1 フレームの実時間（費用が画素数に比例するという前提の検証）
    publishCinematicBench((ks) => {
      const out = ks.map((k) => {
        engine.setRenderScale(k);
        engine.reset();
        timedFrame(); // 初回（シェーダ・バッファの確保）を捨てる
        return { k: engine.getRenderScale(), ms: timedFrame() };
      });
      engine.setRenderScale(1);
      engine.reset();
      return out;
    });

    // DEV のみ: 操作中の縮小率を k に固定する（null で解除）。遅い機械でしか起きない「縮小→全解像度」の切り替えを、どの機械でも決まった瞬間に起こす検証用
    let forcedScale: number | null = null;
    publishCinematicForce((k) => {
      forcedScale = k;
    });

    const tick = (now: number) => {
      if (engine.isLost()) {
        handleLost();
        return;
      }
      // リサイズ追従（縮小率は保たれる）。
      const r = parent?.getBoundingClientRect();
      const cw = Math.max(1, Math.floor(r?.width ?? lastW));
      const ch = Math.max(1, Math.floor(r?.height ?? lastH));
      if (cw !== lastW || ch !== lastH) {
        engine.resize(cw, ch);
        lastW = cw;
        lastH = ch;
        lastFingerprint = ""; // リサイズで再取得
        samples.length = 0; // 画素数が変わったので、これまでの実測は使えない
      }

      if (phaseNow === "measuring") {
        // 目標の更新間隔 = この画面で実測した rAF の間隔の中央値（描画はまだしない＝間隔が描画の重さに汚されない）
        if (lastRaf > 0) intervals.push(now - lastRaf);
        lastRaf = now;
        if (intervals.length >= BUDGET_SAMPLES) {
          tBudget = medianInterval(intervals);
          hold = settleHoldMs(tBudget);
          syncCamera();
          goto(renderKind === "software" ? "probing" : "running");
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      if (phaseNow === "probing") {
        // ソフトウェア描画: 全解像度の 1 フレームがどれだけかかるかを、1/PROBE_SCALE² の費用で試し描きして見積もる
        const k = Math.max(1, Math.min(PROBE_SCALE, Math.floor(Math.min(lastW, lastH))));
        engine.setRenderScale(k);
        timedFrame(); // 最初の 1 フレームはシェーダ・バッファの確保を含むので捨てる
        const dt = timedFrame();
        estimateSec = estimateFrameSeconds(dt, k);
        addSample(k, dt);
        engine.setRenderScale(1); // 本番は全解像度から（蓄積は 0）
        setEstimate(Number.isFinite(estimateSec) ? estimateSec : null);
        goto("confirm");
        raf = requestAnimationFrame(tick);
        return;
      }

      if (phaseNow === "confirm") {
        if (decisionRef.current === "cancel") {
          onCancelRef.current(); // 何も始めない（破棄は effect の後始末）
          return;
        }
        if (decisionRef.current === "start") {
          decisionRef.current = null;
          goto("running");
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      // running
      if (syncCamera()) lastMoveAt = now;
      // 操作中 = カメラが変わった直後〜止まって settleHoldMs 経つまで。測れていない（hold が NaN）ときは縮小しない
      moving = forcedScale !== null || (Number.isFinite(hold) && now - lastMoveAt <= hold);
      const target = forcedScale !== null
        ? forcedScale
        : moving
          ? cinematicScaleForQuality(qualityRef.current, fitCostModel(samples), tBudget, lastW, lastH)
          : 1;
      if (target !== engine.getRenderScale()) {
        engine.setRenderScale(target); // 止まったら 1 に戻り、全解像度で蓄積を 0 からやり直す
        setScale(target);
      }
      if (engine.getFrameCount() < MAX_FRAMES) {
        const k = engine.getRenderScale();
        // 待たずに測っていたフレームが終わっていれば回収する。終わっていないあいだは次を出さない
        // （遅い機械で GPU の待ち行列を溜めると、操作への反応が待ち行列の長さだけ遅れる）
        let idle: boolean;
        if (pending) {
          idle = engine.isIdle();
          if (idle) {
            doneAt = performance.now();
            lastDurMs = doneAt - pending.t0;
            addSample(pending.k, lastDurMs);
            pending = null;
          }
        } else idle = engine.isIdle();
        // 実時間は、操作中と、止まって全解像度に戻った直後の数フレームだけ測る。縮小率の違う実測がそろうほど、固定費と画素数に比例する分を分けられる
        const model = fitCostModel(samples);
        const predicted = model ? predictMs(model, k) : Number.NaN;
        const cheap = Number.isFinite(predicted) && predicted <= SYNC_MAX_FRAMES * tBudget;
        // 更新間隔より遅い（予測が不明を含む）フレームは、待たずに毎回測る
        const slow = !Number.isFinite(predicted) || predicted > tBudget;
        const wantTime = moving || engine.getFrameCount() < STATIC_TIMED_FRAMES || slow;
        // 止まっていて遅いときは、直前のフレームと同じ時間は GPU を空ける（占有率を半分以下に。GPU の命令は取り消せないので、
        // 詰めて出し続けると、操作・他の描画（下の vtk・合成）が 1 フレーム分ずつ待たされる）
        const rested = moving || !slow || performance.now() - doneAt >= lastDurMs;
        if (wantTime && cheap) {
          addSample(k, timedFrame());
        } else if (idle && rested) {
          const t0 = performance.now();
          engine.renderFrame();
          if (wantTime) pending = { k, t0 };
        }
        setFrames(engine.getFrameCount());
        if (!okRecorded && engine.getFrameCount() >= 3) {
          okRecorded = true; // 描けた大きさを記録（次の自動の予算の上限の目安）
          saveGpuRecord(rendererName, { ok: info.textureBytes });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      offLost();
      publishCinematicTexture(null);
      publishCinematicStats(null);
      publishCinematicBench(null);
      publishCinematicForce(null);
      engine.dispose();
    };
  }, [active, view, renderKind, t, attempt]);

  if (!active) return null;

  const running = phase === "running";
  return (
    <div style={root}>
      {/* 失われた（または解放した）WebGL コンテキストは同じ canvas では作り直せない。再開のたびに canvas を作り直す。 */}
      <canvas key={attempt} ref={canvasRef} style={{ ...canvasEl, visibility: running ? "visible" : "hidden" }} />
      {phase === "confirm" ? (
        <div style={confirmCard} data-testid="cine2-confirm">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("cine2.confirm.title")}</div>
          <div style={{ marginBottom: 10 }} data-testid="cine2-confirm-body">
            {t("cine2.confirm.body", { sec: estimate === null ? t("cine2.confirm.unknown") : estimate.toFixed(1) })}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button style={confirmBtn} onClick={() => (decisionRef.current = "cancel")} data-testid="cine2-confirm-cancel">
              {t("cine2.confirm.cancel")}
            </button>
            <button style={confirmBtn} onClick={() => (decisionRef.current = "start")} data-testid="cine2-confirm-start">
              {t("cine2.confirm.start")}
            </button>
          </div>
        </div>
      ) : null}
      {failure ? (
        <div style={lostCard} data-testid="cine2-lost" data-kind={failure.kind}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("cine2.lost.title")}</div>
          <div style={{ marginBottom: 10 }} data-testid="cine2-lost-body">
            {t("cine2.lost.body", {
              need: String(Math.ceil(failure.needBytes / MIB)),
              budget: failure.budgetBytes === null ? t("cine2.lost.budgetUnknown") : `${Math.floor(failure.budgetBytes / MIB)} MB`,
            })}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button style={confirmBtn} onClick={() => onCancelRef.current()} data-testid="cine2-lost-close">
              {t("cine2.lost.close")}
            </button>
            <button
              style={confirmBtn}
              onClick={() => {
                retryBytesRef.current = Math.floor(failure.needBytes / 2);
                setFailure(null);
                setPhase("measuring");
                setAttempt((a) => a + 1);
              }}
              data-testid="cine2-retry-downsampled"
            >
              {t("cine2.lost.retry")}
            </button>
          </div>
        </div>
      ) : null}
      <div style={badgeBox}>
      {texView && !failure ? (
        <div
          style={{ ...badge, ...(texView.reason !== "full" ? badgeWarn : null), marginBottom: 4 }}
          data-testid="cine2-resolution"
          data-tex-dims={texView.texDims.join(",")}
          data-src-dims={texView.srcDims.join(",")}
          data-spacing-mm={texView.spacingMm.map((x) => x.toFixed(4)).join(",")}
          data-gpu-bytes={String(texView.gpuBytes)}
          data-budget-source={texView.source}
          data-reason={texView.reason}
        >
          {texView.reason === "full"
            ? t("cine2.resolution.full", { dims: dimStr(texView.texDims), mb: String(Math.ceil(texView.gpuBytes / MIB)) })
            : t("cine2.resolution.reduced", {
                src: dimStr(texView.srcDims),
                dims: dimStr(texView.texDims),
                // 間引いた軸だけの間隔（間引かない軸の間隔を混ぜない）
                from: Math.min(...reducedAxes(texView).map((i) => texView.srcSpacingMm[i])).toFixed(2),
                to: Math.max(...reducedAxes(texView).map((i) => texView.spacingMm[i])).toFixed(2),
                why:
                  texView.reason === "max3d"
                    ? t("cine2.reason.max3d")
                    : t("cine2.reason.budget", { source: t(`cine2.source.${texView.source}`) }),
              })}
        </div>
      ) : null}
      <div style={badge} data-testid="cine2-badge">
        {error
          ? error
          : running
            ? t("cine2.progress", { n: String(Math.min(frames, MAX_FRAMES)), max: String(MAX_FRAMES) }) +
              (scale > 1 ? ` — ${t("cine2.scale", { k: String(scale) })}` : "")
            : phase === "confirm"
              ? ""
              : t("cine2.probing")}
      </div>
      </div>
    </div>
  );
}

const root: React.CSSProperties = { position: "absolute", inset: 0, zIndex: 12, pointerEvents: "none" };
const canvasEl: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", background: "#000" };
const badgeBox: React.CSSProperties = { position: "absolute", bottom: 10, left: 10, display: "flex", flexDirection: "column", alignItems: "flex-start" };
const badgeWarn: React.CSSProperties = { borderColor: "#c88010", color: "#f0b050" };
const lostCard: React.CSSProperties = {
  position: "absolute",
  left: 10,
  bottom: 70,
  maxWidth: 440,
  padding: "12px 14px",
  background: "rgba(20,24,28,0.95)",
  border: "1px solid #c88010",
  borderRadius: 8,
  fontSize: 13,
  color: "#e3e9ee",
  pointerEvents: "auto",
};
const badge: React.CSSProperties = {
  padding: "3px 8px",
  background: "rgba(20,24,28,0.8)",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 11,
  color: "#c7d0d8",
};
const confirmCard: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  maxWidth: 420,
  padding: "14px 16px",
  background: "rgba(20,24,28,0.95)",
  border: "1px solid #3a444d",
  borderRadius: 8,
  fontSize: 13,
  color: "#e3e9ee",
  pointerEvents: "auto",
};
const confirmBtn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #4a5560",
  borderRadius: 4,
  background: "#2a3138",
  color: "#e3e9ee",
  fontSize: 12,
  cursor: "pointer",
};
