/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * シリーズの「一部だけ」を開くための、取得済みレイアウトへの範囲のかけ方（純関数）。
 *
 * <p>範囲は**患者座標の法線方向の位置（mm）**で持つ（IPP · 法線）。スライス番号は入力と表示だけの薄い層で、
 * 並べ替え・C/T の切り替えで指す断面が変わるので、番号を正本にしない。IPP が無いシリーズだけ、番号の範囲
 * （0 origin）で持つ。
 *
 * <p>範囲は**連続した 1 区間**だけ。飛び飛びの範囲は MPR で「欠けたスライス」として補間され、撮っていない断面を
 * 作ってしまうので受け付けない（`fw/slice-depth-policy.md`）。
 *
 * <p>backend の ZCT レイアウト API は変えない。レイアウトは今のとおり全体を取り、画面側で絞る。
 */
import type { Series, Study } from "../api";
import type { SeriesLayout } from "./seriesLayout";
import { checkStitchBasis, type StitchPetInfo, type StitchViolation } from "./volumeStitch";

/** Z の範囲。`mm` は法線方向の位置の区間（両端を含む）、`index` は 0 origin の Z 番号の区間（両端を含む）。 */
export type ZRange =
  | { kind: "mm"; fromMm: number; toMm: number }
  | { kind: "index"; from: number; to: number };

/** タイルの「開き方」。今のタイルは parts が 1 本で range なし。連結表示も同じ型の parts を複数にして使う。 */
export interface SeriesSource {
  parts: Array<{ study: string; series: string; range?: ZRange }>;
}

export type RestrictFailure = "invalid" | "outOfRange" | "empty" | "noIpp";

export type RestrictResult =
  | {
    ok: true;
    /** 絞ったあとのレイアウト（nZ・zStack・tStack・ippAt を詰め直したもの。C/T は保持）。 */
    layout: SeriesLayout;
    /** 残した Z（元のレイアウトの 0 origin の番号、昇順）。 */
    keptZ: number[];
    /** 元のレイアウトの Z の数。 */
    total: number;
  }
  | { ok: false; reason: RestrictFailure };

/** 各 Z の法線方向の位置（mm）。IPP か法線が無い・1 つでも欠けていれば null（欠けを黙って飛ばさない）。 */
export function positionsMm(layout: SeriesLayout): number[] | null {
  const n = layout.normal;
  const ippAt = layout.ippAt;
  if (!n || !ippAt || layout.nZ < 1) return null;
  const out: number[] = [];
  for (let z = 0; z < layout.nZ; z++) {
    const p = ippAt(z);
    if (!p) return null;
    out.push(p[0] * n[0] + p[1] * n[1] + p[2] * n[2]);
  }
  return out;
}

/**
 * 端の判定の許容（mm）。間隔の 1% を 0.01 mm で頭打ちにする（IPP の桁の丸めと、間隔の細かいシリーズの両方に合う）。
 * 間隔が分からない（1 枚）ときは 0.01 mm。
 */
