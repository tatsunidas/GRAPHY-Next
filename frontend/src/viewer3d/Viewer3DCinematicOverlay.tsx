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
  cinematicScaleForQuality,
  estimateFrameSeconds,
  fitCostModel,
  medianInterval,
  predictMs,
  settleHoldMs,
  type CinematicStats,
  type CostSample,
} from "../viewer/cinematicScale";
import { publishCinematicBench, publishCinematicForce, publishCinematicStats } from "../viewer/debugApi";
import type { RenderKind, RenderQuality } from "../viewer/renderEnv";

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

export function Viewer3DCinematicOverlay({
  view,
  active,
  renderKind,
  quality,
  onCancel,
}: {
  view: VtkVolumeView;
  active: boolean;
  /** 描画の種別。null（検出中）の間は始めない。software のときだけ開始前に確認を出す。 */
  renderKind: RenderKind | null;
  /** 設定「3D の画質」。full は操作中も全解像度。 */
  quality: RenderQuality;
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
  // effect を作り直さずに最新値を読む。
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const decisionRef = useRef<"start" | "cancel" | null>(null);

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
    const engine: CinematicEngine | null = createCinematicPathTracer(
      canvas,
      parts.imageData,
      geom,
      defaultPathTraceParams(),
    );
    if (!engine) {
      setError(t("cine2.unsupported"));
      return;
    }
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
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      publishCinematicStats(null);
      publishCinematicBench(null);
      publishCinematicForce(null);
      engine.dispose();
    };
  }, [active, view, renderKind, t]);

  if (!active) return null;

  const running = phase === "running";
  return (
    <div style={root}>
      <canvas ref={canvasRef} style={{ ...canvasEl, visibility: running ? "visible" : "hidden" }} />
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
  );
}

const root: React.CSSProperties = { position: "absolute", inset: 0, zIndex: 12, pointerEvents: "none" };
const canvasEl: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", background: "#000" };
const badge: React.CSSProperties = {
  position: "absolute",
  bottom: 10,
  left: 10,
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
