/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * フーリエ解析の Web Worker（fw/fourier-design.md）。変換したスペクトル（非シフト、Float64）を
 * Worker 内に保持し、フィルタ＋逆変換・基底の生成は保持分に対して行う（毎回画素を送り直さない）。
 */
import {
  MAX_FFT_SIZE,
  applyMask,
  basisImage,
  buildMask,
  cropFromPadded,
  fft2d,
  fftshift,
  padToPow2Square,
  unshiftedIndex,
} from "./fourier";
import type { FourierWorkerRequest, FourierWorkerResponse } from "./fourierProtocol";

interface Held {
  n: number;
  re: Float64Array;
  im: Float64Array;
  offX: number;
  offY: number;
  width: number;
  height: number;
}
let held: Held | null = null;

function post(res: FourierWorkerResponse, transfer: ArrayBufferLike[] = []): void {
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(res, transfer as Transferable[]);
}

self.onmessage = (ev: MessageEvent<FourierWorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === "transform") {
      const p = padToPow2Square(req.values, req.width, req.height);
      if (p.n > MAX_FFT_SIZE) throw new Error(`too large: ${p.n}`);
      const re = p.data;
      const im = new Float64Array(p.n * p.n);
      fft2d(re, im, p.n);
      held = { n: p.n, re, im, offX: p.offX, offY: p.offY, width: req.width, height: req.height };
      const real = new Float32Array(p.n * p.n);
      const imag = new Float32Array(p.n * p.n);
      const magnitude = new Float32Array(p.n * p.n);
      for (let i = 0; i < re.length; i++) {
        real[i] = re[i];
        imag[i] = im[i];
        magnitude[i] = Math.hypot(re[i], im[i]);
      }
      const out = { real: fftshift(real, p.n), imag: fftshift(imag, p.n), magnitude: fftshift(magnitude, p.n) };
      post({ type: "transformDone", requestId: req.requestId, n: p.n, offX: p.offX, offY: p.offY, ...out }, [
        out.real.buffer,
        out.imag.buffer,
        out.magnitude.buffer,
      ]);
    } else if (req.type === "inverse") {
      if (!held) throw new Error("no spectrum");
      const { n } = held;
      const mask = buildMask(req.filter, n, req.sigma);
      const g = applyMask(held.re, held.im, n, mask);
      fft2d(g.re, g.im, n, true);
      let maxImag = 0;
      const mag = new Float64Array(n * n);
      for (let i = 0; i < n * n; i++) {
        mag[i] = Math.hypot(g.re[i], g.im[i]);
        const a = Math.abs(g.im[i]);
        if (a > maxImag) maxImag = a;
      }
      const real = cropFromPadded(g.re, n, held.offX, held.offY, held.width, held.height);
      const magnitude = cropFromPadded(mag, n, held.offX, held.offY, held.width, held.height);
      post({ type: "inverseDone", requestId: req.requestId, real, magnitude, mask, maxImag }, [
        real.buffer,
        magnitude.buffer,
        mask.buffer,
      ]);
    } else if (req.type === "basis") {
      if (!held) throw new Error("no spectrum");
      const { n } = held;
      const k = unshiftedIndex(req.u, req.v, n);
      const coeff = { re: held.re[k], im: held.im[k] };
      const image = basisImage(req.u, req.v, n, req.weighted ? coeff : undefined);
      post(
        {
          type: "basisDone",
          requestId: req.requestId,
          u: req.u,
          v: req.v,
          image,
          coeffRe: coeff.re,
          coeffIm: coeff.im,
        },
        [image.buffer],
      );
    }
  } catch (e) {
    post({ type: "error", requestId: req.requestId, message: e instanceof Error ? e.message : String(e) });
  }
};
