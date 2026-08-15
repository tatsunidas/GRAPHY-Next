/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 幾何だけの 3D ウィンドウ（`#geometry3d`）。いまは 3D QCA の中心線を出すために使う
 * （`fw/angio-design.md` §10.2 / A6a）。
 *
 * <h3>なぜ `#viewer3d` の中でやらないのか</h3>
 * 既存の 3D ビューアは**ボリューム起点**で、`createVtkVolumeView` が `vtkImageData` を
 * 受け取って初めてレンダーウィンドウを作る。**XA にボリュームは存在しない**ので、
 * あちらの初期化経路を作り替えないと載らない。あちらには検証済みの機能（シネマティック・
 * 内視鏡・カット・計測）が多く、初期化に手を入れる価値がないと判断した。
 *
 * <p>代わりに**シーンの層（`scene3d.ts`）はそのまま共有する**。物体の登録・表示切替・色・
 * 不透明度は既存の {@link SceneObjectPanel} がそのまま動く。将来メッシュや ROI を
 * ボリューム抜きで出したくなったときも、同じ器に載る。
 *
 * <h3>🚨 出さないもの</h3>
 * W/L・プリセット・ORTHO・クロップ。**無いものを操作させない**（押しても何も起きない
 * ボタンは「壊れている」と読まれる）。
 */
import { useEffect, useRef, useState } from "react";
import type { AppStatus } from "../api";
import { useI18n } from "../i18n/i18n";
import { installDebugApi, publishGeometry3dProbe } from "../viewer/debugApi";
import { Centerline3D } from "../viewer/centerline";
import { createVtkGeometryView, type VtkGeometryView } from "../viewer/vtkGeometryView";
import { isWebGLContextUnavailable } from "../viewer/vtkVolumeView";
import {
  readGeometry3dContext,
  subscribeGeometry3dContext,
  type Geometry3DContext,
} from "./geometry3dContext";
import { addCenterlineObject, attachSceneRenderer, resetScene, setClipContext } from "./scene3d";
import { getSceneObjects, useSceneObjects } from "./scene3dStore";
import { removeObject } from "./scene3d";
import { SceneObjectPanel } from "./SceneObjectPanel";

