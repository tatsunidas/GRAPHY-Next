/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 同位相マスクの**計画づくり**（`fw/angio-design.md` §6.7・A16 Phase 2）。**純関数だけ**。
 *
 * <p>造影後（ライブ）の各フレームに、造影前（マスク）のどのフレームを当てるかを決め、
 * あわせて**マスクをどれだけずらして引くか**まで出す。画素は触らない——画像類似度が要るときは
 * `score` コールバックで外（Worker）から渡してもらう。
 *
 * <h3>🔴 残差シフトは追尾からただで出る</h3>
 * 追尾はフレームごとの変位 `(dx, dy)` を持っている。マスクフレーム `m` の解剖は `maskPos[m]` に
 * 在り、ライブフレーム `t` では `livePos[t]` に在るのだから、**引く前にマスクを
 * `livePos[t] − maskPos[m]` だけ動かせばよい**。別に位置合わせを走らせる必要が無い。
 * （2 ラン間の定数ずれ＝寝台や体位の差は `runOffset` として外から与える。同一ランなら 0。）
 *
 * <h3>🔴 対応付けは振幅＋向き（amplitude sorting）が主、位相は交差確認</h3>
 * 理由は `xaTracking.ts` の冒頭にある。ここでは両方を計算し、**食い違うフレームを
 * `phaseDisagreement` として出す**（どちらが正しいかは決めない。人に見せる）。
 */
import { matchByAmplitude, type MotionSignal } from "./xaTracking";

/** 1 本のランについて、対応付けに要るもの。 */
export interface RunTrack {
  /** 運動信号（px・**2 ラン間で同じ軸**で射影してあること）。 */
  s: Float64Array;
  sdot: Float64Array;
  /** 追尾した変位（参照フレームから）。残差シフトの算出に使う。 */
  dx: number[];
  dy: number[];
  /** フレームごとの追尾の当否。 */
  reliable: boolean[];
  /** 位相（交差確認用）。割り当てられていなければ null。 */
  phase: Float64Array | null;
}

export interface PhaseMaskOptions {
  /** 振幅で絞る候補の数（既定 3）。ここから `score` で 1 個に決める。 */
  k?: number;
  coverageTolerance?: number;
  velocityEpsFraction?: number;
  /** マスク run → ライブ run の定数ずれ [px]（同一ランなら省略）。 */
  runOffset?: { dx: number; dy: number };
  /**
   * 候補の画像類似度（大きいほど良い）。省略すると**振幅の順位のまま**決める。
   * 🔴 これを渡さないと「振幅は合うが絵は合わない」フレームを拾ったまま気付けない。
   */
  score?: (liveFrame: number, maskFrame: number, dx: number, dy: number) => number;
  /** マスクとして使ってよいフレーム（省略時は全部）。造影が入ったフレームを外すのに使う。 */
  usableMaskFrames?: readonly number[];
  /**
   * 範囲外のフレームを振幅の端へ丸めて当てる（既定 false）。詳細は
   * {@link ../xaTracking.MatchOptions#clampOutOfRange}。**自動同位相 DSA だけ true にする。**
   */
  clampOutOfRange?: boolean;
  /**
   * 🔑 **自分自身をマスク候補に入れてよいライブフレーム**（造影が入っていないもの）。
   *
   * <p>造影前のフレームにとって誤差ゼロのマスクは自分自身である。ただしそれを
   * **答えとして決め打つのではなく、候補に入れて `score` に決めさせる**——ZNCC は
   * 自己相関 1.0 ＝ 絶対最大なので、候補に入れば必ず勝つ。実測でも造影前のライブは
   * ZNCC 1.000 / 残差 0.000 で自分自身を選ぶ。
   *
   * <p>🔴 **`usableMaskFrames` とは別に持つ理由**: あちらは「他のフレームのマスクとして
   * 使ってよいか」の集合である。露出の立ち上がりのフレームは他人には悪いマスクだが、
   * 自分にとっては完璧——**フレームの性質ではなく、組み合わせの性質**なので分けてある。
   * （露出のずれで組み合わせを弾こうとしたが、実測でランプ↔プラトーとプラトー同士が
   * 重なり分離できなかった。だから集合として分けている。）
   *
   * <p>追尾が外れたフレームでも自分自身は当てられる（位置合わせが要らない）ので、
   * `reliable` の判定より**先**に効く。
   */
  selfMaskFrames?: readonly number[];
}