export function rangeToleranceMm(pos: readonly number[]): number {
  if (pos.length < 2) return 0.01;
  const gaps: number[] = [];
  for (let i = 1; i < pos.length; i++) {
    const g = Math.abs(pos[i] - pos[i - 1]);
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return 0.01;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.min(0.01, median * 0.01);
}

/** 範囲をレイアウトにかける。0 枚・範囲外・IPP が無いのに mm で指定、は理由つきで断る。 */
export function restrictLayout(layout: SeriesLayout, range: ZRange): RestrictResult {
  const total = layout.nZ;
  let kept: number[] = [];
  if (range.kind === "index") {
    const { from, to } = range;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return { ok: false, reason: "invalid" };
    if (from < 0 || to > total - 1) return { ok: false, reason: "outOfRange" };
    for (let z = from; z <= to; z++) kept.push(z);
  } else {
    const { fromMm, toMm } = range;
    if (!Number.isFinite(fromMm) || !Number.isFinite(toMm)) return { ok: false, reason: "invalid" };
    const pos = positionsMm(layout);
    if (!pos) return { ok: false, reason: "noIpp" };
    const lo = Math.min(fromMm, toMm);
    const hi = Math.max(fromMm, toMm);
    const tol = rangeToleranceMm(pos);
    kept = [];
    for (let z = 0; z < pos.length; z++) {
      if (pos[z] >= lo - tol && pos[z] <= hi + tol) kept.push(z);
    }
    if (kept.length === 0) {
      // シリーズの範囲に全く掛からない（範囲外）か、掛かるのに 1 枚も無い（間に入る位置が無い）かを分ける
      const min = Math.min(...pos);
      const max = Math.max(...pos);
      return { ok: false, reason: hi < min - tol || lo > max + tol ? "outOfRange" : "empty" };
    }
  }
  const base = layout;
  const ippAt = base.ippAt;
  const tStack = base.tStack;
  const restricted: SeriesLayout = {
    ...base,
    nZ: kept.length,
    zStack: (c, t) => {
      const all = base.zStack(c, t);
      return kept.map((z) => all[z]);
    },
    ippAt: ippAt ? (z) => ippAt(kept[z] ?? -1) : ippAt,
    tStack: tStack ? (z, c) => tStack(kept[z] ?? -1, c) : tStack,
  };
  return { ok: true, layout: restricted, keptZ: kept, total };
}

/**
 * 0 origin の番号の範囲（両端を含む）から、保存・表示に使う範囲を作る。IPP が全部そろっていれば mm の区間に直す
 * （並べ替えても同じ断面を指す）。そろっていなければ番号のまま。範囲外・逆順は null。
 */
export function rangeFromIndices(layout: SeriesLayout, from: number, to: number): ZRange | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || from < 0 || to > layout.nZ - 1) return null;
  const pos = positionsMm(layout);
  if (!pos) return { kind: "index", from, to };
  const slice = pos.slice(from, to + 1);
  return { kind: "mm", fromMm: Math.min(...slice), toMm: Math.max(...slice) };
}

/**
 * 昇順・重複なしの番号の列が連続した 1 区間か。連続なら { from, to }、飛び飛び・空なら null。
 * 入力欄の「1-5, 8」のような飛び飛びを断るために使う。
 */
export function contiguousSpan(indices: readonly number[]): { from: number; to: number } | null {
  if (indices.length === 0) return null;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) return null;
  }
  return { from: indices[0], to: indices[indices.length - 1] };
}

/** 見出し用: 「範囲 101–200 / 300」の数（1 origin）。 */
export function describeKept(keptZ: readonly number[], total: number): { from: number; to: number; count: number; total: number } {
  return { from: keptZ[0] + 1, to: keptZ[keptZ.length - 1] + 1, count: keptZ.length, total };
}

const fmt = (x: number) => String(Number(x.toFixed(3)));

/** タイル ID。範囲が無ければ従来どおり `${study}|${series}`、あれば範囲を足す（同じシリーズでも範囲が違えば別タイル）。 */
export function tileIdFor(study: string, series: string, range?: ZRange | null): string {
  return range ? `${study}|${series}|${rangeKey(range)}` : `${study}|${series}`;
}

/** 範囲を一意に表す短い文字列（タイル ID・起動コンテキストの同一性判定に使う）。 */
export function rangeKey(range: ZRange): string {
  return range.kind === "mm"
    ? `${fmt(Math.min(range.fromMm, range.toMm))}-${fmt(Math.max(range.fromMm, range.toMm))}mm`
    : `#${range.from + 1}-${range.to + 1}`;
}

// ---- 連結表示（複数シリーズを開くときだけ 1 本につなぐ。DB・ファイルは変えない） ----

/** 連結に渡す 1 本。レイアウトに無い判定用の値（向き・格子・患者・FoR・モダリティ）を添える。 */
export interface ConcatPart {
  study: string;
  series: string;
  /** 範囲指定があれば {@link restrictLayout} をかけたあとのレイアウト。 */
  layout: SeriesLayout;
  /** DICOM の IOP（行方向 3, 列方向 3）。 */
  iop: number[];
  /** DICOM の PixelSpacing の並び（行間, 列間）。 */
  pixelSpacing: [number, number];
  rows: number;
  columns: number;
  patientId: string;
  frameOfReferenceUid: string;
  modality: string;
  pet?: StitchPetInfo;
}

