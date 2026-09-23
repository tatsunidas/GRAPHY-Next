/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA 自動追尾の Web Worker（`fw/angio-design.md` §6.7）。
 *
 * <p>🔴 **DSA 本体がメインスレッドのままなのは既知の負債**（設計 §6.1 は Worker を想定していた）。
 * こちらは全フレームにぼかしと Sobel を掛けるので、最初から Worker に置く。
 *
 * <p>状態は持たない。`fourierWorker.ts` がスペクトルを保持するのは「同じスペクトルに何度も
 * フィルタを掛ける」からで、こちらは **ROI が変われば前処理の使い回しはその 1 回の中で閉じる**
 * （`prepareFrames` が担う）。保持すると 100MB 級の画素を掴んだまま離さない器になる。
 */
import { shiftBilinear } from "./dsa";
import { buildPhaseMaskPlan, type RunTrack } from "./xaPhaseMask";
import { contrastBounds, contrastMask, matchByBackground, packGradients } from "./xaPhaseMatch";
import {
  alignOnEdges,
  amplitudeSpan,
  estimatePeriod,
  assignPhase,
  motionSignal,
  prepareFrames,
  suggestTrackingRois,
  trackPrepared,
  trackTemplate,
  znccPrepared,
} from "./xaTracking";
import type {
  PackedFrames,
  XaTrackingWorkerRequest,
  XaTrackingWorkerResponse,
} from "./xaTrackingProtocol";

function post(res: XaTrackingWorkerResponse, transfer: ArrayBufferLike[] = []): void {
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(res, transfer as Transferable[]);
}

/** 連結した 1 本を、コピーせずにフレームごとの view へ切り分ける。 */
function unpack(p: PackedFrames): Float32Array[] {
  const size = p.width * p.height;
  const out: Float32Array[] = [];
  for (let t = 0; t < p.frameCount; t++) out.push(p.values.subarray(t * size, (t + 1) * size));
  return out;
}

