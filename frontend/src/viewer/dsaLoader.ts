/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DSA の合成画像を StackViewport へ供給するカスタムローダ（`fw/angio-design.md` §6.1）。
 *
 * <p>`graphy-thickslab:` と**同じ型**。差分そのものは {@link ./dsa} の純関数が計算し、
 * ここは「セッション管理」「Cornerstone への注入」「メタデータの委譲」だけを担う。
 *
 * <h3>メタデータの扱い</h3>
 * ネイティブフレームへ委譲するが、**`modalityLutModule` は恒等**にする。差分は既に
 * モダリティ値空間で完結しているので、GPU 側で Rescale を再適用させない
 * （ThickSlab と同じ罠。[[pixel-calibration-single-entry]]）。
 * `voiLutModule` はセッション作成時に差分のヒストグラムから決めた値を返す — 差分は 0 を
 * 中心とする符号付きなので、元画像の VOI（例 WC 2048 / WW 4096）をそのまま使うと真っ黒になる。
 */
import { metaData, registerImageLoader, utilities as csUtils } from "@cornerstonejs/core";
import { yieldEvery } from "./uiYield";
import { readModalitySlice } from "./pixelCalibration";
import {
  averageFrames,
  backgroundRms,
  contrastDropSignal,
  estimateShift,
  needsLogTransform,
  pickMaskFrames,
  subtractFrames,
  transformMask,
  type DsaOptions,
} from "./dsa";
import { xaDataSetOf } from "./xaCine";
import { robustSpread } from "./xaContrastOnset";
import { alignOnEdges, type EdgeAlignResult } from "./xaTracking";

const SCHEME = "graphy-dsa";

/** DICOM Mask Subtraction Module の読み取り結果（装置が書いた既定値）。 */
export interface XaDsaTags {
  /** PixelIntensityRelationship (0028,1040)。LOG / LIN。 */
  pixelIntensityRelationship: string | null;
  /** MaskFrameNumbers (0028,6110) を 0 origin にしたもの。 */
  maskFrames: number[] | null;
  /** MaskSubPixelShift (0028,6114)。DICOM は [row, column] なので {dy, dx} に読み替える。 */
  dx: number;
  dy: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * US（符号なし 16bit）の全要素を読む。
 *
 * 🚨 **`dataSet.string()` で読んではいけない**。`MaskFrameNumbers (0028,6110)` は VR=US の
 * **バイナリ**で、文字列として読むとバイト列がそのまま文字になり意味を成さない
 * （実データ〈Rubo の XA サンプル〉で発覚）。
 */
function readUS(ds: any, tag: string): number[] | null {
  const el = ds?.elements?.[tag];
  if (!el || !el.length) return null;
  const n = Math.floor(el.length / 2);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = ds.uint16(tag, i);
    if (typeof v === "number") out.push(v);
  }
  return out.length ? out : null;
}

/** FL（32bit 浮動小数）の全要素を読む。US と同じ理由で `string()` は使えない。 */
function readFL(ds: any, tag: string): number[] | null {
  const el = ds?.elements?.[tag];
  if (!el || !el.length) return null;
  const n = Math.floor(el.length / 4);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = ds.float(tag, i);
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out.length ? out : null;
}

/**
 * 装置が書いたサブトラクションの既定値を読む（`fw/angio-design.md` §6.3）。
 * 既定値として採用し、UI から上書きできるようにする。プリウォーム前は null。
 *
 * <p>⚠️ 実データでは <b>{@code MaskOperation = "NONE"}／{@code MaskFrameNumbers = 0}</b>
 * （0 は 1 origin として不正）という「シーケンスはあるが中身は空」の書かれ方が普通にある。
 * その場合は装置指定なしとして扱い、自動選択へ落とす。
 */
export function readXaDsaTags(imageId: string): XaDsaTags | null {
  const ds: any = xaDataSetOf(imageId);
  if (!ds) return null;
  const seqItem = ds.elements?.x00286100?.items?.[0]?.dataSet;
  const operation: string | undefined = seqItem?.string?.("x00286101");
  const usable = !!seqItem && (!operation || operation.trim().toUpperCase() !== "NONE");

  // MaskSubPixelShift は FL [row(=縦), column(=横)]。内部表現は {dx=横, dy=縦}。
  const shift = usable ? readFL(seqItem, "x00286114") : null;
  const dy = shift && Number.isFinite(shift[0]) ? shift[0] : 0;
  const dx = shift && Number.isFinite(shift[1]) ? shift[1] : 0;

  // MaskFrameNumbers は US、**1 origin**。0 以下は不正なので捨てる（実データに 0 が入っていた）。
  const rawFrames = usable ? readUS(seqItem, "x00286110") : null;
  const maskFrames = rawFrames ? rawFrames.filter((v) => v >= 1).map((v) => v - 1) : null;

  return {
    // PixelIntensityRelationship (0028,1040) は VR=CS なので文字列で正しい。
    pixelIntensityRelationship: ds.string?.("x00281040") ?? null,
    maskFrames: maskFrames && maskFrames.length ? maskFrames : null,
    dx,
    dy,
  };
}

/**
 * フレームごとのマスクと合わせ込み（**同位相マスク**・`fw/angio-design.md` §6.7）。
 *
 * <p>🔴 **画素を持たない。** マスクを Float32Array で持つと、1024²・150 フレームで 600MB を
 * 掴んだまま離さない器になる。持つのは**どのフレームを平均するか**だけで、画素は描画時に
 * `readModalitySlice`（＝Cornerstone のキャッシュ）から取り、直近ぶんだけ {@link maskCache} に置く。
 */
