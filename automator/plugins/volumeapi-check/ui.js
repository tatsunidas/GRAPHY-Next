/*
 * H10 / H21 の実機検証用プローブ。
 *
 * 画面は出さない。host API を順に呼び、結果（数値と幾何）を window.__volumeApiCheck に書く。
 * 判定は automator 側（src/spike/volumeApiCheck.ts）で、ファントムの真値と突き合わせて行う。
 */
export async function activate(host) {
  const out = { at: new Date().toISOString(), steps: [], error: null };
  const note = (step, value) => out.steps.push({ step, value });
  try {
    const targets = host.getTargets();
    note("targets", targets.map((t) => ({ tileId: t.tileId, seriesUid: t.seriesUid, studyUid: t.studyUid, modality: t.modality, sliceCount: t.sliceCount, label: t.seriesLabel })));

    const pt = targets.find((t) => t.modality === "PT");
    const ct = targets.find((t) => t.modality === "CT");
    const nm = targets.find((t) => t.modality === "NM");
    note("found", { pt: !!pt, ct: !!ct, nm: !!nm });

    // --- H10: 見積り → 読み込み -------------------------------------------
    if (pt) {
      const est = await host.estimateVolume({ seriesUid: pt.seriesUid, studyUid: pt.studyUid });
      note("estimate.pt", est);
      const vol = await host.loadVolume({ seriesUid: pt.seriesUid, studyUid: pt.studyUid });
      out.ptVolume = summarize(vol);
      // 肝の中心（患者 LPS mm）での値。真値と突き合わせる。
      out.ptLiverValue = sampleAtWorld(vol, [-60, -10, 20]);
      note("loaded.pt", { dims: vol && vol.dims, unit: vol && vol.unit });
      out.ptVolumeRef = vol;
    }
    if (ct) {
      const vol = await host.loadVolume({ seriesUid: ct.seriesUid, studyUid: ct.studyUid });
      out.ctVolume = summarize(vol);
      out.ctLiverValue = sampleAtWorld(vol, [-60, -10, 20]);
      out.ctVolumeRef = vol;
    }
    // studyUid を省略しても開いているタイルから解決できるか。
    if (pt) {
      const vol = await host.loadVolume({ seriesUid: pt.seriesUid });
      out.resolvedWithoutStudyUid = !!vol;
    }
    // 開いていないシリーズは解決できない（患者を跨いで読ませない）。
    out.unknownSeries = await host.loadVolume({ seriesUid: "1.2.999.not.open" });

    // --- H21: 位置合わせ ---------------------------------------------------
    if (ct && out.ctVolumeRef) {
      const reg = await host.registerVolumes(
        { fixed: { seriesUid: ct.seriesUid, studyUid: ct.studyUid },
          moving: { seriesUid: ct.seriesUid, studyUid: ct.studyUid },
          mode: "rigid",
          options: { maxIterationsPerLevel: 20, seed: 1 } },
        (f) => { out.lastProgress = f; },
      );
      out.registration = reg && {
        translationMm: reg.translationMm,
        eulerDeg: reg.eulerDeg,
        metric: reg.metric,
        metricValue: reg.metricValue,
        elapsedMs: reg.elapsedMs,
        aborted: reg.aborted,
        hasDeformation: reg.hasDeformation,
      };
      out.registrationTransform = reg ? reg.transform : null;

      // --- H21: リサンプル（SPECT を CT の格子へ）--------------------------
      if (out.ptVolumeRef) {
        const target = {
          dims: out.ctVolumeRef.dims,
          spacing: out.ctVolumeRef.spacing,
          indexToWorld: out.ctVolumeRef.indexToWorld,
          worldToIndex: out.ctVolumeRef.worldToIndex,
        };
        const resampled = host.resampleVolume(out.ptVolumeRef, reg ? reg.transform : null, target);
        out.resampled = summarize(resampled);
        out.resampledLiverValue = sampleAtWorld(resampled, [-60, -10, 20]);
        out.resampledOutside = sampleAtWorld(resampled, [10000, 0, 0]);
      }
    }
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  delete out.ptVolumeRef;
  delete out.ctVolumeRef;
  delete out.registrationTransform;
  window.__volumeApiCheck = out;
}

function summarize(v) {
  if (!v) return null;
  return {
    dims: v.dims,
    spacing: v.spacing,
    ipp: v.ipp,
    iop: v.iop,
    sliceStep: v.sliceStep,
    modality: v.modality,
    unit: v.unit,
    sliceThickness: v.sliceThickness,
    frameOfReferenceUid: v.frameOfReferenceUid,
    length: v.data ? v.data.length : 0,
    finite: v.data ? countFinite(v.data) : 0,
  };
}

function countFinite(data) {
  let n = 0;
  for (let i = 0; i < data.length; i++) if (Number.isFinite(data[i])) n++;
  return n;
}

/** world(LPS mm) → 最近傍ボクセルの値（幾何が正しいことの確認用）。 */
function sampleAtWorld(v, w) {
  if (!v) return null;
  const m = v.worldToIndex;
  const i = Math.round(m[0] * w[0] + m[1] * w[1] + m[2] * w[2] + m[3]);
  const j = Math.round(m[4] * w[0] + m[5] * w[1] + m[6] * w[2] + m[7]);
  const k = Math.round(m[8] * w[0] + m[9] * w[1] + m[10] * w[2] + m[11]);
  const [nx, ny, nz] = v.dims;
  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return null;
  return { index: [i, j, k], value: v.data[k * nx * ny + j * nx + i] };
}
