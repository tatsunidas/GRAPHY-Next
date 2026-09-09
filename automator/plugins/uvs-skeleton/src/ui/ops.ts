/**
 * JAR 面（`op` 方式）への呼び出し。
 *
 * 🔑 **往復の回数を数える**（`backendCalls`）。しきい値のドラッグでサーバへ往復していないことは、
 * 実機検査でこの数が増えないことによって示す——「速い気がする」ではなく数字で見る。
 */
import type { Viewer2DPluginHost } from "../../graphy-plugin";

export interface VideoInfo {
  ok: boolean;
  error?: string;
  sessionId: string;
  width: number;
  height: number;
  numberOfFrames: number;
  fps: number;
  durationSec: number | null;
  transferSyntaxUid: string | null;
  transcodeRequired: boolean;
  transcodeAvailable: boolean;
  ffmpeg: string;
  defaults: {
    interval: number;
    stride: number;
    colorThreshold: number;
    colorPixelRatioThreshold: number;
    staticMeanAbsDiffThreshold: number;
    staticMeanAbsDiffNote: string;
    aviEquivalentMeanAbsDiff: number;
    predictionThreshold: number;
    extractor: string;
    samplingPoints: number;
    randomSeed: number;
  };
}

export interface PrepareResult {
  ok: boolean;
  error?: string;
  from: number;
  frames: number;
  cpr: number[];
  mad: number[];
  sampleIndices: number[];
  interval: number;
  stride: number;
  cachedFrames: number;
  cacheBytes: number;
  framesDecoded: number;
  decodeMs: number;
}

export interface PredictScore {
  sample: number;
  frameIndex: number;
  ok?: boolean;
  error?: string;
  probability?: number;
  padded?: boolean;
  elapsedMs?: number;
  rois?: { cluster: number; x: number; y: number; w: number; h: number; pixels: number; probability: number }[];
}

export interface PredictResult {
  ok: boolean;
  error?: string;
  scores: PredictScore[];
  sampleFrom: number;
  nextFrom: number;
  total: number;
  done: boolean;
  anyPadded: boolean;
  radiomicsJVersion: string;
}

export interface ComposeResult {
  ok: boolean;
  error?: string;
  heart: number[];
  removedByPrediction: number[];
  finalIndices: number[];
  results: Record<string, number | string>;
}

export class Ops {
  /** 往復の回数。🔑 しきい値のドラッグでここが増えないことを実機で確かめる。 */
  calls = 0;

  constructor(
    private readonly host: Viewer2DPluginHost,
    private readonly context: { apiBase: string; sopInstanceUid: string | null },
  ) {}

  private async call<T>(args: Record<string, unknown>): Promise<T> {
    this.calls++;
    const res = (await this.host.runBackend({
      apiBase: this.context.apiBase,
      sopInstanceUid: this.context.sopInstanceUid,
      ...args,
    })) as T & { ok?: boolean; error?: string };
    if (res && res.ok === false && res.error) throw new Error(res.error);
    return res;
  }

  info(): Promise<VideoInfo> {
    return this.call<VideoInfo>({ op: "info" });
  }

  prepare(args: {
    sessionId: string;
    from: number;
    count: number;
    interval: number;
    stride: number;
    cacheForPredict: boolean;
  }): Promise<PrepareResult> {
    return this.call<PrepareResult>({ op: "prepare", ...args });
  }

  predict(args: {
    sessionId: string;
    sampleFrom: number;
    sampleCount: number;
  }): Promise<PredictResult> {
    return this.call<PredictResult>({ op: "predict", ...args });
  }

  /**
   * 🔴 **画面の常用経路ではない。** しきい値の再合成はフロントが行う。
   * これは実機検査で「フロントの答えが正本と一致するか」を見るために呼ぶ。
   */
  compose(args: Record<string, unknown>): Promise<ComposeResult> {
    return this.call<ComposeResult>({ op: "compose", ...args });
  }

  release(sessionId: string): Promise<{ ok: boolean; freedBytes: number }> {
    return this.call({ op: "release", sessionId });
  }
}