self.onmessage = (ev: MessageEvent<XaTrackingWorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === "suggest") {
      const frames = unpack(req.frames);
      // 🚨 ここで落としたほうがメッセージが具体的になる（§6.15）。
      if (req.frameStartTimesMs?.length && req.frameStartTimesMs.length !== req.frames.frameCount) {
        throw new Error(
          `suggest: frameStartTimesMs length ${req.frameStartTimesMs.length} !== frames ${req.frames.frameCount}`,
        );
      }
      const candidates = suggestTrackingRois(frames, req.frames.width, req.frames.height, {
        tileSize: req.tileSize,
        ...(req.tileSizes?.length ? { tileSizes: req.tileSizes } : {}),
        // 🚨 **stride は渡さない。** 1 つに固定すると、小さいタイルが大きいタイルの格子に
        //    縛られて置きたい場所に置けない。実機で、心拍を運ぶ 48px タイル (96,144) は
        //    y=144 が 32 の倍数でないために**候補にすら挙がらなかった**。
        //    `suggestTrackingRois` はサイズごとに tileSize/2 を使う。
        referenceFrame: req.referenceIndex,
        logarithmic: req.logarithmic,
        maxCandidates: req.maxCandidates,
        ...(req.frameStartTimesMs?.length ? { frameStartTimesMs: req.frameStartTimesMs } : {}),
        ...(req.shortlist ? { shortlist: req.shortlist } : {}),
      });
      post({ type: "suggestDone", requestId: req.requestId, candidates });
      return;
    }

    if (req.type === "match") {
      const liveFrames = unpack(req.live);
      const maskPacked = req.mask ?? req.live;
      const maskFrames = req.mask ? unpack(req.mask) : liveFrames;
      const w = req.live.width;
      const h = req.live.height;
      if (maskPacked.width !== w || maskPacked.height !== h) {
        throw new Error("match: crop size mismatch");
      }

      const livePrep = prepareFrames(liveFrames, w, h, {
        referenceFrame: req.liveReference,
        logarithmic: req.logarithmic,
      });
      const maskPrep = req.mask
        ? prepareFrames(maskFrames, w, h, { referenceFrame: req.maskReference, logarithmic: req.logarithmic })
        : livePrep;

      const liveTrack = trackPrepared(livePrep, req.roi, { searchRadius: req.searchRadius });
      const maskTrack = req.mask
        ? trackPrepared(maskPrep, req.roi, { searchRadius: req.searchRadius })
        : liveTrack;

      // 2 ラン間で振幅を比べるので、**軸はマスク側で決めてライブへ渡す**。
      // 🔴 **デトレンドの方式と窓も同じく渡す（§6.15）。** ラン長が 3 秒の境界をまたぐと
      //    片方が移動平均・片方が線形になり、残る振幅の定義が違うので amplitude sorting の
      //    前提（2 ランの px が比較できる）が壊れる。
      const maskSignal = motionSignal(maskTrack, req.maskTimesMs);
      const liveSignal = motionSignal(liveTrack, req.liveTimesMs, {
        axis: maskSignal.axis,
        detrendMode: maskSignal.detrendMode,
        ...(maskSignal.detrendMode === "movingAverage"
          ? { detrendWindowFrames: maskSignal.detrendWindowFrames }
          : {}),
      });
      const maskPeriod = estimatePeriod(maskSignal.s, req.maskTimesMs);
      const livePeriod = estimatePeriod(liveSignal.s, req.liveTimesMs);
      const maskPhase = assignPhase(maskSignal.s, req.maskTimesMs, maskPeriod.periodFrames);
      const livePhase = assignPhase(liveSignal.s, req.liveTimesMs, livePeriod.periodFrames);

      // ラン間の定数ずれ（寝台・体位）。参照フレームどうしを 1 回だけ合わせて出す。
      // 同一ランなら定義上 0。
      let runOffset = { dx: 0, dy: 0 };
      if (req.mask) {
        const pair = trackTemplate(
          [maskFrames[Math.min(req.maskReference, maskFrames.length - 1)], liveFrames[Math.min(req.liveReference, liveFrames.length - 1)]],
          w,
          h,
          req.roi,
          { searchRadius: req.searchRadius, logarithmic: req.logarithmic },
        );
        if (pair.frames[1]?.reliable) runOffset = { dx: pair.frames[1].dx, dy: pair.frames[1].dy };
      }

      const asRunTrack = (
        track: typeof liveTrack,
        signal: typeof liveSignal,
        phase: typeof livePhase,
      ): RunTrack => ({
        s: signal.s,
        sdot: signal.sdot,
        dx: track.frames.map((f) => f.dx),
        dy: track.frames.map((f) => f.dy),
        reliable: track.frames.map((f) => f.reliable),
        phase: phase.reliable ? phase.phase : null,
      });

      const plan = buildPhaseMaskPlan(
        asRunTrack(maskTrack, maskSignal, maskPhase),
        asRunTrack(liveTrack, liveSignal, livePhase),
        {
          k: req.k,
          runOffset,
          usableMaskFrames: req.usableMaskFrames,
          ...(req.clampOutOfRange ? { clampOutOfRange: true } : {}),
          ...(req.selfMaskFrames ? { selfMaskFrames: req.selfMaskFrames } : {}),
          // 🔴 候補は振幅で k 個に絞ったあと**画像で 1 個に決める**。
          //    znccPrepared は「a の ROI を、b を (dx,dy) ずらした窓と比べる」ので、
          //    マスクを +d 動かして合わせる計画に対しては **−d** を渡す。
          score: (liveFrame, maskFrame, dx, dy) =>
            znccPrepared(livePrep, liveFrame, maskPrep, maskFrame, req.roi, -dx, -dy),
        },
      );

      // 🔴 マスク側の振幅の広がり。**これが小さいと振幅で並べ替えても意味が無い**ので、
      //    呼び出し側が判断できるよう必ず返す（実機で 0.49px＝追尾ノイズのまま走っていた）。
      const maskAmplitudeSpan = amplitudeSpan(maskSignal.s, req.usableMaskFrames);

      post({
        type: "matchDone",
        requestId: req.requestId,
        maskAmplitudeSpan,
        // 🔑 診断用。**捨てずに返すだけ**（n 個の数値なので §6.7.7 の制約には触れない）。
        liveSignal: liveSignal.s,
        liveFrames: liveTrack.frames,
        entries: plan.entries,
        summary: plan.summary,
        runOffset,
        livePeriod,
        maskPeriod,
        liveTracked: liveTrack.frames.filter((f) => f.reliable).length,
        maskTracked: maskTrack.frames.filter((f) => f.reliable).length,
        liveFrameCount: liveTrack.frames.length,
        maskFrameCount: maskTrack.frames.length,
      });
      return;
    }

    if (req.type === "phaseMatch") {
      const frames = unpack(req.frames);
      const w = req.frames.width;
      const h = req.frames.height;

      // 造影前の平均マスク（造影で変わった画素を見つけるための基準）。
      const mask = new Float32Array(w * h);
      for (const m of req.maskFrames) {
        const f = frames[m];
        if (!f) continue;
        for (let i = 0; i < mask.length; i++) mask[i] += f[i];
      }
      if (req.maskFrames.length) {
        for (let i = 0; i < mask.length; i++) mask[i] /= req.maskFrames.length;
      }

      // ライブフレームごとの「造影で変わった画素」。
      const excludes: Uint8Array[] = [];
      const contrastFraction: number[] = [];
      for (const t of req.liveFrames) {
        const f = frames[t];
        if (!f) { excludes.push(new Uint8Array(w * h)); contrastFraction.push(0); continue; }
        const r = contrastMask(mask, f, w, h, req.logarithmic, req.sigma ?? 4);
        excludes.push(r.exclude);
        contrastFraction.push(r.fraction);
      }

      // 🚨 窓は**造影が現れた範囲**に限る。全画面で比べると静止した背骨やコリメータが
      //    大半を占め、心臓の動きが数値に出ない（実測で変位 0.00px になった）。
      const rect = contrastBounds(excludes, w, h);
      if (!rect) {
        post({
          type: "phaseMatchDone", requestId: req.requestId,
          entries: req.liveFrames.map((t) => ({ liveFrame: t, maskFrame: null, score: 0, margin: 0, usedFraction: 0 })),
          rect: null, contrastFraction,
        });
        return;
      }

      const packed = packGradients(frames, w, h);
      const byLive = new Map<number, Uint8Array>();
      req.liveFrames.forEach((t, i) => byLive.set(t, excludes[i]));
      // 🔑 **途中経過を出す。** ここは 3000 回規模の ZNCC で、黙っていると固まって見える。
      //    塊に割って進捗を挟む（要求は解決しない）。
      const CHUNK = 8;
      const entries: ReturnType<typeof matchByBackground> = [];
      for (let i = 0; i < req.liveFrames.length; i += CHUNK) {
        const part = req.liveFrames.slice(i, i + CHUNK);
        entries.push(...matchByBackground(
          packed, part, req.maskFrames, rect,
          (t) => byLive.get(t) ?? null,
          { ...(req.minUsedFraction != null ? { minUsedFraction: req.minUsedFraction } : {}) },
        ));
        post({ type: "progress", requestId: req.requestId, done: entries.length, total: req.liveFrames.length });
      }
      post({ type: "phaseMatchDone", requestId: req.requestId, entries, rect, contrastFraction });
      return;
    }

    if (req.type === "alignPlan") {
      const frames = unpack(req.frames);
      const w = req.frames.width;
      const h = req.frames.height;
      const radius = Math.max(1, Math.floor(req.searchRadius));
      const align: ({ dx: number; dy: number; rotationDeg: number } | null)[] = [];
      let aligned = 0;
      for (let t = 0; t < frames.length; t++) {
        const m = req.maskFrameFor[t];
        if (m == null || m < 0 || m >= frames.length) { align.push(null); continue; }
        // 🔑 既に分かっているずらし（追尾）を**先に当ててから**残差だけを探す。
        //    画素は半解像度なので、実寸のずらしは半分にして掛ける。
        //    🔴 背景の突き合わせ経路では基準が 0（マスクを選んだ時点で解剖は揃っている前提）。
        const pre = shiftBilinear(frames[m], w, h, req.baseDx[t] / 2, req.baseDy[t] / 2);
        const r = alignOnEdges(pre, frames[t], w, h, {
          searchRadius: radius,
          logarithmic: req.logarithmic,
          ...(req.maxRotationDeg ? { maxRotationDeg: req.maxRotationDeg } : {}),
          ...(req.rotationStepDeg ? { rotationStepDeg: req.rotationStepDeg } : {}),
        });
        if (!r.reliable) { align.push(null); continue; }
        // 半解像度で求めた量なので実寸へ戻す。🔴 **角度はスケール不変なので 2 倍しない。**
        align.push({ dx: r.dx * 2, dy: r.dy * 2, rotationDeg: r.rotationDeg });
        aligned++;
        // 🔑 回転を入れると 1 フレームあたり角度の数だけ走るので、ここが最長の段になる。
        //    黙っていると固まって見える（§6.16.6）。
        if ((t + 1) % 8 === 0) {
          post({ type: "progress", requestId: req.requestId, done: t + 1, total: frames.length });
        }
      }
      post({ type: "alignPlanDone", requestId: req.requestId, align, aligned });
      return;
    }

    const frames = unpack(req.frames);
    const prepared = prepareFrames(frames, req.frames.width, req.frames.height, {
      referenceFrame: req.referenceFrame,
      logarithmic: req.logarithmic,
    });
    const track = trackPrepared(prepared, req.roi, { searchRadius: req.searchRadius });
    const signal = motionSignal(track, req.frameStartTimesMs);
    const period = estimatePeriod(signal.s, req.frameStartTimesMs);
    const phase = assignPhase(signal.s, req.frameStartTimesMs, period.periodFrames);

    post(
      {
        type: "analyzeDone",
        requestId: req.requestId,
        frames: track.frames,
        tensor: track.tensor,
        trackReliable: track.reliable,
        ...(track.reason ? { trackReason: track.reason } : {}),
        s: signal.s,
        sdot: signal.sdot,
        axis: [signal.axis[0], signal.axis[1]],
        signalReliable: signal.reliable,
        period,
        phase: phase.phase,
        peaks: phase.peaks,
        phaseReliable: phase.reliable,
      },
      [signal.s.buffer, signal.sdot.buffer, phase.phase.buffer],
    );
  } catch (e) {
    post({ type: "error", requestId: req.requestId, message: e instanceof Error ? e.message : String(e) });
  }
};