/** `"clamped"` は振幅の端へ丸めて当てたもの＝**外挿**。 */
export type PhaseMaskStatus = "ok" | "directionRelaxed" | "outOfRange" | "unreliable" | "clamped";

export interface PhaseMaskEntry {
  liveFrame: number;
  /** 当てるマスクフレーム。決められなければ null（**無理に当てない**）。 */
  maskFrame: number | null;
  /** 引く前にマスクをずらす量 [px]。 */
  dx: number;
  dy: number;
  /** 振幅の差 [px]。 */
  amplitudeDiff: number;
  /** `score` があるときの画像類似度。 */
  similarity: number | null;
  status: PhaseMaskStatus;
  /** 位相だけで選んだ場合のマスクフレーム（交差確認）。 */
  phaseMaskFrame: number | null;
  /** 位相の選択と振幅の選択の食い違い（位相の差・0〜0.5）。判定できなければ null。 */
  phaseDisagreement: number | null;
}

export interface PhaseMaskPlan {
  entries: PhaseMaskEntry[];
  summary: {
    ok: number;
    directionRelaxed: number;
    outOfRange: number;
    unreliable: number;
    /** 振幅の端へ丸めて当てた（外挿した）フレーム数。 */
    clamped: number;
    /** 振幅差の中央値 [px]。小さいほど位相が揃っている。 */
    medianAmplitudeDiff: number;
    /** 位相との食い違いが 0.2 を超えたフレーム数（心臓 DSA の文献で許容とされる値）。 */
    phaseDisagreements: number;
  };
}

/** 位相の円環距離（0〜0.5）。 */
function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

/** 心臓 DSA の文献で「許容できる位相差」とされている値。 */
export const PHASE_DISAGREEMENT_LIMIT = 0.2;

/**
 * 同位相マスクの計画を作る。
 *
 * <p>同一ラン内で使うときは `mask` と `live` に**同じ `RunTrack` を渡す**
 * （`usableMaskFrames` に造影到達前のフレームを入れる）。別ランなら別々に渡し、
 * `runOffset` に 2 本のランの定数ずれを与える。
 */