export interface DsaFramePlanEntry {
  /** マスクにするフレームの imageId（複数なら平均する）。**別ランでもよい**。 */
  maskImageIds: string[];
  /** 表示用の出自（マスク源のラン内での 0 origin フレーム番号）。 */
  maskFrames: number[];
  /** 引く前にマスクをずらす量 [px]（追尾した位置の差から出る）。 */
  dx: number;
  dy: number;
  /** 画像中心まわりに回す量 [度]（同位相マスクは回転を推定しないので通常は省略）。 */
  rotationDeg?: number;
  /**
   * エッジ ZNCC で求めた**残差**のずらし [px]。{@link DsaSession#autoAlign} が true のときだけ効く。
   *
   * <p>🔴 **`dx`/`dy` に足し込まない。** 足し込むと切り替えるたびに計算し直すことになる。
   * 別枠で持てばトグルは**即座**に効く（`optsAt()` が足すかどうかを変えるだけ）。
   */
  alignDx?: number;
  alignDy?: number;
  /**
   * 同じく**残差**の回転 [度]。{@link DsaSession#autoAlign} が true のときだけ効く。
   *
   * <p>🔴 **{@link DsaFramePlanEntry#rotationDeg} に入れない。** あちらは `optsAt()` が
   * 無条件に足す層なので、**トグルで切れない**（しかも誰も書いていない・§6.15.6）。
   * 残差はトグルで即座に外せる必要がある——回転は「片方にしか無いものを変形で埋めにいく」
   * 危うさがあるので、**外せることが要件**である（§6.17）。
   */
  alignRotationDeg?: number;
}

interface DsaSession {
  /** ネイティブフレームの imageId（t 昇順）。 */
  frameIds: string[];
  /** 平均してマスクにするフレーム（0 origin）。**ラン全体に効く既定のマスク**。 */
  maskFrames: number[];
  /** マスク平均（サイズ = width*height）。 */
  mask: Float32Array;
  width: number;
  height: number;
  logarithmic: boolean;
  /** ラン全体に効くピクセルシフト。 */
  dx: number;
  dy: number;
  /** ラン全体に効く回転 [度]。 */
  rotationDeg: number;
  /**
   * フレームごとの計画（同位相マスク）。`null` なら従来どおりラン全体で 1 組。
   * 要素が `null` のフレームは**既定のマスクに落ちる**（対応するマスクが見つからなかった等）。
   */
  framePlan: (DsaFramePlanEntry | null)[] | null;
  /** 計画の出自（UI に出す。例「このラン内」「ラン 2」）。 */
  framePlanLabel: string | null;
  /**
   * **あとから足したずらし**（フレームごと）。手で動かした分と、エッジ合わせで足した分の両方。
   * `null` なら無し。
   * 🔴 **計画の dx/dy とは別に持つ。** 混ぜると「計画を作り直したら手で直した分が消える」
   * （逆に、手で直した分を計画に焼き込むと、どこまでが自動でどこからが手かが分からなくなる）。
   */
  nudge: ({ dx: number; dy: number; rotationDeg: number } | null)[] | null;
  /**
   * 差分の一様オフセットを取り除くか（{@link DsaOptions#levelMatch}）。
   * 自動同位相の計画を入れたときに true になる。**既定経路は false のまま**。
   */
  levelMatch: boolean;
  /**
   * 🔴 **利用者が自分で切り替えたか。** true なら自動経路（計画の出し入れ・マスクの差し替え）は
   * もう触らない。以前はマスクを手で選ぶたびに黙って false へ戻っていて、
   * 「自分でマスクを選んだら先頭が明るくなった」という理由の読めない挙動になっていた（§6.15）。
   */
  levelMatchUserSet: boolean;
  /** 計画の `alignDx`/`alignDy` を足すか（利用者のトグル・既定 true）。 */
  autoAlign: boolean;
  /** 差分から決めた表示 VOI。 */
  voi: { windowCenter: number; windowWidth: number };
  /** 自動選択が判断した造影到達フレーム（UI の説明用）。 */
  onset: number | null;
}

/**
 * マスク平均の使い回し（直近ぶんだけ）。鍵は imageId の並びなので、セッションをまたいでも安全
 * （同じ imageId の組は同じ画素）。シネ再生では隣り合うフレームが同じマスクを共有することが
 * 多いので、数個あれば効く。
 */
const MASK_CACHE_MAX = 8;
const maskCache = new Map<string, Float32Array>();

const sessions = new Map<string, DsaSession>();
let seq = 0;

export interface DsaSessionParams {
  /** ネイティブフレームの imageId（t 昇順・全フレーム）。 */
  frameIds: string[];
  /** マスクフレーム。省略時は自動選択。 */
  maskFrames?: number[] | null;
  /** 対数変換（PixelIntensityRelationship = LIN のとき true）。 */
  pixelIntensityRelationship?: string | null;
  /** 初期ピクセルシフト（MaskSubPixelShift 由来）。 */
  dx?: number;
  dy?: number;
}

/**
 * **エッジ像で剛体合わせして、その分を足し込む**（`fw/angio-design.md` §6.7・Phase 3）。
 *
 * <p>合わせるのは「そのフレームに当たっているマスク」と「そのフレームのライブ」。求めた変換は
 * **オリジナルのマスクに当てて引く**（エッジ像は引かない）。
 *
 * <p>🔴 **足し込むのは「いま効いている分との差」である。** そうしないと、同位相マスクの計画が
 * 入っているフレームで二重にずれる。`scope` が `"from"` / `"all"` のときは、**このフレームで
 * 測った差をそのまま範囲へ効かせる**——1 枚で合わせて範囲に流すのは DSA のピクセルシフトの
 * 昔からの作法で、ここもそれに倣う（フレームごとに測り直したいなら `"current"` で 1 枚ずつ）。
 *
 * <p>🔴 **`autoAlignDsa`（背景 RMS 最小化）を置き換えない。** 輝度スケールが揃っているとき
 * （同一収集の体動補正）はあちらのほうが正確で、こちらは ZNCC なので `aI+b` に不変
 * ——**別の心拍・別のランから持ってきたマスク**に強い。用途で選ぶ（§6.7.4）。
 */
