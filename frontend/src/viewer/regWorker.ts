/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * レジストレーションを担う Web Worker（設計: `fw/registration-design.md` §6）。
 *
 * <p>`levelSetsWorker.ts` と同じ作法。`RegWorkerRequest` を受け取り、
 * 進捗を `progress` で流しながら計算し、結果を `done` で返す。
 *
 * <h3>中止の扱い ★</h3>
 *
 * <p>Worker は 1 つの計算で数十秒占有される。中止要求は**同じ Worker への
 * postMessage では届かない**（実行中はメッセージループが回らない）ので、
 * 中止フラグは {@link https://developer.mozilla.org/docs/Web/API/Worker/postMessage}
 * ではなく `onmessage` の前に受け取っておく必要がある。
 *
 * <p>ここでは「実行前に来た中止要求」と「実行を細切れにして間で確認する」の
 * 両方はできないため、**中止は次の反復境界で効く**方式にしてある:
 * `shouldAbort` は Worker 内のフラグを見るだけで、そのフラグは
 * **`regCore` が反復ごとに呼ぶ**。つまり Worker が計算中でもフラグは
 * 更新できない — この制約を回避するため、クライアント側
 * （`regWorkerClient.ts`）は中止時に **Worker を terminate する**。
 * 本ファイルの `abort` 処理は、実行前・実行後に届いた要求のためのもの。
 */
import { registerRigid } from "./regCore";
import { registerDeformable } from "./regDeformable";
import { makeVolume } from "./regGeometry";
import type { DvfPayload, RegDoneMessage, RegWorkerRequest, RegWorkerResponse, VolumePayload } from "./regProtocol";
import type { Vec3 } from "./regTransform";

const aborted = new Set<number>();

function toVolume(p: VolumePayload) {
  return makeVolume(
    p.data,
    p.dims,
    p.iop,
    p.ipp0 as Vec3,
    p.pixelSpacingCol,
    p.pixelSpacingRow,
    p.sliceStep as Vec3,
  );
}

self.onmessage = (ev: MessageEvent<RegWorkerRequest>) => {
  const req = ev.data;
  if (req.type === "abort") {
    aborted.add(req.requestId);
    return;
  }
  try {
    const started = Date.now();
    const mode = req.mode ?? "rigid";
    const doRigid = mode === "rigid" || mode === "rigid+deformable";
    const doDeform = mode === "deformable" || mode === "rigid+deformable";
    const fixedVol = toVolume(req.fixed);
    const movingVol = toVolume(req.moving);
    // 剛体と非剛体で進捗を分ける（非剛体だけなら全部を非剛体に割り当てる）。
    const rigidSpan = doRigid ? (doDeform ? 0.6 : 1) : 0;

    const result = doRigid ? registerRigid(fixedVol, movingVol, {
      metric: req.metric,
      sameModality: req.sameModality,
      sameFrameOfReference: req.sameFrameOfReference,
      pyramidMm: req.pyramidMm,
      samplesPerIteration: req.samplesPerIteration,
      maxIterationsPerLevel: req.maxIterationsPerLevel,
      seed: req.seed,
      limits: req.limits,
      shouldAbort: () => aborted.has(req.requestId),
      onProgress: (p) => {
        const msg: RegWorkerResponse = {
          type: "progress",
          requestId: req.requestId,
          fraction: p.fraction * rigidSpan,
          level: p.level,
          levelCount: p.levelCount,
          iteration: p.iteration,
          metric: p.metric,
        };
        self.postMessage(msg);
      },
    }) : null;

    let dvf: DvfPayload | undefined;
    if (doDeform && !aborted.has(req.requestId)) {
      const d = registerDeformable(fixedVol, movingVol, result?.transform ?? null, {
        ...(req.deformable ?? {}),
        shouldAbort: () => aborted.has(req.requestId),
        onProgress: (f) => {
          const msg: RegWorkerResponse = {
            type: "progress",
            requestId: req.requestId,
            fraction: rigidSpan + f * (1 - rigidSpan),
            level: 0,
            levelCount: 1,
            iteration: 0,
            metric: NaN,
          };
          self.postMessage(msg);
        },
      });
      if (!d.aborted) {
        dvf = {
          displacements: d.transform.displacements,
          dims: [d.transform.dims[0], d.transform.dims[1], d.transform.dims[2]],
          origin: [d.transform.origin[0], d.transform.origin[1], d.transform.origin[2]],
          spacing: [d.transform.spacing[0], d.transform.spacing[1], d.transform.spacing[2]],
          jacobian: d.jacobian,
          maxDisplacementMm: d.maxDisplacementMm,
        };
      }
    }

    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const done: RegDoneMessage = {
      type: "done",
      requestId: req.requestId,
      dvf,
      matrix: result ? Array.from(result.transform.matrix) : identity,
      center: (result?.center ?? [0, 0, 0]) as [number, number, number],
      translationMm: (result?.parameters.translationMm ?? [0, 0, 0]) as [number, number, number],
      eulerDeg: (result?.parameters.eulerDeg ?? [0, 0, 0]) as [number, number, number],
      metric: result?.metric ?? "ncc",
      metricValue: result?.metricValue ?? NaN,
      levels: result?.levels ?? [],
      seed: result?.seed ?? 0,
      aborted: result?.aborted ?? false,
      initialization: result?.initialization ?? "identity-same-for",
      elapsedMs: Date.now() - started,
    };
    // 変位場は Transferable で返す（コピーしない）。
    self.postMessage(done, dvf ? { transfer: [dvf.displacements.buffer] } : undefined);
  } catch (e) {
    const msg: RegWorkerResponse = {
      type: "error",
      requestId: req.requestId,
      message: e instanceof Error ? e.message : String(e),
    };
    self.postMessage(msg);
  } finally {
    aborted.delete(req.requestId);
  }
};