export type ConcatViolation = StitchViolation | "frameOfReference" | "multiCT" | "noIpp" | "nested";

/** 継ぎ目 1 か所。重なり・隙間は端のスライス中心 ± 間隔/2 の縁から縁で測る（`volumeStitch` と同じ）。 */
export interface ConcatSeam {
  /** 法線方向の位置の昇順に並べたときの、前後のシリーズ（`parts` の添字）。 */
  before: number;
  after: number;
  overlapMm: number;
  gapMm: number;
  /** 重なりを切る位置（重なりの中点）。重なりが無ければ null。 */
  cutMm: number | null;
}

export type ConcatCheck =
  | { ok: true; violations: []; order: number[]; seams: ConcatSeam[] }
  | { ok: false; violations: ConcatViolation[]; order: number[]; seams: ConcatSeam[] };

interface PartSpan { pos: number[]; lo: number; hi: number }

function medianSpacing(pos: readonly number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < pos.length; i++) {
    const g = Math.abs(pos[i] - pos[i - 1]);
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 2)];
}

/** 端のスライス中心 ± 間隔/2 の縁。1 枚だけのシリーズは間隔が分からないので中心そのもの。 */
function spanOf(pos: number[]): PartSpan {
  const half = medianSpacing(pos) / 2;
  return { pos, lo: Math.min(...pos) - half, hi: Math.max(...pos) + half };
}

/** 連結できるかの判定。違反した条件をすべて返す（黙って通さない）。 */
export function checkConcat(parts: readonly ConcatPart[]): ConcatCheck {
  const v = new Set<ConcatViolation>();
  if (parts.length < 2) v.add("tooFew");
  if (parts.some((x) => x.layout.nC !== 1 || x.layout.nT !== 1 || x.layout.stackAxis === "t")) v.add("multiCT");
  const frames = parts.map((x) => x.frameOfReferenceUid);
  if (frames.some((f) => !f || f !== frames[0])) v.add("frameOfReference");

  const basis = checkStitchBasis(parts.map((x) => ({
    iop: x.iop,
    modality: x.modality,
    patientId: x.patientId,
    pet: x.pet,
    inplaneLongestMm: Math.hypot((x.columns - 1) * x.pixelSpacing[1], (x.rows - 1) * x.pixelSpacing[0]),
    inplaneFinestMm: Math.min(x.pixelSpacing[0], x.pixelSpacing[1]),
  })));
  for (const k of basis.violations) if (k !== "tooFew") v.add(k);

  const poss = parts.map((x) => positionsMm(x.layout));
  if (poss.some((p) => !p)) v.add("noIpp");

  let order: number[] = parts.map((_, i) => i);
  const seams: ConcatSeam[] = [];
  if (!poss.some((p) => !p) && parts.length > 0) {
    const spans = poss.map((p) => spanOf(p as number[]));
    order = order.sort((i, j) => spans[i].lo - spans[j].lo || i - j);
    for (let k = 1; k < order.length; k++) {
      const a = spans[order[k - 1]];
      const b = spans[order[k]];
      const overlap = a.hi - b.lo;
      seams.push({
        before: order[k - 1],
        after: order[k],
        overlapMm: Math.max(0, overlap),
        gapMm: Math.max(0, -overlap),
        cutMm: overlap > 0 ? (a.hi + b.lo) / 2 : null,
      });
    }
    // 切ったあとに 1 枚も残らないシリーズ（別のシリーズの中に入っている）は連結できない。
    const kept = keptByPart(parts.length, order, spans, seams);
    if (kept.some((z) => z.length === 0)) v.add("nested");
  }
  const violations = ORDER.filter((k) => v.has(k));
  return violations.length === 0
    ? { ok: true, violations: [], order, seams }
    : { ok: false, violations, order, seams };
}

const ORDER: ConcatViolation[] = [
  "tooFew", "patient", "frameOfReference", "orientation", "modality", "petReference", "multiCT", "noIpp", "nested",
];

