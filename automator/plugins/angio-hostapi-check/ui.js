/*
 * 実機検証用プラグイン（H35〜H39・fw/plugin-architecture.md §7）。
 *
 * アンギオ計測を外出しするために足した 5 本を、**本物の Electron ＋ 本物の backend ＋
 * 本物のプラグイン配信経路**で確かめる。
 *
 * 何をするかは `window.__angioCheckMode` で切り替える（保存系は本体が確認ダイアログを出し、
 * automator がそれを操作するため、1 回の activate で 1 つだけ走らせる）。
 *
 *   "read"     … H35 getSpatialCalibration / H36 getXaState
 *   "report"   … H39 publishAnalysisResult（正常・注意書き空・他患者の SOP）
 *   "sr"       … H37 saveAngioReport（正常）
 *   "sr-bad"   … H37（開いていない SOP を渡す＝拒否されるべき）
 *   "gsps"     … H38 savePresentationState（正常）
 *
 * 結果は window.__angioHostApiCheck に**積む**（モードごとにキーを足す）。
 */

/** 開いている並びに無い SOP。**他患者の検査へ書けないこと**を確かめるために使う。 */
const FOREIGN_SOP = "1.2.826.0.1.3680043.9.7133.9999.9999";

function stash(patch) {
  window.__angioHostApiCheck = { ...(window.__angioHostApiCheck ?? {}), ...patch };
}

/** 画面に出す（automator がパネルの表示を待てるように）。 */
function panel(text) {
  let el = document.getElementById("angio-hostapi-check-panel");
  if (!el) {
    el = document.createElement("div");
    el.id = "angio-hostapi-check-panel";
    el.setAttribute("data-testid", "angio-hostapi-check-panel");
    el.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:99999;background:#102030;color:#cde;" +
      "font:11px/1.5 monospace;padding:6px 8px;border-radius:4px;max-width:60vw;white-space:pre-wrap";
    document.body.appendChild(el);
  }
  el.textContent = text;
}

/** 最初の長さ計測（automator が引いたもの）。参照 SOP をここから取る。 */
function firstLengthRoi(host) {
  const rois = host.getRois ? host.getRois() : [];
  return rois.find((r) => r.toolName === "Length") ?? rois[0] ?? null;
}

function qcaBody(seriesUid, sopUid, frameNumber, unit) {
  return {
    seriesInstanceUid: seriesUid,
    sopInstanceUid: sopUid,
    frameNumber,
    unit,
    calibration: "automator: fixed values",
    vesselLabel: "LAD proximal",
    manualCorrection: null,
    diameterMethod: "densitometric",
    mld: 1.47,
    rvd: 3.0,
    percentDiameterStenosis: 51.0,
    percentAreaStenosis: 76.0,
    lesionLength: 6.2,
  };
}