export function Geometry3DScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<VtkGeometryView | null>(null);
  const startedRef = useRef(false);
  const [ctx, setCtx] = useState<Geometry3DContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 🚨 **このウィンドウでも `window.__graphyDebug` を用意する。**
  //    従来 `SeriesViewer` のマウントでしか呼んでおらず、このウィンドウには存在しなかったため、
  //    実機検証の画素チェックが（描けていても）常に null を返していた。
  useEffect(() => {
    installDebugApi();
  }, []);

  useEffect(() => {
    if (startedRef.current || !status || !hostRef.current) return;
    startedRef.current = true;

    try {
      const view = createVtkGeometryView(hostRef.current);
      viewRef.current = view;
      const parts = view.getSceneParts();
      // ボリュームが無いので不透明度スケールの概念も無い。クリップ基準も持たない。
      attachSceneRenderer({ renderer: parts.renderer, render: parts.render, setVolumeOpacityScale: () => {} });
      setClipContext(null);
      // 実機検証が「本当に描かれているか」を画素で確かめられるようにする（DOM だけでは黒画面を通す）。
      publishGeometry3dProbe(() => viewRef.current?.readPixelStats() ?? null);
      loadRef.current();
    } catch (e) {
      setError(
        isWebGLContextUnavailable(e) ? t("viewer3d.glLost") : `${t("viewer3d.error")}: ${String(e)}`,
      );
    }
  }, [status, t]);

  /**
   * コンテキストを読み直してシーンを作り直す。
   *
   * <p>🚨 **作り直す前に既存の物体を消す。** ウィンドウはシングルトンで、2 回目の
   * 「3D で開く」は同じウィンドウへ届く。消さないと**前の中心線が残って重なる**。
   */
  const loadRef = useRef<() => void>(() => {});
  loadRef.current = () => {
    const c = readGeometry3dContext();
    if (!c) {
      setError(t("geometry3d.noContext"));
      return;
    }
    setCtx(c);
    setError(null);
    // 既存の物体を消してから作り直す（`scene3d.removeObject` はアクターも外す）。
    for (const o of [...getSceneObjects()]) removeObject(o.id);
    const cl = new Centerline3D();
    for (const p of c.centerlineLps) cl.addControlPoint([p[0], p[1], p[2]]);
    const id = addCenterlineObject(cl, { name: c.name });
    if (!id) {
      setError(t("geometry3d.empty"));
      return;
    }
    viewRef.current?.resetCamera();
  };

  // 開いたまま「3D で開く」を押し直したときに中身を差し替える
  // （ウィンドウはシングルトンなので、開き直しでは読み直されない）。
  useEffect(() => subscribeGeometry3dContext(() => loadRef.current()), []);

  // アンマウントで vtk とシーンを片付ける（ウィンドウを閉じ直して開くと二重に載るため）。
  useEffect(() => {
    return () => {
      try {
        resetScene();
      } catch {
        /* ignore */
      }
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => viewRef.current?.resize());
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // 実機検証が「シーンに物体が載ったか」を数値で見られるようにする
  // （SceneObjectPanel には testid が無く、見た目からは判定できない）。
  const objectCount = useSceneObjects().length;
  const info = ctx?.info;
  return (
    <div style={root} data-testid="geometry3d-root">
      <div style={bar}>
        <span style={title} data-testid="geometry3d-title">
          {ctx?.name ?? t("geometry3d.title")}
        </span>
        {info?.lengthMm != null ? (
          <span style={metric} data-testid="geometry3d-length">
            {t("xa3d.length")}: <b>{info.lengthMm.toFixed(1)} mm</b>
          </span>
        ) : null}
        {info?.percentDiameterStenosis != null ? (
          <span style={metric} data-testid="geometry3d-ds">
            {t("xa3d.percentDiameterStenosis")}: <b>{info.percentDiameterStenosis.toFixed(1)} %</b>
          </span>
        ) : null}
        {/* 🚨 補正が掛かっていない結果は歪みを含む。3D で見て納得する前に必ず出す。 */}
        {info?.angleCorrected === false ? (
          <span style={warn} data-testid="geometry3d-not-corrected">
            {t("xa3d.notRefined")}
          </span>
        ) : null}
        {info?.visibleFractionA != null && info?.visibleFractionB != null ? (
          <span style={faint} data-testid="geometry3d-foreshortening">
            {t("xa3d.foreshortening")}: A {(info.visibleFractionA * 100).toFixed(0)}% / B{" "}
            {(info.visibleFractionB * 100).toFixed(0)}%
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button style={btn} data-testid="geometry3d-reset" onClick={() => viewRef.current?.resetCamera()}>
          {t("geometry3d.resetCamera")}
        </button>
      </div>
      <div style={body}>
        <div ref={hostRef} style={canvasHost} data-testid="geometry3d-canvas-host" />
        <div style={side} data-testid="geometry3d-objects" data-count={String(objectCount)}>
          <SceneObjectPanel geom={null} />
        </div>
      </div>
      {error ? (
        <div style={errorBar} data-testid="geometry3d-error">
          {error}
        </div>
      ) : null}
      <div style={footer}>{t("geometry3d.caveat")}</div>
    </div>
  );
}

const root: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: "#0d1216",
  color: "#dfe7ee",
};
const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 10px",
  borderBottom: "1px solid #1e2a33",
  fontSize: 12,
  flexWrap: "wrap",
};
const title: React.CSSProperties = { fontWeight: 600 };
const metric: React.CSSProperties = { fontSize: 12 };
const faint: React.CSSProperties = { fontSize: 11, color: "#8fa1b0" };
const warn: React.CSSProperties = { fontSize: 11, color: "#e0a35a" };
const body: React.CSSProperties = { flex: 1, display: "flex", minHeight: 0 };
const canvasHost: React.CSSProperties = { flex: 1, minWidth: 0, position: "relative" };
const side: React.CSSProperties = { width: 280, borderLeft: "1px solid #1e2a33", overflowY: "auto" };
const errorBar: React.CSSProperties = { padding: "6px 10px", background: "#4a1f18", fontSize: 12 };
const footer: React.CSSProperties = {
  padding: "4px 10px",
  borderTop: "1px solid #1e2a33",
  fontSize: 11,
  color: "#8fa1b0",
};
const btn: React.CSSProperties = {
  padding: "3px 10px",
  border: "1px solid #33424e",
  borderRadius: 3,
  background: "#18222a",
  color: "#dfe7ee",
  cursor: "pointer",
  fontSize: 12,
};
