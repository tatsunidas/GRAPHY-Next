/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **中心線を渡して本体の Curved MPR を開く**（プラグイン host API）。
 *
 * <p>プラグインが渡すのは中心線の制御点（患者 LPS mm）と見え方のオプションだけ。
 * 再構成・表示・保存は本体の Curved MPR 窓が行う（プラグインに CPR の 2 本目の実装を書かせない。
 * `pluginCenterlineApi.ts` / H41 と同じ理由）。
 *
 * <p>🔴 戻り値は「検証と起動要求まで」。窓は非同期に開くので、ボリュームの範囲外の点は
 * 戻り値では返せない。範囲外は窓の警告として出る（切り詰めも 0 埋めの黙認もしない）。
 */
import { fetchSeries, type Study } from "../api";
import { desktop } from "../desktopBridge";
import {
  notifyCurvedMprContext,
  writeCurvedMprContext,
  type CurvedMprContext,
  type CurvedMprOptions,
  type CurvedMprProvenance,
} from "../curvedmpr/curvedMprContext";
import { MIN_CHORD } from "../viewer/centerline";
import type { PluginSeriesRef } from "./pluginTypes";

export interface PluginCurvedMprSpec {
  /** 開いているタイルのシリーズ。 */
  source: PluginSeriesRef;
  /** 制御点（患者 LPS mm、2 点以上、順序つき）。 */
  centerline: [number, number, number][];
  /** 省略した項目は窓の既定。`frameMode` だけは省略時 `ROTATION_MINIMIZING`（血管向け）。 */
  options?: CurvedMprOptions;
  /** 窓の札に出す短い説明（例: 「右冠動脈 近位〜中部」）。出所のプラグイン名は host が必ず付ける。 */
  title?: string;
}

export interface PluginCurvedMprResult {
  ok: boolean;
  error?: string;
}

export type PluginCurvedMprProducer = { id: string; name: string; version: string };
type StudyResolver = (seriesUid: string) => string | undefined;

type Validated = { ok: true; studyUid: string } | { ok: false; error: string };

const FRAME_MODES = ["FIXED_Z", "ROTATION_MINIMIZING"];
const PROJECTIONS = ["CENTERLINE_ONLY", "AVERAGE", "MIP", "MINIP"];

/** 起動の前に弾けるものを弾く（窓は開かない）。純関数。 */
export function validateCurvedMprSpec(spec: PluginCurvedMprSpec, resolver: StudyResolver): Validated {
  const src = spec?.source;
  if (!src || typeof src.seriesUid !== "string" || !src.seriesUid) {
    return { ok: false, error: "source.seriesUid が必要です" };
  }
  // 開いているタイルからしか引かない（患者をまたがせない。studyUid を渡したときは一致も見る）。
  const studyUid = resolver(src.seriesUid);
  if (!studyUid) return { ok: false, error: "指定のシリーズは開いているタイルにありません" };
  if (src.studyUid && src.studyUid !== studyUid) {
    return { ok: false, error: "source.studyUid が開いているタイルのスタディと一致しません" };
  }
  const pts = spec.centerline;
  if (!Array.isArray(pts) || pts.length < 2) return { ok: false, error: "centerline は 2 点以上が必要です" };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => typeof x === "number" && Number.isFinite(x))) {
      return { ok: false, error: `centerline[${i}] は有限な数 3 つ [x,y,z] である必要があります` };
    }
  }
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    if (!(d >= MIN_CHORD)) {
      return { ok: false, error: `centerline[${i - 1}] と [${i}] が同じ位置です（隣り合う点は離す）` };
    }
  }
  const o = spec.options;
  if (o) {
    if (o.frameMode !== undefined && !FRAME_MODES.includes(o.frameMode)) return { ok: false, error: "options.frameMode が不正です" };
    if (o.projection !== undefined && !PROJECTIONS.includes(o.projection)) return { ok: false, error: "options.projection が不正です" };
    if (o.bandHalfWidthMm !== undefined && !(Number.isFinite(o.bandHalfWidthMm) && o.bandHalfWidthMm >= 0)) {
      return { ok: false, error: "options.bandHalfWidthMm は 0 以上の数です" };
    }
    if (o.arcStepMm !== undefined && !(Number.isFinite(o.arcStepMm) && o.arcStepMm > 0)) {
      return { ok: false, error: "options.arcStepMm は正の数です" };
    }
    if (o.secondAxisRangeMm !== undefined) {
      const r = o.secondAxisRangeMm;
      if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isFinite) || !(r[0] < r[1])) {
        return { ok: false, error: "options.secondAxisRangeMm は [min, max]（min < max）です" };
      }
    }
  }
  return { ok: true, studyUid };
}

/** 窓に渡すコンテキストを組む。出所は host が入れる。 */
export function buildCurvedMprContext(
  spec: PluginCurvedMprSpec,
  producer: PluginCurvedMprProducer,
  study: Study,
  series: CurvedMprContext["series"],
  title?: string,
): CurvedMprContext {
  const provenance: CurvedMprProvenance = {
    pluginId: producer.id,
    pluginName: producer.name,
    pluginVersion: producer.version,
    ...(title ? { title } : {}),
  };
  return {
    study,
    series,
    c: spec.source.c ?? 0,
    t: spec.source.t ?? 0,
    ts: Date.now(),
    centerline: spec.centerline.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
    options: { ...spec.options, frameMode: spec.options?.frameMode ?? "ROTATION_MINIMIZING" },
    provenance,
  };
}

export async function openCurvedMprFromPlugin(
  spec: PluginCurvedMprSpec,
  producer: PluginCurvedMprProducer,
  resolver: StudyResolver,
): Promise<PluginCurvedMprResult> {
  const v = validateCurvedMprSpec(spec, resolver);
  if (!v.ok) return { ok: false, error: v.error };
  let series;
  try {
    series = (await fetchSeries(v.studyUid)).find((s) => s.seriesInstanceUid === spec.source.seriesUid);
  } catch (e) {
    return { ok: false, error: `シリーズ情報を取得できません: ${String(e)}` };
  }
  if (!series) return { ok: false, error: "指定のシリーズが保管庫に見つかりません" };
  const ctx = buildCurvedMprContext(spec, producer, { studyInstanceUid: v.studyUid } as Study, series, spec.title);
  writeCurvedMprContext(ctx);
  // 窓が既に開いていれば読み直させる。開いていなければ誰も受けず、openViewer が新しく開く。
  notifyCurvedMprContext();
  const d = desktop();
  if (d?.openViewer) void d.openViewer("curvedmpr");
  else window.open(`${window.location.pathname}#curvedmpr`, "graphy-curvedmpr");
  return { ok: true };
}