export async function alignDsaOnEdges(
  token: string,
  t: number,
  scope: DsaShiftScope,
  opts: { maxRotationDeg?: number } = {},
): Promise<EdgeAlignResult | null> {
  const s = sessions.get(token);
  if (!s) return null;
  const idx = Math.max(0, Math.min(s.frameIds.length - 1, t));
  const live = await readModalitySlice(s.frameIds[idx]);
  if (!live) return null;
  const mask = await maskAt(s, idx);
  if (!mask) return null;
  const result = alignOnEdges(mask, live.values, s.width, s.height, {
    logarithmic: s.logarithmic,
    ...(opts.maxRotationDeg ? { maxRotationDeg: opts.maxRotationDeg } : {}),
  });
  if (!result.reliable) return result; // 合ったふりをしない。足し込まずに理由ごと返す。
  const cur = optsAt(s, idx);
  nudgeDsaRigid(
    token,
    result.dx - cur.dx,
    result.dy - cur.dy,
    result.rotationDeg - (cur.rotationDeg ?? 0),
    scope,
    idx,
  );
  return result;
}

/** セッションの現在状態（UI 表示用）。 */
export interface DsaSessionState {
  /**
   * マスクフレーム。
   * 🔴 **同位相マスクが効いているときは「そのフレームに当たっているマスク」**を返す
   * （`framePlan` が true のとき）。H36 を読むプラグインは「いま見えている絵」を測るので、
   * ラン全体の既定を返すと出自を取り違える。
   */
  maskFrames: number[];
  onset: number | null;
  /** そのフレームに実際に効いているシフト（計画＋全体＋あとから足した分の合計）。 */
  dx: number;
  dy: number;
  /** 同じく、効いている回転 [度]。0 なら平行移動だけ。 */
  rotationDeg: number;
  logarithmic: boolean;
  /** 同位相マスク（フレームごとの計画）が効いているか。 */
  framePlan: boolean;
  /** 計画の出自（`framePlan` が false なら null）。 */
  framePlanLabel: string | null;
  /** 計画があるフレーム数（無いフレームは既定のマスクに落ちている）。 */
  framePlanCovered: number;
  /** 自動位置合わせ（エッジ ZNCC の残差）が効いているか。 */
  autoAlign: boolean;
  /** その残差が計算済みか（未計算ならトグルを出しても効かない）。 */
  autoAlignAvailable: boolean;
  /** 差分の一様オフセットを取り除いているか（{@link DsaOptions#levelMatch}）。 */
  levelMatch: boolean;
}

async function readFrames(ids: string[]): Promise<{ values: Float32Array[]; width: number; height: number } | null> {
  const slices = await Promise.all(ids.map((id) => readModalitySlice(id)));
  const values: Float32Array[] = [];
  let width = 0;
  let height = 0;
  for (const s of slices) {
    if (!s) return null;
    values.push(s.values);
    if (!width) {
      width = s.width;
      height = s.height;
    }
  }
  return width && height ? { values, width, height } : null;
}

/**
 * DSA セッションを用意する（マスク平均と表示 VOI をここで確定させる）。
 *
 * <p>**同期的にトークンだけ配らない**のは、マスク平均を作る前に描画が始まると
 * 「一瞬もとの画像が出てから差分に変わる」ちらつきになるため。UI は await してから切り替える。
 *
 * @returns セッショントークン（{@link dsaImageId} に渡す）。失敗時は null。
 */
export async function prepareDsaSession(params: DsaSessionParams): Promise<string | null> {
  const { frameIds } = params;
  if (frameIds.length < 2) return null;
  const logarithmic = needsLogTransform(params.pixelIntensityRelationship);

  // マスク候補の決定に全フレームの平均輝度が要る。フレーム数ぶん読むことになるが、
  // XA のフレームは既にローダのキャッシュに乗っている（同一ファイル＝1 回の HTTP）ので安い。
  const all = await readFrames(frameIds);
  if (!all) return null;
  const { values, width, height } = all;

  let maskFrames = params.maskFrames?.filter((i) => i >= 0 && i < values.length) ?? null;
  let onset: number | null = null;
  if (!maskFrames || maskFrames.length === 0) {
    // 🚨 **フレーム単独の暗部テールでは足りない**（骨が濃いと造影が埋もれる）。
    //    ラン先頭との差で見る（{@link contrastDropSignal} の警告）。
    const picked = pickMaskFrames(contrastDropSignal(values));
    maskFrames = picked.frames;
    onset = picked.onset;
  }
  const mask = averageFrames(maskFrames.map((i) => values[i]));
  if (!mask) return null;

  const dx = params.dx ?? 0;
  const dy = params.dy ?? 0;

  // 表示 VOI: 造影が最も濃いであろうフレーム（onset 以降の中間）で差分を作り、その分布から決める。
  const probeIdx = onset != null ? Math.min(values.length - 1, onset + Math.floor((values.length - onset) / 2)) : values.length - 1;
  const probe = subtractFrames(mask, values[probeIdx], width, height, { dx, dy, logarithmic });
  const voi = probe ? voiFromDiff(probe) : { windowCenter: 0, windowWidth: 1 };

  const token = `dsa${++seq}`;
  sessions.set(token, {
    frameIds, maskFrames, mask, width, height, logarithmic, dx, dy, rotationDeg: 0,
    framePlan: null, framePlanLabel: null, nudge: null,
    levelMatch: false, levelMatchUserSet: false, autoAlign: true, voi, onset,
  });
  return token;
}

/**
 * 差分画像の表示 VOI。中央値 ±3σ 相当（外れ値に強いようパーセンタイルで取る）。
 * 差分は 0 を中心とする符号付きなので、元画像の VOI をそのまま使ってはいけない。
 */
function voiFromDiff(diff: Float32Array): { windowCenter: number; windowWidth: number } {
  const sorted = Float32Array.from(diff).sort();
  const at = (q: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * q)))];
  const lo = at(0.02);
  const hi = at(0.98);
  const width = Math.max(hi - lo, 1e-6);
  return { windowCenter: (hi + lo) / 2, windowWidth: width };
}