/** 各シリーズが残すスライス（元のレイアウトの Z の番号）。重なりは中点で切り、片方のシリーズだけにする。 */
function keptByPart(n: number, order: number[], spans: PartSpan[], seams: ConcatSeam[]): number[][] {
  const kept: number[][] = Array.from({ length: n }, () => []);
  order.forEach((pi, k) => {
    const from = k > 0 ? seams[k - 1].cutMm : null;
    const to = k < order.length - 1 ? seams[k].cutMm : null;
    spans[pi].pos.forEach((x, z) => {
      if (from !== null && x < from) return;
      if (to !== null && x >= to) return;
      kept[pi].push(z);
    });
  });
  return kept;
}

/** 連結したレイアウトの 1 枚ぶんの出どころ。ROI の `seriesUid` は SOP の元のシリーズにするために使う。 */
export interface ConcatCell { partIndex: number; study: string; series: string; z: number }

/** 連結後の継ぎ目。`index` は連結後の 0 origin の Z で、次のシリーズの最初のスライス。 */
export interface ConcatJoint { index: number; before: number; after: number; overlapMm: number; gapMm: number }

export type ConcatResult =
  | { ok: true; layout: SeriesLayout; cells: ConcatCell[]; joints: ConcatJoint[]; check: ConcatCheck }
  | { ok: false; violations: ConcatViolation[]; check: ConcatCheck };

/**
 * 複数シリーズを法線方向の位置の昇順に 1 本に並べる。重なりは中点で切って片方のシリーズのスライスだけにし
 * （2 本を交互に並べると、再構成条件が違うときにスクロールで画像がちらつき、位置も不等間隔になる）、
 * 隙間は埋めない。DB・ファイルは触らない。
 */
export function concatLayouts(parts: readonly ConcatPart[]): ConcatResult {
  const check = checkConcat(parts);
  if (!check.ok) return { ok: false, violations: check.violations, check };
  const poss = parts.map((x) => positionsMm(x.layout) as number[]);
  const spans = poss.map(spanOf);
  const kept = keptByPart(parts.length, check.order, spans, check.seams);

  const cells: ConcatCell[] = [];
  const ids: string[] = [];
  const joints: ConcatJoint[] = [];
  check.order.forEach((pi, k) => {
    if (k > 0) {
      const s = check.seams[k - 1];
      joints.push({ index: cells.length, before: s.before, after: s.after, overlapMm: s.overlapMm, gapMm: s.gapMm });
    }
    const stack = parts[pi].layout.zStack(0, 0);
    // 位置の昇順に出す（レイアウトが降順でも、連結後は昇順に統一する）
    const zs = kept[pi].slice().sort((x, y) => poss[pi][x] - poss[pi][y] || x - y);
    for (const z of zs) {
      cells.push({ partIndex: pi, study: parts[pi].study, series: parts[pi].series, z });
      ids.push(stack[z]);
    }
  });

  const first = parts[check.order[0]].layout;
  const layout: SeriesLayout = {
    nZ: cells.length,
    nC: 1,
    nT: 1,
    zStack: () => ids,
    ippAt: (z) => {
      const c = cells[z];
      return c ? parts[c.partIndex].layout.ippAt?.(c.z) ?? null : null;
    },
    normal: first.normal ?? null,
  };
  return { ok: true, layout, cells, joints, check };
}

/** 連結して開いたタイルに渡すもの。各シリーズのレイアウトは開く前に取得・連結済みで、見出しと継ぎ目の表示に使う名前を添える。 */
export interface ConcatOpened {
  /** 選んだ順のシリーズ。MPR・3D・Slicer は ids の関数を持てない ctx に載せ、受け側でこれから連結を作り直す。 */
  parts: Array<{ study: Study; series: Series }>;
  layout: SeriesLayout;
  cells: ConcatCell[];
  joints: ConcatJoint[];
  /** `parts` の添字ごとの短い名前（例: 「#2 CT HeadNeck」）。 */
  labels: string[];
}

/** 隙間のある継ぎ目を含むか。含む連結では、スライスをまとめる処理（Slab）が撮っていない範囲を含んだ厚みになる。 */
export function concatHasGap(joints: ReadonlyArray<Pick<ConcatJoint, "gapMm">> | undefined): boolean {
  return !!joints && joints.some((j) => j.gapMm > 0);
}

