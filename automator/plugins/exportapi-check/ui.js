/*
 * H16 / H22 / H23 / H25 の実機検証用プローブ。
 *
 * 画面は出さない。CT のボリュームを読んで小さなマスクと線量格子を作り、
 * 保存の呼び出しを window.__exportApi に置く（**確認ダイアログの操作が要るので、
 * 呼ぶのは automator 側**）。結果の判定は src/spike/exportApiCheck.ts。
 */
export async function activate(host) {
  const out = { at: new Date().toISOString(), ready: false, error: null };
  window.__exportApiCheck = out;
  const api = {};
  window.__exportApi = api;

  try {
    const targets = host.getTargets();
    out.targets = targets.map((t) => ({ modality: t.modality, seriesUid: t.seriesUid, studyUid: t.studyUid }));
    const ct = targets.find((t) => t.modality === "CT");
    if (!ct) throw new Error("CT のタイルが開いていない");

    const reference = { seriesUid: ct.seriesUid, studyUid: ct.studyUid };
    const vol = await host.loadVolume(reference);
    if (!vol) throw new Error("CT のボリュームが読めない");
    const grid = {
      dims: vol.dims,
      spacing: vol.spacing,
      ipp: vol.ipp,
      iop: vol.iop,
      sliceStep: vol.sliceStep,
    };
    out.grid = grid;

    const [nx, ny, nz] = vol.dims;
    const n = nx * ny * nz;
    // 肝の中心（患者 LPS mm）を格子の index へ。
    const m = vol.worldToIndex;
    const w = [-60, -10, 20];
    const ci = Math.round(m[0] * w[0] + m[1] * w[1] + m[2] * w[2] + m[3]);
    const cj = Math.round(m[4] * w[0] + m[5] * w[1] + m[6] * w[2] + m[7]);
    const ck = Math.round(m[8] * w[0] + m[9] * w[1] + m[10] * w[2] + m[11]);
    out.center = [ci, cj, ck];

    // 5×5×3 の直方体マスク（真値: 75 ボクセル）。
    const RX = 2, RY = 2, RZ = 1;
    const mask = new Uint8Array(n);
    const dose = new Float32Array(n).fill(NaN);
    const DOSE_GY = 2.5;
    let count = 0;
    for (let k = ck - RZ; k <= ck + RZ; k++) {
      for (let j = cj - RY; j <= cj + RY; j++) {
        for (let i = ci - RX; i <= ci + RX; i++) {
          if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
          const idx = k * nx * ny + j * nx + i;
          mask[idx] = 1;
          dose[idx] = DOSE_GY;
          count++;
        }
      }
    }
    out.maskVoxels = count;
    out.doseGy = DOSE_GY;
    out.emptySliceCount = nz - (2 * RZ + 1);

    // --- H22: DICOM SEG ---------------------------------------------------
    api.saveSeg = () =>
      host.saveSegmentation({
        reference,
        grid,
        seriesDescription: "Probe segmentation",
        segments: [
          { label: "probe-box", color: [255, 0, 0], description: "5x5x3 box", data: mask },
          // 前景ゼロのセグメント。**保存対象から外れる**ことを見る。
          { label: "empty", data: new Uint8Array(n) },
        ],
      });

    // 格子をわざと 1 スライスぶんずらす。**保存されないこと**を見る
    // （ずれた SEG は見ないと気付けないので、本体が止める）。
    api.saveSegShifted = () =>
      host.saveSegmentation({
        reference,
        grid: {
          ...grid,
          ipp: [
            grid.ipp[0] + grid.sliceStep[0],
            grid.ipp[1] + grid.sliceStep[1],
            grid.ipp[2] + grid.sliceStep[2],
          ],
        },
        segments: [{ label: "shifted", data: mask }],
      });

    // --- H23: RTDOSE ------------------------------------------------------
    api.saveDose = () =>
      host.saveRtDose({
        reference,
        grid,
        doseGy: dose,
        backgroundGy: 0,
        seriesDescription: "Probe dose",
        doseComment: "probe",
        tissueHeterogeneityCorrection: "IMAGE",
      });

    // NaN があるのに背景を指定しない。**拒否されること**を見る。
    api.saveDoseNoBackground = () =>
      host.saveRtDose({ reference, grid, doseGy: dose, seriesDescription: "Probe dose (bad)" });

    // --- H16: SR の数値計測 ------------------------------------------------
    api.saveSr = () =>
      host.saveStructuredReport(undefined, {
        seriesDescription: "Probe dosimetry report",
        documentTitle: "Probe dosimetry",
        groups: [
          {
            trackingId: "probe-liver",
            findingText: "Probe VOI",
            seriesInstanceUid: ct.seriesUid,
            measurements: [
              { type: "absorbedDose", value: DOSE_GY },
              { type: "timeIntegratedActivity", value: 4.393e11 },
              { type: "effectiveHalfLife", value: 60 },
              { type: "volume", value: 6.822 },
              { type: "mass", value: 7.11 },
            ],
          },
        ],
        findings: [{ label: "Note", text: "probe" }],
      });

    // --- H25: レポートへの登録 ---------------------------------------------
    api.publish = (caveats) =>
      host.publishAnalysisResult({
        id: "probe",
        title: "Probe dosimetry",
        studyUid: ct.studyUid,
        seriesUid: ct.seriesUid,
        frameLabel: "probe",
        metrics: [{ label: "Absorbed dose", value: String(DOSE_GY), unit: "Gy" }],
        provenance: [{ label: "Method", value: "probe" }],
        caveats,
      });

    out.ready = true;
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
}