/**
 * セッションの imageId。t は 0 origin のフレーム番号。
 *
 * <p>`version` は合成パラメータ（ピクセルシフト・マスク）の版番号。**imageId に混ぜる**ことで、
 * パラメータを変えたら別 imageId ＝ Cornerstone の画像キャッシュを避けて必ず再合成される
 * （ThickSlab のセッショントークンと同じ考え方）。
 */
export function dsaImageId(token: string, t: number, version = 0): string {
  return `${SCHEME}:${token}/${version}#${t}`;
}

/**
 * 合成 imageId（`graphy-dsa:`）→ その t が指す**ネイティブフレームの imageId**。
 * 合成でない／セッションが無いなら null。
 *
 * <p>🚨 これが要るのは、**合成 imageId には元の URL が入っていない**から。
 * DICOM タグを直接読む層（空間校正の解決など）は、合成のままだと**タグが 1 つも読めず
 * 「未校正」に見える**。実機で踏んだ: DSA 表示中に保存した GSPS に空間校正が入らず、
 * 解析ダイアログの校正欄も "—" になっていた（Cornerstone 側の計測は
 * このローダの metadata provider がネイティブへ委譲しているので mm のまま＝**気づけない**）。
 */
export function dsaNativeImageId(imageId: string): string | null {
  const parsed = parseDsaImageId(imageId);
  if (!parsed) return null;
  const s = sessions.get(parsed.token);
  if (!s) return null;
  const i = Math.max(0, Math.min(s.frameIds.length - 1, parsed.t));
  return s.frameIds[i] ?? null;
}

function parseDsaImageId(imageId: string): { token: string; t: number } | null {
  if (!imageId.startsWith(`${SCHEME}:`)) return null;
  const rest = imageId.slice(SCHEME.length + 1);
  const hash = rest.lastIndexOf("#");
  if (hash < 0) return null;
  const t = Number(rest.slice(hash + 1));
  if (!Number.isFinite(t)) return null;
  const head = rest.slice(0, hash);
  const slash = head.lastIndexOf("/");
  return { token: slash >= 0 ? head.slice(0, slash) : head, t };
}

/**
 * 合成 imageId → **いまの DSA の状態**（プラグイン host API の H36）。
 *
 * <p>合成でない（＝ネイティブフレームを表示している）なら null。
 *
 * <p>🔴 **これが無いと、プラグインは差分画像を非サブトラクションとして測ってしまう。**
 * 差分後は血管が**正の大きな値**になるので、エッジ検出の向き（`vesselIsDark`）も
 * プロファイルの意味（`profileDomain`）も反転する。合成 imageId は URL を持たないので、
 * プラグイン側では**見分けようがない**（`fw/angio-design.md` §22.3 の G2）。
 */
export function dsaStateForImageId(imageId: string): (DsaSessionState & { frameIndex: number; frameCount: number }) | null {
  const parsed = parseDsaImageId(imageId);
  if (!parsed) return null;
  const s = sessions.get(parsed.token);
  if (!s) return null;
  // 🔴 フレームを渡す。同位相マスクが効いていると、マスクもシフトもフレームごとに違う。
  //    H36 を読むプラグインは「いま見えている絵」を測るので、ラン全体の既定を返すと
  //    出自を取り違える（差分の極性やプロファイルの向きまで巻き添えになる）。
  const state = dsaSessionState(parsed.token, parsed.t);
  if (!state) return null;
  return { ...state, frameIndex: parsed.t, frameCount: s.frameIds.length };
}

/**
 * ラン全体に効くピクセルシフトを**絶対値で**置き換える（GSPS の復元・自動位置合わせが使う）。
 * imageId は変えないので、呼び出し側で画像キャッシュを捨てて再描画する。
 */
export function setDsaShift(token: string, dx: number, dy: number): void {
  const s = sessions.get(token);
  if (s) {
    s.dx = dx;
    s.dy = dy;
  }
}

/** ずらしを当てる範囲（`fw/angio-design.md` §6.4 の 3 択）。 */
export type DsaShiftScope = "all" | "current" | "from";

/**
 * 手でずらす（**足し込み**）。
 *
 * <p>🔴 **計画（同位相マスク）の dx/dy を書き換えない。** 手で直した分は別に持ち、合計して効かせる。
 * 混ぜると「計画を作り直したら手で直した分が消える」「どこまでが自動か分からない」のどちらかになる。
 *
 * @param scope `"all"` はラン全体 / `"current"` はそのフレームだけ / `"from"` はそのフレーム以降
 */
export function nudgeDsaShift(token: string, ddx: number, ddy: number, scope: DsaShiftScope, t: number): void {
  nudgeDsaRigid(token, ddx, ddy, 0, scope, t);
}

/** 手で回す（足し込み）。{@link nudgeDsaShift} と同じ層に載る。 */
export function nudgeDsaRotation(token: string, ddeg: number, scope: DsaShiftScope, t: number): void {
  nudgeDsaRigid(token, 0, 0, ddeg, scope, t);
}

/**
 * 平行移動と回転をまとめて足し込む。
 *
 * <p>🔴 **これは「剛体変換の合成」ではなく「パラメータの足し算」である。** 効くのは
 * 「合計の角度で画像中心まわりに回してから、合計の平行移動をする」1 つの剛体変換で、
 * 層ごとの変換を順に掛けたものとは（微小角以外では）一致しない。層を分けているのは
 * 出自を残すためで、幾何を合成するためではない——この読み替えを前提に UI も作ること。
 */
