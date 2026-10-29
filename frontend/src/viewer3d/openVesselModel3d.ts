/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグインが解析値（H12 `putVesselAnalysis`）を送ったとき、本体の 3D 画面（`#geometry3d`）を runId つきで開く。
 *
 * <p>旧 3D QCA ダイアログの「3D で開く」が唯一の入口だった。ダイアログを消した後は、QFR の色を見に行く手段が無くなる。
 * 色の宛先は runId で決まる（{@link ./Geometry3DScreen} が `useVesselAnalysis(ctx.runId)` で購読）。
 *
 * <p>🔴 中心線は**登録簿のモデルの点列**を渡す。H12 の色は `segments[0].points` の添字で塗られるので、
 * 再計算した点列を渡すと色が前後逆に乗る（旧ダイアログの注記と同じ）。
 * <p>🔴 分岐部のモデルでは開かない。3D 画面は中心線を 1 本しか描かず、先頭区間だけに色を乗せると他の枝が
 * 「値なし」に見えて誤解を招く（`Geometry3DScreen` の注記: 分岐部は将来）。
 */
import { desktop } from "../desktopBridge";
import { getVesselModel, type XaVesselModel } from "../viewer/xaVesselModelStore";
import { writeGeometry3dContext, type Geometry3DContext } from "./geometry3dContext";

export interface OpenVesselModel3dDeps {
  getModel: (runId: string) => XaVesselModel | null;
  writeContext: (ctx: Omit<Geometry3DContext, "ts">) => void;
  openWindow: () => void;
}

const defaultDeps: OpenVesselModel3dDeps = {
  getModel: (runId) => getVesselModel(runId),
  writeContext: writeGeometry3dContext,
  openWindow: () => {
    // desktop は専用ウィンドウ（位置記憶つき）、web は named target のタブ。
    const d = desktop();
    if (d?.openViewer) void d.openViewer("geometry3d");
    else window.open(`${window.location.pathname}#geometry3d`, "graphy-geometry3d");
  },
};

/** 開けない理由（英語の短文。プラグインの結果欄にそのまま出る）。開けるなら null。 */
function blocker(model: XaVesselModel | null): string | null {
  if (!model) return "no vessel model is registered under this runId";
  if (model.kind !== "xa-qca3d") return "the 3D view shows a single centerline; bifurcation models are not supported";
  const points = model.segments[0]?.points;
  if (!points || points.length < 2) return "the model has fewer than 2 centerline points";
  return null;
}

/** @returns 開いたら true。モデルが無い・分岐部・点が足りないときは何もせず false。 */
export function openVesselModel3d(runId: string, deps: OpenVesselModel3dDeps = defaultDeps): boolean {
  const model = deps.getModel(runId);
  if (blocker(model)) return false;
  const points = model!.segments[0].points;
  deps.writeContext({
    kind: "xa-qca3d",
    name: model!.label,
    runId: model!.runId,
    centerlineLps: points.map((p) => [p[0], p[1], p[2]]),
  });
  deps.openWindow();
  return true;
}

/**
 * H74: プラグインが、登録したモデル（H73）の 3D 画面を開く。開けないときは理由つきで ok: false（黙って何もしない、をしない）。
 * 色は乗らない（色は H12 `putVesselAnalysis` が成功したときに、同じ画面が受け取る）。
 */
export function openVesselModel3dFromPlugin(runId: string, deps: OpenVesselModel3dDeps = defaultDeps): { ok: true } | { ok: false; error: string } {
  const error = blocker(deps.getModel(runId));
  if (error) return { ok: false, error };
  return openVesselModel3d(runId, deps) ? { ok: true } : { ok: false, error: "could not open the 3D view" };
}

/** H12 の戻りが成功のときだけ開く（失敗では開かない）。プラグインへ返す値はそのまま通す。 */
export function openAfterAnalysisPut<T extends { ok: boolean }>(
  result: T,
  runId: string,
  deps: OpenVesselModel3dDeps = defaultDeps,
): T {
  if (result.ok) openVesselModel3d(runId, deps);
  return result;
}
