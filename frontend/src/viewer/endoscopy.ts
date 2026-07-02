/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 内視鏡（fly-through）カメラ。旧 GRAPHY `endo/{EndoCamera,EndoPath3D}` の TS/vtk.js 移植。
 *
 * パスは **{@link Centerline3D}**（中心線解析と共通の親パスクラス）。弧長パラメータ u∈[0,1] で位置と接線を得て、
 * vtkCamera を毎フレーム手動駆動する。up ベクトルは **RMF 法線**（`frameAt(arc,"ROTATION_MINIMIZING")`）を採用し、
 * 旧 `EndoCamera` の「接線が ±Y に近いと up が反転する」既知バグを設計段階で回避する。
 * 追加のマウスルック（yaw/pitch, ±85° クランプ）を RMF フレームの上に重ねる。全て患者 LPS mm。
 *
 * 操作（直感優先）: 左ドラッグ=見回し / ホイール=前進後退 / 再生ボタンで自動前進。
 */
import vtkInteractorStyleManipulator from "@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator";
import { Centerline3D } from "./centerline";
import type { Vec3 } from "./reslice";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const LOOK_SENSITIVITY = 0.005; // rad/px（GRAPHY 準拠）
const MAX_PITCH = (85 * Math.PI) / 180;
const WHEEL_STEP_U = 0.01; // ホイール 1 ノッチで進む正規化距離
const BASE_TRAVERSE_SEC = 10; // 100% 速度でパス全体を約 10 秒

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
/** Rodrigues 回転（axis は単位）。 */
function rotate(v: Vec3, axis: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [
    v[0] * c + k[0] * s + axis[0] * d,
    v[1] * c + k[1] * s + axis[1] * d,
    v[2] * c + k[2] * s + axis[2] * d,
  ];
}

/** UI 同期用の内視鏡状態。 */
export interface EndoState {
  active: boolean;
  u: number; // 0..1
  playing: boolean;
  fovDeg: number;
  /** 画面上での患者頭側（superior）方向 [right成分, up成分]（向きインジケータ用）。 */
  arrow: [number, number];
  lengthMm: number;
}

export interface EndoController {
  start(): void;
  stop(): void;
  isActive(): boolean;
  setU(u: number): void;
  step(deltaU: number): void;
  jumpStart(): void;
  jumpEnd(): void;
  setFovDeg(f: number): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  isPlaying(): boolean;
  setSpeedPct(pct: number): void;
  resetLook(): void;
  getState(): EndoState;
  onChange(cb: (s: EndoState) => void): () => void;
  destroy(): void;
}

const SUPERIOR: Vec3 = [0, 0, 1]; // 患者頭側（LPS +Z）