function nudgeDsaRigid(
  token: string,
  ddx: number,
  ddy: number,
  ddeg: number,
  scope: DsaShiftScope,
  t: number,
): void {
  const s = sessions.get(token);
  if (!s) return;
  if (scope === "all") {
    s.dx += ddx;
    s.dy += ddy;
    s.rotationDeg += ddeg;
    return;
  }
  if (!s.nudge) s.nudge = s.frameIds.map(() => null);
  const from = Math.max(0, Math.min(s.frameIds.length - 1, Math.floor(t)));
  const to = scope === "current" ? from : s.frameIds.length - 1;
  for (let i = from; i <= to; i++) {
    const cur = s.nudge[i] ?? { dx: 0, dy: 0, rotationDeg: 0 };
    s.nudge[i] = { dx: cur.dx + ddx, dy: cur.dy + ddy, rotationDeg: cur.rotationDeg + ddeg };
  }
}

/** 手で足した分だけを捨てる（計画と全体シフトは残す）。 */
export function clearDsaNudge(token: string): void {
  const s = sessions.get(token);
  if (s) s.nudge = null;
}

/**
 * **人が触った位置合わせを全部捨てる**（「ずらしを戻す」）。
 *
 * <p>消すのは**手動層**（フレームごとの `nudge`）と**ラン全体**（`dx`/`dy`/`rotationDeg`）の 2 つ。
 * 同位相マスクの計画（`framePlan` の `dx`/`dy`）と、その残差合わせ（`align*`）は**残る**
 * ——あれらは自動で決まった分なので、人の操作を取り消す道具で消すものではない。
 *
 * <p>🚨 **層を数える仕事を呼び出し側に残さない。** 以前はボタンが
 * `clearDsaNudge()` ＋ `setDsaShift(0, 0)` を並べて呼んでおり、**`rotationDeg` だけ
 * 消し忘れていた**（適用範囲「全部」で回した分が残る）。1 つの操作は 1 つの関数にする。
 */
export function resetDsaRigid(token: string): void {
  const s = sessions.get(token);
  if (!s) return;
  s.nudge = null;
  s.dx = 0;
  s.dy = 0;
  s.rotationDeg = 0;
}

/**
 * 同位相マスクの計画を入れる（`null` で外す）。
 *
 * <p>要素が `null` のフレームは**既定のマスクに落ちる**。「対応するマスクが見つからなかった」
 * フレームを黙って近いもので埋めないための逃がし方で、そのぶん UI には
 * 「何フレームが計画に載ったか」を出すこと（{@link DsaSessionState#framePlanCovered}）。
 */
export function setDsaFramePlan(
  token: string,
  plan: (DsaFramePlanEntry | null)[] | null,
  label: string | null,
): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  if (!plan) {
    s.framePlan = null;
    s.framePlanLabel = null;
    if (!s.levelMatchUserSet) s.levelMatch = false;
    return true;
  }
  if (plan.length !== s.frameIds.length) return false;
  s.framePlan = plan;
  s.framePlanLabel = label;
  // 🔴 計画が入るときだけレベル合わせを効かせる（既定経路の数値は動かさない・§5-F）。
  if (!s.levelMatchUserSet) s.levelMatch = true;
  return true;
}

/**
 * エッジ ZNCC で求めた残差を計画へ**別枠で**入れる。長さは計画と同じであること。
 * 既に計画が入っていなければ何もしない（計画なしに残差だけ足しても意味がない）。
 */
export function setDsaFrameAlignments(
  token: string,
  align: ({ dx: number; dy: number; rotationDeg?: number } | null)[],
): boolean {
  const s = sessions.get(token);
  if (!s?.framePlan || align.length !== s.framePlan.length) return false;
  for (let t = 0; t < align.length; t++) {
    const e = s.framePlan[t];
    const a = align[t];
    if (!e) continue;
    if (a) {
      e.alignDx = a.dx;
      e.alignDy = a.dy;
      if (a.rotationDeg) e.alignRotationDeg = a.rotationDeg;
      else delete e.alignRotationDeg;
    } else {
      delete e.alignDx;
      delete e.alignDy;
      delete e.alignRotationDeg;
    }
  }
  return true;
}

/**
 * 差分の一様オフセットの除去を切り替える（{@link DsaOptions#levelMatch}）。
 *
 * <p>🔴 **計画が作れなくても要る。** 露出の立ち上がりは計画の有無と関係なく存在するので、
 * 「造影前フレームの平均をマスクにした」時点で効かせないと、**先頭の数フレームだけ
 * 一様に明るい／暗い**絵のまま残る（実機で利用者が最初に気づいた症状）。
 */
export function setDsaLevelMatch(token: string, on: boolean, source: "user" | "auto" = "user"): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  // 🔴 自動経路は、利用者が自分で決めたあとは触らない。
  if (source === "auto" && s.levelMatchUserSet) return true;
  s.levelMatch = on;
  if (source === "user") s.levelMatchUserSet = true;
  return true;
}

/**
 * 造影到達フレームを更新する（§6.15）。
 *
 * <p>🔴 **セッション作成時の `onset` は当てにならない。** `prepareDsaSession` は
 * ①DICOM の `MaskFrameNumbers` が与えられていれば **onset を計算しない（null のまま）**
 * ②無ければ旧検出器 `pickMaskFrames` で決める、という 2 択で、どちらも §6.10.2 の
 * 「暗化画素の割合で手前へ戻す」絞り込みを通っていない。
 *
 * <p>自動同位相は正しい `contrastStart` を持っているのに**書き戻す口が無かった**ため、
 * 診断ダイアログには「造影到達が決まっていない」と出て、**同位相マスクを作るボタンが
 * 押せないまま**だった（実機で踏んだ）。
 */
export function setDsaOnset(token: string, onset: number | null): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  s.onset = onset != null && onset > 0 && onset < s.frameIds.length ? onset : null;
  return true;
}

/** 自動位置合わせ（計画の残差）を効かせるか。切り替えは**即座**——再計算はしない。 */
export function setDsaAutoAlign(token: string, on: boolean): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  s.autoAlign = on;
  return true;
}

