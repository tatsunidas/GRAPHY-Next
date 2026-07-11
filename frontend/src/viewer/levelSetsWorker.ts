/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Level Sets の計算を担う Web Worker（本リポジトリ初の画像処理用 Worker、fw/level-sets-design.md §3）。
 * postMessage で `LevelSetWorkerRequest`（Fast Marching / Active Contours）を受け取り、結果を
 * `LevelSetWorkerResponse` として Transferable（`mask.buffer`）で返す。呼び出し側は `image`（Float32Array の
 * コピー）を transfer で渡すこと（Cornerstone のキャッシュ画素バッファそのものを渡さない — detach されて壊れる）。
 */
import { runFastMarching, runActiveContours, runGeodesicActiveContours } from "./levelSetsCore";
import type { LevelSetWorkerRequest, LevelSetWorkerResponse } from "./levelSetsProtocol";

self.onmessage = (ev: MessageEvent<LevelSetWorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === "fastMarching") {
      const result = runFastMarching({
        image: req.image,
        dims: req.dims,
        seedX: req.seedX,
        seedY: req.seedY,
        seedZ: req.seedZ,
        greyValueThreshold: req.greyValueThreshold,
        distanceThreshold: req.distanceThreshold,
      });
      const res: LevelSetWorkerResponse = {
        type: "fastMarchingDone",
        requestId: req.requestId,
        mask: result.mask,
        reachedCount: result.reachedCount,
      };
      self.postMessage(res, { transfer: [result.mask.buffer] });
    } else if (req.type === "activeContours") {
      const result = runActiveContours({
        image: req.image,
        dims: req.dims,
        initMask: req.initMask,
        regionExpandsTo: req.regionExpandsTo,
        advection: req.advection,
        curvature: req.curvature,
        grayscaleTolerance: req.grayscaleTolerance,
        convergence: req.convergence,
        narrowBand: req.narrowBand,
        reinitInterval: req.reinitInterval,
        maxIterations: req.maxIterations,
      });
      const res: LevelSetWorkerResponse = {
        type: "activeContoursDone",
        requestId: req.requestId,
        mask: result.mask,
        reachedCount: result.mask.reduce((a, b) => a + b, 0),
        iterations: result.iterations,
        converged: result.converged,
        lastChange: result.lastChange,
      };
      self.postMessage(res, { transfer: [result.mask.buffer] });
    } else if (req.type === "geodesicActiveContours") {
      const result = runGeodesicActiveContours({
        image: req.image,
        dims: req.dims,
        initMask: req.initMask,
        regionExpandsTo: req.regionExpandsTo,
        advection: req.advection,
        propagation: req.propagation,
        curvature: req.curvature,
        edgeSigma: req.edgeSigma,
        convergence: req.convergence,
        narrowBand: req.narrowBand,
        reinitInterval: req.reinitInterval,
        maxIterations: req.maxIterations,
      });
      const res: LevelSetWorkerResponse = {
        type: "geodesicActiveContoursDone",
        requestId: req.requestId,
        mask: result.mask,
        reachedCount: result.mask.reduce((a, b) => a + b, 0),
        iterations: result.iterations,
        converged: result.converged,
        lastChange: result.lastChange,
      };
      self.postMessage(res, { transfer: [result.mask.buffer] });
    }
  } catch (e) {
    const res: LevelSetWorkerResponse = {
      type: "error",
      requestId: req.requestId,
      message: e instanceof Error ? e.message : String(e),
    };
    self.postMessage(res);
  }
};