/** 連結タイルの ID。選んだ順の各部分（範囲つきも）をそのままつなぐ。同じ組み合わせ・同じ順なら同じ ID。 */
export function concatTileId(parts: ReadonlyArray<{ study: string; series: string; range?: ZRange }>): string {
  return `concat|${parts.map((p) => tileIdFor(p.study, p.series, p.range)).join("+")}`;
}

export type InplaneGridResult =
  | { ok: true }
  | { ok: false; reason: "size" | "pixelSpacing" | "orientation" | "offset" };

/**
 * 連結する全シリーズの面内の格子（行列数・ピクセル間隔・向き・面内位置）が同じか。同じなら、連結後のスライス列を
 * そのまま 1 本のボリュームにできる（再サンプルしない）。
 *
 * <p>許容は「画像の端でのずれが最小ピクセル間隔の 1/100 以内」から導く。ピクセル間隔の差は全幅（長辺の画素数）、
 * 向きの成分の差は長辺の長さ、で効くので、それぞれ許容を割る。面内位置は行・列方向へ射影した IPP の差。
 * 最初のシリーズと比べる。値が不明（IPP なし）のときは同じとみなさず断る。
 */
export function sameInplaneGrid(parts: readonly ConcatPart[]): InplaneGridResult {
  if (parts.length < 2) return { ok: true };
  const a = parts[0];
  const finest = Math.min(a.pixelSpacing[0], a.pixelSpacing[1]);
  const tol = finest / 100;
  const longestPx = Math.max(a.rows, a.columns);
  const longestMm = Math.hypot((a.columns - 1) * a.pixelSpacing[1], (a.rows - 1) * a.pixelSpacing[0]);
  const ip0 = a.layout.ippAt?.(0) ?? null;
  for (const b of parts.slice(1)) {
    if (b.rows !== a.rows || b.columns !== a.columns) return { ok: false, reason: "size" };
    if (b.pixelSpacing.some((p, i) => Math.abs(p - a.pixelSpacing[i]) * longestPx > tol)) {
      return { ok: false, reason: "pixelSpacing" };
    }
    if (b.iop.some((x, i) => !(Math.abs(x - a.iop[i]) * longestMm <= tol))) return { ok: false, reason: "orientation" };
    const ip = b.layout.ippAt?.(0) ?? null;
    if (!ip0 || !ip) return { ok: false, reason: "offset" };
    const d = [ip[0] - ip0[0], ip[1] - ip0[1], ip[2] - ip0[2]];
    const along = (o: number) => d[0] * a.iop[o] + d[1] * a.iop[o + 1] + d[2] * a.iop[o + 2];
    if (!(Math.abs(along(0)) <= tol && Math.abs(along(3)) <= tol)) return { ok: false, reason: "offset" };
  }
  return { ok: true };
}

/** 取得したレイアウト DTO の判定用の値から {@link ConcatPart} を作る。不明な値（間隔 0・IOP なし・FoR なし）は埋めずに断る。 */
export function concatPartFromDto(
  src: { study: string; series: string; layout: SeriesLayout; patientId: string; modality: string; pet?: StitchPetInfo },
  dto: {
    imageOrientationPatient: readonly number[] | null;
    pixelSpacingRow: number;
    pixelSpacingCol: number;
    imageWidth: number;
    imageHeight: number;
    frameOfReferenceUID: string | null;
  },
): ConcatPart | { missing: "iop" | "pixelSpacing" | "size" } {
  if (!dto.imageOrientationPatient || dto.imageOrientationPatient.length < 6) return { missing: "iop" };
  if (!(dto.pixelSpacingRow > 0) || !(dto.pixelSpacingCol > 0)) return { missing: "pixelSpacing" };
  if (!(dto.imageWidth > 0) || !(dto.imageHeight > 0)) return { missing: "size" };
  return {
    study: src.study,
    series: src.series,
    layout: src.layout,
    iop: [...dto.imageOrientationPatient],
    pixelSpacing: [dto.pixelSpacingRow, dto.pixelSpacingCol],
    rows: dto.imageHeight,
    columns: dto.imageWidth,
    patientId: src.patientId,
    frameOfReferenceUid: dto.frameOfReferenceUID ?? "",
    modality: src.modality,
    pet: src.pet,
  };
}
