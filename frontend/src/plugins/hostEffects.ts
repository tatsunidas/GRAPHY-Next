/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// AI ツールが宣言した `effect`（read < display < write）を、実行中の host 呼び出しに対して強制する。
// ツールの実装に渡す host を Proxy で包み、宣言より強い効果を持つメンバに**触れた時点**で止める（呼ぶ前）。
//
// ⚠ 限界: プラグインのコードは 2D 窓と同じ realm で動く。止められるのは host 経由の越権だけで、`fetch` や本体モジュールの
//   直接 import までは止められない。隔離ではなく、宣言と実際の食い違いを実行時に止めるガード（署名・同意・審査の代わりではない）。
import type { PluginHost } from "./pluginTypes";

export type ToolEffect = "read" | "display" | "write";
const RANK: Record<ToolEffect, number> = { read: 0, display: 1, write: 2 };

type KeyofUnion<T> = T extends unknown ? keyof T : never;
export type HostKey = KeyofUnion<PluginHost>;

/**
 * host の最上位メンバごとの最小 effect。名前空間（db / file / compute …）は最上位で 1 つに決める（細分しない）。
 * 型を `Record<HostKey, …>` にしてあるので、host にメンバを足して分類を忘れると `tsc -b` が落ちる。
 */
export const HOST_EFFECTS: Record<HostKey, ToolEffect> = {
  // 読み取り・計算（本体のデータも画面も変えない）
  pluginId: "read",
  apiBase: "read",
  t: "read",
  locale: "read",
  surface: "read",
  selectedStudyUid: "read",
  getTargets: "read",
  getViewState: "read",
  getPixelData: "read",
  getSpatialCalibration: "read",
  getXaState: "read",
  getXaCine: "read",
  getXaGeometry: "read",
  readXaSeries: "read",
  readXaSeriesFrame: "read",
  listVesselModels: "read",
  getVesselModel: "read",
  getRois: "read",
  getRoiMeta: "read",
  loadVolume: "read",
  estimateVolume: "read",
  registerVolumes: "read",
  resampleVolume: "read",
  measureMask: "read",
  measureLabels: "read",
  extractCenterline: "read",
  sampleCenterlineFrames: "read",
  loadStore: "read",
  // 表示・遷移（画面の見え方を変える。保存データは変えない）
  notify: "display",
  actions: "display",
  showOverlay: "display",
  clearOverlay: "display",
  showLabelVolume: "display",
  goTo: "display",
  selectRoi: "display",
  subscribeRois: "display",
  openWindow: "display",
  mountViewport: "display",
  mountVolumeView: "display",
  mountSeriesPanel: "display",
  openCurvedMpr: "display",
  openVesselModel3d: "display",
  // データを書く・外へ出す・外部を動かす
  setRoiMeta: "write",
  createRoi: "write",
  removeCreatedRoi: "write",
  removeLabelVolume: "write",
  putVesselAnalysis: "write",
  registerVesselModel: "write",
  saveDerivedSeries: "write",
  saveStructuredReport: "write",
  saveAngioReport: "write",
  savePresentationState: "write",
  publishAnalysisResult: "write",
  saveSegmentation: "write",
  saveRtDose: "write",
  saveStore: "write",
  deleteStore: "write",
  runBackend: "write",
  runBackendJob: "write",
  ai: "write",
  file: "write",
  compute: "write",
  storage: "write",
  cache: "write",
  db: "write",
  microscopy: "write",
  video: "write",
};

/** 表に無い名前は write 扱い（既定は閉じる）。 */
export function minEffectOf(member: string): ToolEffect {
  return Object.prototype.hasOwnProperty.call(HOST_EFFECTS, member) ? HOST_EFFECTS[member as HostKey] : "write";
}

export class EffectViolation extends Error {
  constructor(readonly member: string, readonly declared: ToolEffect) {
    super(`effect-violation:${declared}:${member}`);
  }
}

export interface GuardedHost {
  host: PluginHost;
  /** 越権に触れた最初のメンバ名（無ければ null）。プラグインが例外を握りつぶしても残る。 */
  violated(): string | null;
}

/**
 * `declared` が write なら host をそのまま返す（書き込みは main が実行のたびに利用者へ確認済み）。
 * それ以外は Proxy で包み、宣言より強いメンバに触れたら記録して `EffectViolation` を投げる。
 * 存在しないメンバの参照は素通し（値が無い＝害が無い）。
 */
export function guardHost(host: PluginHost, declared: ToolEffect): GuardedHost {
  if (declared === "write") return { host, violated: () => null };
  let first: string | null = null;
  const proxy = new Proxy(host as object, {
    get(target, key, receiver) {
      if (typeof key === "string" && Object.prototype.hasOwnProperty.call(target, key) && RANK[minEffectOf(key)] > RANK[declared]) {
        first ??= key;
        throw new EffectViolation(key, declared);
      }
      return Reflect.get(target, key, receiver);
    },
  }) as PluginHost;
  return { host: proxy, violated: () => first };
}