/** そのフレームに効いている剛体パラメータ（計画＋全体＋あとから足した分）。 */
function optsAt(s: DsaSession, t: number): DsaOptions {
  const plan = s.framePlan?.[t] ?? null;
  const n = s.nudge?.[t] ?? null;
  const alignDx = s.autoAlign ? plan?.alignDx ?? 0 : 0;
  const alignDy = s.autoAlign ? plan?.alignDy ?? 0 : 0;
  const alignRot = s.autoAlign ? plan?.alignRotationDeg ?? 0 : 0;
  const rotationDeg = (plan?.rotationDeg ?? 0) + alignRot + s.rotationDeg + (n?.rotationDeg ?? 0);
  return {
    dx: (plan?.dx ?? 0) + alignDx + s.dx + (n?.dx ?? 0),
    dy: (plan?.dy ?? 0) + alignDy + s.dy + (n?.dy ?? 0),
    logarithmic: s.logarithmic,
    // 0 のときは `subtractFrames` が {@link shiftBilinear} をそのまま通る（既存の数値を動かさない）。
    ...(rotationDeg ? { rotationDeg } : {}),
    ...(s.levelMatch ? { levelMatch: true } : {}),
  };
}

/** そのフレームに当てるマスク（計画があればそれ、無ければ既定）。 */
async function maskAt(s: DsaSession, t: number): Promise<Float32Array | null> {
  const plan = s.framePlan?.[t] ?? null;
  if (!plan || !plan.maskImageIds.length) return s.mask;
  const key = plan.maskImageIds.join("|");
  const hit = maskCache.get(key);
  if (hit) {
    // LRU: 触ったものを末尾へ。
    maskCache.delete(key);
    maskCache.set(key, hit);
    return hit;
  }
  const read = await readFrames(plan.maskImageIds);
  if (!read) return s.mask;
  const avg = read.values.length === 1 ? read.values[0] : averageFrames(read.values);
  if (!avg || avg.length !== s.mask.length) return s.mask;
  maskCache.set(key, avg);
  while (maskCache.size > MASK_CACHE_MAX) {
    const oldest = maskCache.keys().next().value;
    if (oldest === undefined) break;
    maskCache.delete(oldest);
  }
  return avg;
}

/** マスクフレームを差し替える（自動選択を人が直すとき）。 */
export function setDsaMaskFrames(token: string, frames: number[]): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  const valid = frames.filter((i) => i >= 0 && i < s.frameIds.length);
  if (!valid.length) return false;
  // マスク平均を作り直すために、対象フレームだけ読み直す（キャッシュ済みなので安い）。
  s.maskFrames = valid;
  // 🔴 ラン全体のマスクを人が指定したなら、それが最後の意思表示。**同位相マスクの計画は外す**
  //    （残すと「指定したのに絵が変わらないフレームがある」になり、理由が画面から読めない）。
  s.framePlan = null;
  s.framePlanLabel = null;
  // 🔴 **利用者が自分で決めた分は消さない（§6.15）。** 露出の立ち上がりはマスクの選び方と
  //    関係なく存在するので、マスクを差し替えたからといって勝手に off に戻してはいけない。
  if (!s.levelMatchUserSet) s.levelMatch = false;
  return true;
}

/** マスク平均を作り直す（{@link setDsaMaskFrames} の後に呼ぶ）。 */
export async function rebuildDsaMask(token: string): Promise<boolean> {
  const s = sessions.get(token);
  if (!s) return false;
  const read = await readFrames(s.maskFrames.map((i) => s.frameIds[i]));
  if (!read) return false;
  const mask = averageFrames(read.values);
  if (!mask) return false;
  s.mask = mask;
  return true;
}

/** 現在のシフトでの背景 RMS を測る（UI に数値で出し、目視でなく数値で判断できるようにする）。 */
/** {@link dsaFramePair} の戻り。 */
export interface DsaFramePair {
  /** 🔴 **実際に引かれる形**のマスク（シフト・回転・残差合わせを当てたあと）。 */
  mask: Float32Array;
  /** 引かれる側。 */
  live: Float32Array;
  /** `subtractFrames` の結果そのもの。 */
  diff: Float32Array;
  width: number;
  height: number;
  /** マスクの出自（何番のフレームを平均したか）。計画が無ければラン既定のマスクフレーム。 */
  maskFrames: number[];
  dx: number;
  dy: number;
  rotationDeg: number;
  levelMatch: boolean;
  logarithmic: boolean;
  /** 差分の表示窓（**フレームごとに自動調整しないため**にセッションのものを使う）。 */
  voi: { windowCenter: number; windowWidth: number };
}

/**
 * そのフレームで**実際に引かれているマスクと、引かれる側と、その結果**を返す（§6.18）。
 *
 * <p>🔑 診断ダイアログが絵を出すためのもの。**新しい計算はしていない**——
 * `maskAt()`（計画があればその平均・無ければラン既定）と `optsAt()`（計画＋全体＋手動＋残差の
 * 合計）と `subtractFrames()` をそのまま通す。
 *
 * <p>🔴 **ここで別の計算を書いてはいけない。** 画面のマスクと実際に引かれたマスクがずれた
 * 瞬間、診断が嘘をつく。変換の定義は `dsa.ts` の {@link transformMask} 1 箇所にある。
 */
export async function dsaFramePair(token: string, t: number): Promise<DsaFramePair | null> {
  const s = sessions.get(token);
  if (!s) return null;
  const idx = Math.max(0, Math.min(s.frameIds.length - 1, t));
  const live = await readModalitySlice(s.frameIds[idx]);
  if (!live) return null;
  const raw = await maskAt(s, idx);
  if (!raw) return null;
  const opts = optsAt(s, idx);
  const mask = transformMask(raw, s.width, s.height, opts);
  const diff = subtractFrames(raw, live.values, s.width, s.height, opts);
  if (!diff) return null;
  const plan = s.framePlan?.[idx] ?? null;
  return {
    mask,
    live: live.values,
    diff,
    width: s.width,
    height: s.height,
    maskFrames: plan?.maskFrames?.length ? [...plan.maskFrames] : [...s.maskFrames],
    dx: opts.dx,
    dy: opts.dy,
    rotationDeg: opts.rotationDeg ?? 0,
    levelMatch: !!opts.levelMatch,
    logarithmic: opts.logarithmic,
    voi: { ...s.voi },
  };
}