export async function activate(host) {
  if (host.surface !== "viewer2d.menu" && host.surface !== "viewer2d.toolbar") return;
  const mode = window.__angioCheckMode ?? "read";
  const target = host.getTargets()[0] ?? null;
  const roi = firstLengthRoi(host);
  const sopUid = roi?.sopInstanceUid ?? null;
  const seriesUid = target?.seriesUid ?? null;
  const frameNumber = target ? target.sliceIndex + 1 : 1;

  // API そのものの有無（古い本体で落ちないこと・存在を数えられること）。
  stash({
    api: {
      getSpatialCalibration: typeof host.getSpatialCalibration === "function",
      getXaState: typeof host.getXaState === "function",
      saveAngioReport: typeof host.saveAngioReport === "function",
      savePresentationState: typeof host.savePresentationState === "function",
      publishAnalysisResult: typeof host.publishAnalysisResult === "function",
    },
    context: {
      seriesUid,
      sopUid,
      frameNumber,
      tileId: target?.tileId ?? null,
      modality: target?.modality ?? null,
      // H1 の studyDate（XA のフレーム imageId でもメタが引けるか）と ROI の件数。
      studyDate: target?.studyDate ?? null,
      roiCount: (host.getRois ? host.getRois() : []).length,
    },
  });

  if (mode === "read") {
    const calib = host.getSpatialCalibration ? host.getSpatialCalibration() : null;
    const xa = host.getXaState ? host.getXaState() : null;
    // 未知のタイルは null（例外にしない）。
    const calibUnknown = host.getSpatialCalibration ? host.getSpatialCalibration("no-such-tile") : "missing";
    const xaUnknown = host.getXaState ? host.getXaState("no-such-tile") : "missing";
    stash({ calib, xa, calibUnknown, xaUnknown });
    panel(`read: calib=${calib ? calib.tier : "null"} xa=${xa ? (xa.isSubtracted ? "DSA" : "native") : "null"}`);
    return;
  }

  if (mode === "report") {
    const base = {
      kind: "qca",
      sopInstanceUids: sopUid ? [sopUid] : [],
      frameLabel: `フレーム ${frameNumber}`,
      title: "冠動脈定量解析（QCA）",
      metrics: [{ label: "MLD", value: "1.47", unit: "mm" }],
      provenance: [{ label: "空間校正", value: "automator" }],
    };
    const publish = host.publishAnalysisResult(undefined, {
      ...base,
      id: "case-1",
      caveats: ["automator が入れた注意書き"],
    });
    // 注意書きが空（空白だけ）なら拒否されるべき。
    const publishNoCaveats = host.publishAnalysisResult(undefined, {
      ...base,
      id: "case-2",
      caveats: ["   "],
    });
    // 開いていない SOP を参照する記録は拒否されるべき。
    const publishBadSop = host.publishAnalysisResult(undefined, {
      ...base,
      id: "case-3",
      sopInstanceUids: [FOREIGN_SOP],
      caveats: ["automator"],
    });
    stash({ publish, publishNoCaveats, publishBadSop });
    panel(`report: ok=${publish.ok} noCaveats=${publishNoCaveats.ok} badSop=${publishBadSop.ok}`);
    return;
  }

  if (mode === "sr-bad") {
    const srBadSop = await host.saveAngioReport(undefined, {
      kind: "qca",
      qca: qcaBody(seriesUid, FOREIGN_SOP, frameNumber, "px"),
    });
    stash({ srBadSop });
    panel(`sr-bad: ok=${srBadSop.ok} error=${srBadSop.error ?? ""}`);
    return;
  }

  if (mode === "sr") {
    const calib = host.getSpatialCalibration ? host.getSpatialCalibration() : null;
    // 🔴 未校正なら px のまま出す（mm を騙らない）。
    const unit = calib && calib.mmPerPxCol != null ? "mm" : "px";
    const sr = await host.saveAngioReport(undefined, {
      kind: "qca",
      qca: qcaBody(seriesUid, sopUid, frameNumber, unit),
    });
    stash({ sr, srUnit: unit });
    panel(`sr: ok=${sr.ok} sop=${sr.sopInstanceUid ?? ""} ${sr.error ?? ""}`);
    return;
  }

  if (mode === "gsps") {
    const calib = host.getSpatialCalibration ? host.getSpatialCalibration() : null;
    const xa = host.getXaState ? host.getXaState() : null;
    const gsps = await host.savePresentationState(undefined, {
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sopUid,
      frameNumbers: [frameNumber],
      label: "AUTOMATOR",
      description: "angio-hostapi-check",
      creator: "automator",
      mask:
        xa && xa.isSubtracted
          ? {
              maskFrameNumbers: xa.maskFrames.map((f) => f + 1),
              subPixelShiftCol: xa.shift[0],
              subPixelShiftRow: xa.shift[1],
            }
          : null,
      calibration: calib
        ? { mmPerPxRow: calib.mmPerPxRow, mmPerPxCol: calib.mmPerPxCol, description: calib.provenance }
        : null,
      polylines: [{ layer: "CENTERLINE", points: [10, 10, 20, 20, 30, 30] }],
    });
    stash({ gsps, gspsHadMask: !!(xa && xa.isSubtracted) });
    panel(`gsps: ok=${gsps.ok} sop=${gsps.sopInstanceUid ?? ""} ${gsps.error ?? ""}`);
    return;
  }

  panel(`unknown mode: ${mode}`);
}
