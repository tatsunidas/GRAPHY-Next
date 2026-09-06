/*
 * QFR プローブ — **host API の事実を測るだけ**のプラグイン。
 *
 * 🔴 **これは QFR の検証ではない。** 計算は一切していない。
 *    `graphy-next-plugin-angio-quant` の cQFR が前提にしている host の挙動のうち、
 *    **ユニットテストでは原理的に届かない 3 点**を実機で測る:
 *
 *    ① `getPixelData(tileId, { sliceIndex: f })` は **XA マルチフレームでフレーム添字として効くか**
 *       （本体 §5.7 は「データは nZ に載せ stackAxis="t"」としており `XaFrameExpander` の
 *        展開に依存する。効かなければ TDC は**全フレーム同じ値**になり、
 *        「造影が到達しない」という分かりにくい形で落ちる）
 *    ② `getXaCine()`（H40）は値を返すか。**DSA 表示中も返るか**
 *       （合成 imageId は元 URL を持たないので `dsaNativeImageId()` の委譲が要る）
 *    ③ 全フレーム走査に何秒かかるか（実用範囲か）
 *
 * 結果は `window.__qfrProbe` に置く（automator が読む）。
 */
export function activate(host) {
  const out = {
    surface: host.surface || null,
    hostKeys: Object.keys(host || {}).sort(),
    hasGetXaCine: typeof host.getXaCine === "function",
    hasGetXaState: typeof host.getXaState === "function",
    target: null,
    xaState: null,
    cine: null,
    scan: null,
    error: null,
  };

  (async () => {
    try {
      const targets = host.getTargets ? host.getTargets() : [];
      const t = targets[0] || null;
      out.target = t
        ? {
            tileId: t.tileId,
            modality: t.modality,
            sliceIndex: t.sliceIndex,
            sliceCount: t.sliceCount,
            seriesLabel: t.seriesLabel,
          }
        : null;
      if (!t) {
        out.error = "対象タイルがありません";
        return;
      }

      // ── ② H40 ───────────────────────────────────────────────
      if (out.hasGetXaState) {
        const x = host.getXaState(t.tileId);
        out.xaState = x
          ? { isSubtracted: x.isSubtracted, frameIndex: x.frameIndex, frameCount: x.frameCount }
          : null;
      }
      if (out.hasGetXaCine) {
        const c = host.getXaCine(t.tileId);
        out.cine = c
          ? {
              numberOfFrames: c.numberOfFrames,
              frameTimeMs: c.frameTimeMs,
              frameTimeVectorLength: c.frameTimeVectorMs ? c.frameTimeVectorMs.length : null,
              cineRate: c.cineRate,
              recommendedDisplayFrameRate: c.recommendedDisplayFrameRate,
              fps: c.fps,
              fpsSource: c.fpsSource,
              uniform: c.uniform,
              startTimesLength: c.frameStartTimesMs ? c.frameStartTimesMs.length : null,
              firstTimes: c.frameStartTimesMs ? c.frameStartTimesMs.slice(0, 4) : null,
              lastTime: c.frameStartTimesMs ? c.frameStartTimesMs[c.frameStartTimesMs.length - 1] : null,
            }
          : null;
      }

      // ── ① / ③ 全フレーム走査 ─────────────────────────────────
      const n = (out.cine && out.cine.numberOfFrames) || t.sliceCount || 0;
      if (n > 1) {
        const t0 = Date.now();
        const means = [];
        const shapes = [];
        for (let f = 0; f < n; f++) {
          const px = await host.getPixelData(t.tileId, { sliceIndex: f });
          if (!px) {
            means.push(null);
            shapes.push(null);
            continue;
          }
          // 画像中央の 64x64 の平均。**画素は保持しない**（保持するとメモリガードに当たる）。
          let sum = 0;
          let cnt = 0;
          const cx = px.cols >> 1;
          const cy = px.rows >> 1;
          for (let y = cy - 32; y < cy + 32; y++) {
            if (y < 0 || y >= px.rows) continue;
            for (let x = cx - 32; x < cx + 32; x++) {
              if (x < 0 || x >= px.cols) continue;
              sum += px.data[y * px.cols + x];
              cnt++;
            }
          }
          means.push(cnt ? sum / cnt : null);
          shapes.push({ sliceIndex: px.sliceIndex, rows: px.rows, cols: px.cols });
        }
        const elapsedMs = Date.now() - t0;
        const valid = means.filter((m) => m != null);
        const min = valid.length ? Math.min.apply(null, valid) : null;
        const max = valid.length ? Math.max.apply(null, valid) : null;
        out.scan = {
          frames: n,
          elapsedMs,
          msPerFrame: n ? elapsedMs / n : null,
          means,
          // 🔑 **フレームが実際に変わっているかの決め手。** sliceIndex が効いていなければ
          //    全フレームで同じ画素が返り、平均のばらつきが 0 になる。
          meanSpread: min != null && max != null ? max - min : null,
          // host が「どのスライスを読んだか」を申告した値。要求と一致するか。
          reportedIndices: shapes.map((s) => (s ? s.sliceIndex : null)),
          indexMatches: shapes.every((s, i) => !s || s.sliceIndex === i),
        };
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    } finally {
      window.__qfrProbe = out;
      if (host.notify) host.notify("QFR プローブ完了");
    }
  })();
}

export default { activate };