export async function measureDsaResidual(token: string, t: number): Promise<number | null> {
  const s = sessions.get(token);
  if (!s) return null;
  const idx = Math.max(0, Math.min(s.frameIds.length - 1, t));
  const live = await readModalitySlice(s.frameIds[idx]);
  if (!live) return null;
  const mask = await maskAt(s, idx);
  if (!mask) return null;
  const diff = subtractFrames(mask, live.values, s.width, s.height, optsAt(s, idx));
  return diff ? backgroundRms(diff) : null;
}

/** {@link robustResidual} が見る画素の間引き。512² を 4 画素おきで 16k サンプル。 */
const RESIDUAL_STRIDE = 4;
/** コリメータ際を外すための下限（視野の代表値に対する比）。`xaContrastOnset` と同じ考え方。 */
const RESIDUAL_FLOOR_FRACTION = 0.02;

/**
 * 差分画像の**背景の散らばり**（MAD × 1.4826）。
 *
 * <p>🚨 **コリメータの外とその際を外す。** 外は 0 で埋まっており、際の 1 カウント画素は
 * 対数域で桁違いの差を作る（`xaContrastOnset` の `FIELD_FLOOR_FRACTION` と同じ罠）。
 * 視野かどうかは**ライブ側の画素**で決める（差分は 0 付近なので判定に使えない）。
 */
function robustResidual(diff: Float32Array, live: Float32Array): number {
  const lit: number[] = [];
  for (let i = 0; i < live.length; i += RESIDUAL_STRIDE) if (live[i] > 0) lit.push(live[i]);
  if (!lit.length) return Number.NaN;
  lit.sort((a, b) => a - b);
  const med = lit[lit.length >> 1];
  const floor = Math.max(1, med * RESIDUAL_FLOOR_FRACTION);

  const v: number[] = [];
  for (let i = 0; i < diff.length && i < live.length; i += RESIDUAL_STRIDE) {
    if (!(live[i] > floor)) continue;
    v.push(diff[i]);
  }
  if (v.length < 4) return Number.NaN;
  const sorted = Float64Array.from(v).sort();
  const h = sorted.length >> 1;
  const center = sorted.length % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2;
  // `robustSpread` は中央値を引いた列を前提にしている。
  return robustSpread(Float64Array.from(v, (x) => x - center));
}

/**
 * **全フレームの「合っていなさ」**を測る（DSA 診断・`fw/angio-design.md` §6.14）。
 *
 * <h3>🚨 RMS ではなく MAD で測る</h3>
 * 実測（§6.12・`0009.DCM` のライブ 81 に対しマスクを総当たり）で、
 * **RMS は血管そのものに支配されて** 0.267〜0.297 と 11% しか動かないのに対し、
 * ロバストな散らばり（MAD）は **0.091〜0.242** ときれいに分かれた。
 * 見たいのは造影の濃さではなく**背景が合っていないこと**なので、MAD を使う。
 *
 * <p>🔑 **造影前は自己差分なので 0 になるはず。** そこが 0 でなければ何かおかしい——
 * このグラフはそれ自体が健全性の確認になる。
 *
 * <p>マスクはフレームごとに違いうるので {@link maskAt} を都度引く（LRU が効く）。
 * 画素は Cornerstone のキャッシュに載っているので読み直しは安い。
 */