export function buildPhaseMaskPlan(
  mask: RunTrack,
  live: RunTrack,
  opts: PhaseMaskOptions = {},
): PhaseMaskPlan {
  const k = Math.max(1, Math.floor(opts.k ?? 3));
  const offX = opts.runOffset?.dx ?? 0;
  const offY = opts.runOffset?.dy ?? 0;
  const usable = opts.usableMaskFrames ? new Set(opts.usableMaskFrames) : null;

  // 使ってよいマスクフレームだけに絞った信号で照合する。
  // 🔴 絞らずに照合してから捨てると、「候補 k 個が全部使えないフレームだった」という
  //    穴が開く（振幅がいちばん近いのは往々にして造影の入ったフレーム＝直前の心拍）。
  const indices: number[] = [];
  for (let i = 0; i < mask.s.length; i++) {
    if (usable && !usable.has(i)) continue;
    if (!mask.reliable[i]) continue;
    indices.push(i);
  }

  const subSignal: Pick<MotionSignal, "s" | "sdot"> = {
    s: Float64Array.from(indices, (i) => mask.s[i]),
    sdot: Float64Array.from(indices, (i) => mask.sdot[i]),
  };
  const liveSignal: Pick<MotionSignal, "s" | "sdot"> = { s: live.s, sdot: live.sdot };

  const matches = indices.length
    ? matchByAmplitude(subSignal, liveSignal, {
        k,
        ...(opts.coverageTolerance != null ? { coverageTolerance: opts.coverageTolerance } : {}),
        ...(opts.velocityEpsFraction != null ? { velocityEpsFraction: opts.velocityEpsFraction } : {}),
        ...(opts.clampOutOfRange ? { clampOutOfRange: true } : {}),
      })
    : [];

  const selfOk = opts.selfMaskFrames ? new Set(opts.selfMaskFrames) : null;

  const entries: PhaseMaskEntry[] = [];
  for (let t = 0; t < live.s.length; t++) {
    const canSelf = selfOk?.has(t) ?? false;
    const m = matches[t];
    const base: PhaseMaskEntry = {
      liveFrame: t,
      maskFrame: null,
      dx: 0,
      dy: 0,
      amplitudeDiff: Number.NaN,
      similarity: null,
      status: "outOfRange",
      phaseMaskFrame: null,
      phaseDisagreement: null,
    };
    // 🔑 追尾が外れていても、自分自身なら当てられる（ずらす必要が無いので）。
    if (!live.reliable[t] && !canSelf) {
      entries.push({ ...base, status: "unreliable" });
      continue;
    }
    if (!canSelf && (!m || !m.candidates.length)) {
      entries.push(base);
      continue;
    }

    // 候補を（あれば）画像類似度で並べ替える。残差シフトは候補ごとに違うので毎回作る。
    // 🚨 **`maskFrame === t` だけでは「自分自身」にならない。** 2 ラン間では「マスク run の
    //    フレーム 5」と「ライブ run のフレーム 5」は別の画像である。`selfMaskFrames` は
    //    同一ラン内の自動経路でしか渡さないので、それを条件に入れる。
    const isSelf = (maskFrame: number): boolean => canSelf && maskFrame === t;
    const shiftFor = (maskFrame: number): { dx: number; dy: number } => ({
      // 自分自身はずらさない（`dsa.ts:shiftBilinear` は 0,0 で複製＝差は厳密に 0）。
      dx: isSelf(maskFrame) ? 0 : live.dx[t] - mask.dx[maskFrame] + offX,
      dy: isSelf(maskFrame) ? 0 : live.dy[t] - mask.dy[maskFrame] + offY,
    });

    // 候補の集合 = 振幅で選んだ k 個（＋ 自分自身が許されていればそれも）。
    const pool: { maskFrame: number; cost: number }[] = (m?.candidates ?? [])
      .map((c) => ({ maskFrame: indices[c.maskFrame], cost: c.cost }));
    if (canSelf && !pool.some((c) => c.maskFrame === t)) pool.push({ maskFrame: t, cost: 0 });
    pool.sort((a, b) => (a.cost - b.cost) || (a.maskFrame - b.maskFrame));

    let best = { maskFrame: pool[0].maskFrame, cost: pool[0].cost, similarity: null as number | null };
    if (opts.score) {
      let bestScore = -Infinity;
      for (const c of pool) {
        const sh2 = shiftFor(c.maskFrame);
        const sc = opts.score(t, c.maskFrame, sh2.dx, sh2.dy);
        if (sc > bestScore) {
          bestScore = sc;
          best = { maskFrame: c.maskFrame, cost: c.cost, similarity: sc };
        }
      }
    }
    const sh = shiftFor(best.maskFrame);

    // 交差確認: 位相だけで選ぶとどれになるか。
    let phaseMaskFrame: number | null = null;
    let phaseDisagreement: number | null = null;
    if (mask.phase && live.phase) {
      let bestD = Infinity;
      for (const i of indices) {
        const d = circularDistance(mask.phase[i], live.phase[t]);
        if (d < bestD) { bestD = d; phaseMaskFrame = i; }
      }
      if (phaseMaskFrame != null) {
        phaseDisagreement = circularDistance(mask.phase[phaseMaskFrame], mask.phase[best.maskFrame]);
      }
    }

    entries.push({
      liveFrame: t,
      maskFrame: best.maskFrame,
      dx: sh.dx,
      dy: sh.dy,
      amplitudeDiff: best.cost,
      similarity: best.similarity,
      status: isSelf(best.maskFrame)
        ? "ok"                       // 自分自身＝誤差ゼロ。外挿でも向きの緩和でもない。
        : m?.status === "clamped"
          ? "clamped"
          : m?.status === "directionRelaxed"
            ? "directionRelaxed"
            : "ok",
      phaseMaskFrame,
      phaseDisagreement,
    });
  }

  const diffs = entries.filter((e) => Number.isFinite(e.amplitudeDiff)).map((e) => e.amplitudeDiff).sort((a, b) => a - b);
  return {
    entries,
    summary: {
      ok: entries.filter((e) => e.status === "ok").length,
      directionRelaxed: entries.filter((e) => e.status === "directionRelaxed").length,
      outOfRange: entries.filter((e) => e.status === "outOfRange").length,
      unreliable: entries.filter((e) => e.status === "unreliable").length,
      clamped: entries.filter((e) => e.status === "clamped").length,
      medianAmplitudeDiff: diffs.length ? diffs[diffs.length >> 1] : Number.NaN,
      phaseDisagreements: entries.filter(
        (e) => e.phaseDisagreement != null && e.phaseDisagreement > PHASE_DISAGREEMENT_LIMIT,
      ).length,
    },
  };
}
