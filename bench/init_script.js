// GRAPHY-Next Benchmark Phantom (GNBP-1)
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Page-side instrumentation shared by the 2D and 3D harnesses. Injected before
// any application script runs, via context.addInitScript.
//
// It deliberately does not depend on the application: window.__graphyDebug is
// compiled out of production builds, and production is what we measure.
(() => {
  const bench = {
    rafCount: 0,
    rafMarks: [],
    installedAt: performance.now(),
  };
  // Keep an unpatched reference. The harness's own driving loops must use this
  // one, otherwise they are counted as application frames and the frame rate
  // reported is the display refresh rate rather than the viewer's render rate.
  const raf = window.requestAnimationFrame.bind(window);
  bench.rawRaf = raf;
  window.requestAnimationFrame = (cb) =>
    raf((t) => { bench.rafCount++; return cb(t); });

  // Cheap content signature of a canvas: a coarse sample of its pixels. Used
  // both to detect "something has been drawn" and to count distinct frames of
  // content during scrolling. Sampling (not a full read) keeps the probe from
  // perturbing the thing it measures.
  bench.canvasStats = (canvas) => {
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return null;
    const off = document.createElement("canvas");
    const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
    off.width = Math.max(1, Math.floor(w / step));
    off.height = Math.max(1, Math.floor(h / step));
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    try { ctx.drawImage(canvas, 0, 0, off.width, off.height); } catch { return null; }
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    let sum = 0, nonBlack = 0, hash = 2166136261;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += lum;
      if (lum > 2) nonBlack++;
      hash = ((hash ^ (lum | 0)) * 16777619) >>> 0;
    }
    return {
      width: w, height: h,
      mean: n ? sum / n : 0,
      nonBlackFraction: n ? nonBlack / n : 0,
      hash,
    };
  };

  bench.allCanvasStats = () =>
    Array.from(document.querySelectorAll("canvas"))
      .map((c) => bench.canvasStats(c))
      .filter(Boolean);

  // The "primary" canvas is the largest one that has content — the viewport,
  // as opposed to thumbnails, colour bars and overlays.
  bench.primaryStats = () => {
    const all = bench.allCanvasStats();
    if (!all.length) return null;
    return all.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  };

  bench.resetRaf = () => { bench.rafCount = 0; };
  bench.readRaf = () => bench.rafCount;

  window.__bench = bench;
})();