export async function measureDsaResidualAll(
  token: string,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<number[] | null> {
  const s = sessions.get(token);
  if (!s) return null;
  const n = s.frameIds.length;
  const out: number[] = new Array(n).fill(Number.NaN);
  for (let t = 0; t < n; t++) {
    if (isCancelled?.()) return null;
    onProgress?.(t, n);
    // 🚨 **描き直す隙を作る。** 画像がキャッシュ済みだと await が microtask で解決し、
    //    ループが終わるまで画面が 1 度も更新されない（進捗バーが出ない・§6.16）。
    await yieldEvery(t);
    const live = await readModalitySlice(s.frameIds[t]);
    if (!live) continue;
    const mask = await maskAt(s, t);
    if (!mask) continue;
    const diff = subtractFrames(mask, live.values, s.width, s.height, optsAt(s, t));
    if (!diff) continue;
    out[t] = robustResidual(diff, live.values);
  }
  onProgress?.(n, n);
  return out;
}

/** ピクセルシフトを自動推定して適用する。戻り値は推定結果。 */
export async function autoAlignDsa(
  token: string,
  t: number,
  scope: DsaShiftScope = "all",
): Promise<{ dx: number; dy: number; rms: number } | null> {
  const s = sessions.get(token);
  if (!s) return null;
  const idx = Math.max(0, Math.min(s.frameIds.length - 1, t));
  const live = await readModalitySlice(s.frameIds[idx]);
  if (!live) return null;
  const mask = await maskAt(s, idx);
  if (!mask) return null;
  const best = estimateShift(mask, live.values, s.width, s.height, s.logarithmic);
  // 🔑 **適用範囲は {@link alignDsaOnEdges} と同じ規則にする。** 画面では 3 択（全部/以降/
  //    このフレーム）がこの 2 つのボタンの間にあるのに、こちらだけ常にラン全体へ書いていた。
  //    いま効いている量との**差分**を足すので、二重には掛からない。
  const cur = optsAt(s, idx);
  nudgeDsaRigid(token, best.dx - cur.dx, best.dy - cur.dy, 0, scope, idx);
  return best;
}

/**
 * セッションの現在状態（UI 表示用）。
 *
 * @param t どのフレームについて答えるか。同位相マスクが効いているとフレームごとに
 *          マスクもシフトも違うので、**フレームを指定しないと嘘になる**。省略時は
 *          既定のマスクとラン全体のシフトを返す（計画が無いときは従来と同じ値）。
 */
export function dsaSessionState(token: string, t?: number): DsaSessionState | null {
  const s = sessions.get(token);
  if (!s) return null;
  const covered = s.framePlan ? s.framePlan.filter((e) => e != null).length : 0;
  const idx = t == null ? null : Math.max(0, Math.min(s.frameIds.length - 1, Math.floor(t)));
  const plan = idx == null ? null : s.framePlan?.[idx] ?? null;
  const o: DsaOptions = idx == null
    ? { dx: s.dx, dy: s.dy, logarithmic: s.logarithmic, ...(s.rotationDeg ? { rotationDeg: s.rotationDeg } : {}) }
    : optsAt(s, idx);
  return {
    maskFrames: plan ? [...plan.maskFrames] : [...s.maskFrames],
    onset: s.onset,
    dx: o.dx,
    dy: o.dy,
    rotationDeg: o.rotationDeg ?? 0,
    logarithmic: s.logarithmic,
    framePlan: s.framePlan != null,
    framePlanLabel: s.framePlanLabel,
    framePlanCovered: covered,
    autoAlign: s.autoAlign,
    autoAlignAvailable: s.framePlan?.some((e) => e?.alignDx != null) ?? false,
    levelMatch: s.levelMatch,
  };
}

/**
 * いま効いている計画（フレームごとに何を引いているか）。無ければ null。
 * 🔑 診断表示の**唯一の真実**——`AutoPhaseResult.plan` は自動が作ったものであって、
 * 人が手で入れ直した計画は反映されない。
 */
export function dsaFramePlan(token: string): (DsaFramePlanEntry | null)[] | null {
  const s = sessions.get(token);
  if (!s?.framePlan) return null;
  return s.framePlan.map((e) => (e ? { ...e, maskImageIds: [...e.maskImageIds], maskFrames: [...e.maskFrames] } : null));
}

/** 対数変換の ON/OFF を切り替える（装置が LOG/LIN を書いていない時の手動切替）。 */
export function setDsaLogarithmic(token: string, logarithmic: boolean): void {
  const s = sessions.get(token);
  if (s) s.logarithmic = logarithmic;
}

/** セッションを破棄する（シリーズ切替・DSA OFF）。 */
export function releaseDsaSession(token: string): void {
  sessions.delete(token);
  // 誰も使っていないなら、マスク平均を握ったままにしない（1 枚 4MB 級）。
  if (sessions.size === 0) maskCache.clear();
}

/** 合成画像の IImage を組み立てる（cache への put は cornerstone 側が行う）。 */
async function computeDsaImage(imageId: string): Promise<Record<string, unknown>> {
  const parsed = parseDsaImageId(imageId);
  if (!parsed) throw new Error(`dsa: bad imageId ${imageId}`);
  const s = sessions.get(parsed.token);
  if (!s) throw new Error(`dsa: session not found (${parsed.token})`);

  const idx = Math.max(0, Math.min(s.frameIds.length - 1, parsed.t));
  const nativeId = s.frameIds[idx];
  const live = await readModalitySlice(nativeId);
  if (!live) throw new Error("dsa: no pixel data");
  const mask = await maskAt(s, idx);
  if (!mask) throw new Error("dsa: no mask");
  const diff = subtractFrames(mask, live.values, s.width, s.height, optsAt(s, idx));
  if (!diff) throw new Error("dsa: size mismatch");

  let minPixelValue = Infinity;
  let maxPixelValue = -Infinity;
  for (let i = 0; i < diff.length; i++) {
    const v = diff[i];
    if (v < minPixelValue) minPixelValue = v;
    if (v > maxPixelValue) maxPixelValue = v;
  }
  if (!Number.isFinite(minPixelValue)) {
    minPixelValue = 0;
    maxPixelValue = 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plane: any = metaData.get("imagePlaneModule", nativeId) ?? {};
  const voxelManager = csUtils.VoxelManager.createImageVoxelManager({
    width: s.width,
    height: s.height,
    scalarData: diff,
    numberOfComponents: 1,
    id: imageId,
  });

  return {
    imageId,
    referencedImageId: nativeId,
    dataType: "Float32Array",
    color: false,
    rgba: false,
    numberOfComponents: 1,
    slope: 1,
    intercept: 0,
    windowCenter: s.voi.windowCenter,
    windowWidth: s.voi.windowWidth,
    minPixelValue,
    maxPixelValue,
    rows: s.height,
    columns: s.width,
    height: s.height,
    width: s.width,
    columnPixelSpacing: Number(plane.columnPixelSpacing) || undefined,
    rowPixelSpacing: Number(plane.rowPixelSpacing) || undefined,
    invert: false,
    getPixelData: () => voxelManager.getScalarData(),
    getCanvas: undefined,
    voxelManager,
    sizeInBytes: diff.byteLength,
  };
}

let registered = false;

/** ローダとメタデータプロバイダを登録する。冪等。cornerstone 初期化時に呼ぶ。 */
export function registerDsaLoader(): void {
  if (registered) return;
  registered = true;

  registerImageLoader(SCHEME, (imageId: string) => ({
    promise: computeDsaImage(imageId),
  }));

  metaData.addProvider((type: string, ...query: string[]): unknown => {
    const parsed = parseDsaImageId(query[0]);
    if (!parsed) return undefined;
    const s = sessions.get(parsed.token);
    if (!s) return undefined;
    const nativeId = s.frameIds[Math.max(0, Math.min(s.frameIds.length - 1, parsed.t))];

    if (type === "modalityLutModule") {
      // 差分は既に値空間で完結。GPU 側 Modality LUT は恒等にして二重適用を防ぐ。
      return { rescaleSlope: 1, rescaleIntercept: 0 };
    }
    if (type === "voiLutModule") {
      // 差分は 0 を中心とする符号付き。元画像の VOI を使うと真っ黒になる。
      return { windowCenter: [s.voi.windowCenter], windowWidth: [s.voi.windowWidth] };
    }
    return metaData.get(type, nativeId);
  }, 11000);
}
