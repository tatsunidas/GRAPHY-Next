/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `levelSetsTool.ts`（アプリ側、DOM lib）と `levelSetsWorker.ts`（Worker 側、WebWorker lib）が
 * 共有する postMessage プロトコルの型のみを持つファイル。DOM/WebWorker 固有のグローバル（`self` など）を
 * 一切使わないため、双方の tsconfig（`tsconfig.app.json`/`tsconfig.worker.json`）から矛盾なく参照できる。
 */
import type { Dims, RegionExpandsTo } from "./levelSetsCore";

export interface FastMarchingWorkerRequest {
  type: "fastMarching";
  requestId: number;
  image: Float32Array;
  dims: Dims;
  seedX: number;
  seedY: number;
  seedZ: number;
  greyValueThreshold: number;
  distanceThreshold: number;
}

export interface ActiveContoursWorkerRequest {
  type: "activeContours";
  requestId: number;
  image: Float32Array;
  dims: Dims;
  initMask: Uint8Array;
  regionExpandsTo: RegionExpandsTo;
  advection: number;
  curvature: number;
  grayscaleTolerance: number;
  convergence: number;
  narrowBand: number;
  reinitInterval: number;
  maxIterations: number;
}

export interface GeodesicActiveContoursWorkerRequest {
  type: "geodesicActiveContours";
  requestId: number;
  image: Float32Array;
  dims: Dims;
  initMask: Uint8Array;
  regionExpandsTo: RegionExpandsTo;
  advection: number;
  propagation: number;
  curvature: number;
  edgeSigma: number;
  convergence: number;
  narrowBand: number;
  reinitInterval: number;
  maxIterations: number;
}

export type LevelSetWorkerRequest = FastMarchingWorkerRequest | ActiveContoursWorkerRequest | GeodesicActiveContoursWorkerRequest;

export interface LevelSetWorkerResponse {
  type: "fastMarchingDone" | "activeContoursDone" | "geodesicActiveContoursDone" | "error";
  requestId: number;
  mask?: Uint8Array;
  reachedCount?: number;
  iterations?: number;
  converged?: boolean;
  lastChange?: number;
  message?: string;
}
