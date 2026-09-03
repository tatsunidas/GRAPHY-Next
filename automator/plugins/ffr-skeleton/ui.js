/*
 * FFR の骨組みプラグイン — `fw/angio-design.md` §11.5 / A7 の第 1 段。
 *
 * 🔴 **これは FFR ではない。** 計算は「入口からの累積抵抗の当てずっぽう」であって
 *    流体解析でも学習モデルでもない。目的は **host API H11 / H12 の本番経路を実機で通し、
 *    本物のモジュールを書く前に穴を洗い出すこと**。
 *
 *    本体側の vitest 52 件が守っているのは `pluginVesselApi` の純関数であり、
 *    **プラグイン → host の実際の配線（`Viewer2DMenuBar` の producer 注入）は
 *    一度も通っていない**（既存の実機検証は `__graphyDebug.seedVesselAnalysis()` 経由）。
 *    型は手書きの写しなので、TypeScript は写し間違いを教えてくれない
 *    （`openWindow().root` / `.container` と `ViewerRoi.toolName` / `.tool` で 2 回踏んでいる）。
 *
 * 結果は `window.__ffrSkeleton` に置く（automator が読む）。
 */
export function activate(host) {
  const out = {
    surface: host.surface || null,
    // 何が生えているかをそのまま記録する（契約の写し間違いはここに出る）。
    hasListVesselModels: typeof host.listVesselModels === "function",
    hasGetVesselModel: typeof host.getVesselModel === "function",
    hasPutVesselAnalysis: typeof host.putVesselAnalysis === "function",
    hostKeys: Object.keys(host || {}).sort(),
    summaries: null,
    model: null,
    put: null,
    error: null,
  };

  try {
    if (!out.hasListVesselModels || !out.hasGetVesselModel || !out.hasPutVesselAnalysis) {
      out.error = "H11/H12 が host に生えていない";
      finish(host, out);
      return;
    }

    // ── H11: 一覧 ───────────────────────────────────────────────
    const list = host.listVesselModels();
    out.summaries = (list || []).map((s) => ({
      runId: s.runId,
      kind: s.kind,
      label: s.label,
      segmentCount: s.segmentCount,
      pointCount: s.pointCount,
      diameterCalibrated: s.diameterCalibrated,
      tier: s.tier,
    }));
    if (!list || list.length === 0) {
      out.error = "血管モデルが登録されていない（3D QCA を先に走らせる必要がある）";
      finish(host, out);
      return;
    }

    // ── H11: 本体 ───────────────────────────────────────────────
    const model = host.getVesselModel();
    if (!model) {
      out.error = "getVesselModel() が null";
      finish(host, out);
      return;
    }
    out.model = {
      runId: model.runId,
      kind: model.kind,
      label: model.label,
      segmentIds: model.segments.map((s) => s.id),
      segmentPointCounts: model.segments.map((s) => s.points.length),
      // 🔑 径が null の点がどれだけあるか。FFR の入力になるかはここで決まる。
      diameterNullCounts: model.segments.map(
        (s) => s.diameterMm.filter((d) => d === null || d === undefined).length,
      ),
      diameterCalibrated: !!(model.calibration && model.calibration.diameterCalibrated),
      calibrationTiers: model.calibration ? model.calibration.tiers : null,
      diameterMethod: model.calibration ? model.calibration.diameterMethod : null,
      angleCorrected: model.provenance ? model.provenance.angleCorrected : null,
      // 中心線の向きの旗が無いので、両端の座標を記録して呼び出し側で判断するしかない。
      firstPoint: model.segments[0] ? model.segments[0].points[0] : null,
      lastPoint: model.segments[0]
        ? model.segments[0].points[model.segments[0].points.length - 1]
        : null,
    };

    // ── ダミーの計算 ────────────────────────────────────────────
    // 🔴 **これは FFR ではない。** 径が細いほど値が下がる、という見た目だけの当てずっぽう。
    //    本物は流体解析か学習モデルで、境界条件（心拍数・血圧・微小循環抵抗）が要る。
    const perPoint = [];
    for (const seg of model.segments) {
      const valid = seg.diameterMm.filter((d) => typeof d === "number" && isFinite(d) && d > 0);
      if (valid.length === 0) continue;
      const ref = Math.max.apply(null, valid);
      let drop = 0;
      for (let i = 0; i < seg.points.length; i++) {
        const d = seg.diameterMm[i];
        // 🔴 **径が無い点には値を入れない**（0 で埋めると「そこが詰まっている」に化ける）。
        if (typeof d !== "number" || !isFinite(d) || d <= 0) continue;
        // 細いところほど落ちる、という形だけ。単位も物理的意味も無い。
        drop += Math.max(0, 1 - Math.pow(d / ref, 4)) * 0.002;
        const value = Math.max(0.5, Math.min(1, 1 - drop));
        perPoint.push({ segmentId: seg.id, index: i, value: value });
      }
    }
    out.perPointCount = perPoint.length;

    // ── H12: 書き戻し ───────────────────────────────────────────
    const res = host.putVesselAnalysis(model.runId, {
      kind: "custom",
      label: "FFR (skeleton)",
      range: [0.5, 1.0],
      perPoint: perPoint,
      disclaimer:
        "⚠ これは FFR ではありません。径の比から作った当てずっぽうの値で、流体解析も" +
        "学習モデルも行っていません。臨床判断に使わないでください（骨組みの疎通確認用）。",
    });
    out.put = { ok: !!(res && res.ok), error: res && res.error ? res.error : null };
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  finish(host, out);
}

function finish(host, out) {
  window.__ffrSkeleton = out;
  // 画面にも出す（automator が「動いた」ことを DOM でも確認できるように）。
  try {
    const w = host.openWindow ? host.openWindow({ title: "FFR (skeleton)", width: 420, height: 260 }) : null;
    const root = w && (w.container || w.root);
    if (root) {
      const div = root.ownerDocument.createElement("div");
      div.setAttribute("data-testid", "ffr-skeleton-panel");
      div.style.font = "12px sans-serif";
      div.style.padding = "10px";
      div.textContent = out.error
        ? "NG: " + out.error
        : "OK: " + out.perPointCount + " 点に値を書きました（これは FFR ではありません）";
      root.appendChild(div);
    }
  } catch (e) {
    /* 窓が開けなくても本筋（H11/H12）は済んでいる */
  }
  if (host.notify) host.notify(out.error ? "ffr-skeleton: " + out.error : "ffr-skeleton: ok");
}
