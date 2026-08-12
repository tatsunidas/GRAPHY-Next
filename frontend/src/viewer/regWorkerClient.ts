/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * レジストレーション Worker のクライアント（アプリ側）。
 *
 * <p>設計 §11 の `regWorkerPool.ts` に相当する位置づけだが、**プールにしていない**。
 * 理由: R3 の剛体は 1 本の逐次的な最適化で、z スラブに分割できるのは
 * 記述子計算やコストボリューム構築（R4 の非剛体）の方である。剛体の反復を
 * 複数 Worker に割る形にすると、部分和の統合順序を決定的に保つ仕掛けが要るのに
 * 得られるのは 1 回 15〜25 秒の短縮でしかない。**プールは R4 で本当に必要に
 * なったときに入れる**（そのとき §6 の「インデックス順で足す」を満たす形で作る）。
 *
 * <h3>中止 ★</h3>
 *
 * <p>計算中の Worker はメッセージループを回さないので、`postMessage` の中止要求は
 * **届かない**。確実に止めるには `terminate()` するしかない。ここではそうしている。
 * Worker は使い捨てにし、次の実行で作り直す。
 */

import type {
  RegWorkerRequest,
  RegWorkerResponse,
  RigidRequest,
  VolumePayload,
} from "./regProtocol";
import type { RegVolume } from "./regGeometry";

/** `RegVolume` を postMessage に載せる形へ落とす。 */
export function toPayload(vol: RegVolume, iop: readonly number[], sliceStep: readonly number[]): VolumePayload {
  const m = vol.indexToWorld;
  return {
    data: vol.data,
    dims: [vol.dims[0], vol.dims[1], vol.dims[2]],
    iop: Array.from(iop),
    ipp0: [m[3], m[7], m[11]],
    pixelSpacingCol: vol.spacing[0],
    pixelSpacingRow: vol.spacing[1],
    sliceStep: [sliceStep[0], sliceStep[1], sliceStep[2]],
  };
}

export interface RunRigidHandle {
  /** 結果。中止した場合は `aborted: true` の結果ではなく reject する。 */
  readonly promise: Promise<Extract<RegWorkerResponse, { type: "done" }>>;
  /** 実行を中止する（Worker を terminate する）。 */
  abort(): void;
}

let nextRequestId = 1;

/**
 * Worker で剛体レジストレーションを実行する。
 *
 * @param onProgress 進捗（0..1）。UI の進捗バーへ。
 */
export function runRigidInWorker(
  request: Omit<RigidRequest, "type" | "requestId">,
  onProgress?: (p: Extract<RegWorkerResponse, { type: "progress" }>) => void,
): RunRigidHandle {
  const requestId = nextRequestId++;
  const worker = new Worker(new URL("./regWorker.ts", import.meta.url), { type: "module" });

  let settled = false;
  let abortFn = () => {};

  const promise = new Promise<Extract<RegWorkerResponse, { type: "done" }>>((resolve, reject) => {
    abortFn = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error("registration aborted"));
    };

    worker.onmessage = (ev: MessageEvent<RegWorkerResponse>) => {
      const msg = ev.data;
      if (msg.requestId !== requestId) return;
      if (msg.type === "progress") { onProgress?.(msg); return; }
      settled = true;
      worker.terminate();
      if (msg.type === "error") reject(new Error(msg.message));
      else resolve(msg);
    };
    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error(e.message || "registration worker failed"));
    };

    const req: RegWorkerRequest = { type: "rigid", requestId, ...request };
    // ボリュームの画素バッファは転送する（コピーしない）。呼び出し側は
    // **転送後にそのバッファへ触らないこと** — detach されて壊れる
    // （`levelSetsTool.ts` と同じ約束）。
    worker.postMessage(req, [req.fixed.data.buffer, req.moving.data.buffer]);
  });

  return { promise, abort: () => abortFn() };
}
