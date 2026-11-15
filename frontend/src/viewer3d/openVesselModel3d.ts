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
 * <p>単一血管の XA（`xa-qca3d`）は従来どおり中心線 1 本。**木（分岐部の XA・CT 由来）は区間ごとの点列を `segments` に入れ**、
 * 3D 画面が区間ごとに 1 物体を描き、色も `segmentId` で区間ごとに乗せる（先頭区間だけに色が乗って他の枝が
 * 「値なし」に見える問題は、区間ごとの描画で解消した）。
 */
import { desktop } from "../desktopBridge";
import { getVesselModel, type VesselModel } from "../viewer/xaVesselModelStore";
import { writeGeometry3dContext, type Geometry3DContext } from "./geometry3dContext";

export interface OpenVesselModel3dDeps {
  getModel: (runId: string) => VesselModel | null;
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
function blocker(model: VesselModel | null): string | null {
  if (!model) return "no vessel model is registered under this runId";
  if (model.segments.length === 0) return "the model has no segments";
  const short = model.segments.find((s) => !s.points || s.points.length < 2);
  if (short) return `segment ${short.id} has fewer than 2 centerline points`;
  return null;
}

/** @returns 開いたら true。モデルが無い・点が足りないときは何もせず false。 */
export function openVesselModel3d(runId: string, deps: OpenVesselModel3dDeps = defaultDeps): boolean {
  const model = deps.getModel(runId);
  if (blocker(model)) return false;
  const copy = (pts: [number, number, number][]) => pts.map((p) => [p[0], p[1], p[2]]);
  const first = model!.segments[0].points;
  deps.writeContext({
    kind: model!.kind,
    name: model!.label,
    runId: model!.runId,
    centerlineLps: copy(first),
    // 単一血管の XA は従来どおり centerlineLps だけ（挙動を変えない）。木は区間ごとに渡す。
    ...(model!.kind === "xa-qca3d"
      ? {}
      : { segments: model!.segments.map((s) => ({ id: s.id, ...(s.name !== undefined ? { name: s.name } : {}), points: copy(s.points) })) }),
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
