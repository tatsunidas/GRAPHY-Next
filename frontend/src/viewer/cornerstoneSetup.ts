// Cornerstone3D の初期化（1 度だけ）。
// - core.init(): レンダリング基盤。
// - dicomImageLoader.init(): wadouri / wadors の画像ローダ登録＋デコード用 Web Worker 構成。
//   CSP は wasm-unsafe-eval / worker-src blob: を許可済み（圧縮 TS はワーカ＋WASM でデコード）。
import { init as coreInit } from "@cornerstonejs/core";
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";

let initPromise: Promise<void> | null = null;

/** 冪等な初期化。複数の Viewer2D から呼ばれても 1 回だけ実行する。 */
export function ensureCornerstoneInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await coreInit();
      // メインスレッドを塞がないようワーカ数は CPU-1（最大 4）に抑える。
      const maxWebWorkers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      dicomImageLoader.init({ maxWebWorkers });
    })();
  }
  return initPromise;
}