export function createEndoController(
  deps: { renderer: Any; render: () => void },
  cl: Centerline3D,
): EndoController {
  const { renderer, render } = deps;
  const renderWindow: Any = renderer.getRenderWindow?.();
  const interactor: Any = renderWindow?.getInteractor?.();
  const camera: Any = renderer.getActiveCamera?.();

  let active = false;
  let u = 0;
  let yaw = 0;
  let pitch = 0;
  let fovDeg = 60;
  let speedPct = 100;
  let playing = false;
  let arrow: [number, number] = [0, 1];

  // 保存/復元用。
  let savedStyle: Any = null;
  let savedParallel = false;
  const subs: { unsubscribe?: () => void }[] = [];
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let rafId: number | null = null;
  let lastTs = 0;

  const listeners = new Set<(s: EndoState) => void>();
  const totalLen = () => cl.getTotalLength();

  const state = (): EndoState => ({
    active,
    u,
    playing,
    fovDeg,
    arrow,
    lengthMm: totalLen(),
  });
  const emit = () => {
    const s = state();
    for (const l of [...listeners]) {
      try {
        l(s);
      } catch {
        /* ignore */
      }
    }
  };

  const updateCamera = () => {
    if (!camera) return;
    const total = totalLen();
    const arc = clamp(u, 0, 1) * total;
    const f = cl.frameAt(arc, "ROTATION_MINIMIZING");
    const forward0 = norm(f.tangent);
    const up0 = norm(f.normal);
    // yaw（up 周り）→ pitch（右軸周り）。
    const fwd1 = norm(rotate(forward0, up0, yaw));
    const right1 = norm(cross(fwd1, up0));
    const fwd2 = norm(rotate(fwd1, right1, pitch));
    const up2 = norm(cross(right1, fwd2));
    const pos = f.position;
    const focalDist = Math.max(1, total * 0.05);
    camera.setPosition(pos[0], pos[1], pos[2]);
    camera.setFocalPoint(
      pos[0] + fwd2[0] * focalDist,
      pos[1] + fwd2[1] * focalDist,
      pos[2] + fwd2[2] * focalDist,
    );
    camera.setViewUp(up2[0], up2[1], up2[2]);
    camera.setViewAngle(fovDeg);
    // 内視鏡は近接描画: near/far を実寸で明示（resetCameraClippingRange は内部視点で切り過ぎる）。
    const near = Math.max(0.05, total * 0.0005);
    camera.setClippingRange(near, Math.max(near * 10, total * 4 + 1000));
    // 向きインジケータ: superior を画面平面（right2, up2）へ投影。
    const right2 = norm(cross(fwd2, up2));
    arrow = [dot(SUPERIOR, right2), dot(SUPERIOR, up2)];
    render();
  };

  // ── 入力ハンドラ ─────────────────────────────────────────────
  const onDown = (cd: Any) => {
    const p = cd?.position;
    if (!p) return;
    dragging = true;
    lastX = p.x;
    lastY = p.y;
  };
  const onMove = (cd: Any) => {
    if (!dragging) return;
    const p = cd?.position;
    if (!p) return;
    const dx = p.x - lastX;
    const dy = p.y - lastY;
    lastX = p.x;
    lastY = p.y;
    yaw -= dx * LOOK_SENSITIVITY; // 右ドラッグで右を向く
    pitch = clamp(pitch + dy * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH); // 上ドラッグで上（display y は上が+）
    updateCamera();
  };
  const onUp = () => {
    dragging = false;
  };
  const onWheel = (cd: Any) => {
    // ホイールで前進/後退（スクラブ）。spinY>0 で前進。
    const spin = cd?.spinY ?? -(cd?.wheelDelta ?? 0);
    const dir = spin > 0 ? 1 : -1;
    setU(u + dir * WHEEL_STEP_U);
  };

  // ── 再生ループ ───────────────────────────────────────────────
  const doPause = () => {
    playing = false;
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    emit();
  };
  const doPlay = () => {
    if (playing) return;
    if (u >= 1) u = 0;
    playing = true;
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
    emit();
  };
  const tick = (ts: number) => {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    const dU = (speedPct / 100) * (1 / BASE_TRAVERSE_SEC) * dt;
    let nu = u + dU;
    if (nu >= 1) {
      nu = 1;
      u = nu;
      updateCamera();
      doPause();
      return;
    }
    u = nu;
    updateCamera();
    emit();
    rafId = requestAnimationFrame(tick);
  };

  const setU = (val: number) => {
    u = clamp(val, 0, 1);
    updateCamera();
    emit();
  };

  return {
    start() {
      if (active || !interactor || !camera) return;
      active = true;
      savedStyle = interactor.getInteractorStyle?.();
      try {
        savedParallel = camera.getParallelProjection?.() ?? false;
        camera.setParallelProjection?.(false); // 透視投影（内視鏡）
      } catch {
        /* ignore */
      }
      // トラックボールを無効化（操作なしの manipulator スタイルに差し替え）。
      try {
        interactor.setInteractorStyle(vtkInteractorStyleManipulator.newInstance());
      } catch {
        /* ignore */
      }
      // 入力購読。
      try {
        subs.push(interactor.onLeftButtonPress(onDown));
        subs.push(interactor.onMouseMove(onMove));
        subs.push(interactor.onLeftButtonRelease(onUp));
        subs.push(interactor.onMouseWheel(onWheel));
      } catch {
        /* ignore */
      }
      resetLookInternal();
      updateCamera();
      emit();
    },
    stop() {
      if (!active) return;
      active = false;
      doPause();
      for (const s of subs) {
        try {
          s.unsubscribe?.();
        } catch {
          /* ignore */
        }
      }
      subs.length = 0;
      try {
        if (savedStyle) interactor.setInteractorStyle(savedStyle);
      } catch {
        /* ignore */
      }
      try {
        camera.setParallelProjection?.(savedParallel);
      } catch {
        /* ignore */
      }
      render();
      emit();
    },
    isActive: () => active,
    setU,
    step(d) {
      setU(u + d);
    },
    jumpStart() {
      setU(0);
    },
    jumpEnd() {
      setU(1);
    },
    setFovDeg(fd) {
      fovDeg = clamp(fd, 20, 150);
      updateCamera();
      emit();
    },
    play() {
      doPlay();
    },
    pause() {
      doPause();
    },
    togglePlay() {
      if (playing) doPause();
      else doPlay();
    },
    isPlaying: () => playing,
    setSpeedPct(pct) {
      speedPct = clamp(pct, 10, 400);
    },
    resetLook() {
      resetLookInternal();
      updateCamera();
      emit();
    },
    getState: state,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    destroy() {
      this.stop();
      listeners.clear();
    },
  };

  function resetLookInternal() {
    yaw = 0;
    pitch = 0;
  }
}
