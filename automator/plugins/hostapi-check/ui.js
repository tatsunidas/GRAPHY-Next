/*
 * 実機検証用プラグイン（第三者プラグインと同じ経路＝plugins/ フォルダ直下に置いて
 * backend の /api/plugins から配信される ES モジュール）。
 *
 * host API H1/H2（fw/plugin-architecture.md §7）だけを使い、DOM を一切覗かずに
 * 「いま何を見ているか」を取得できることを確認する。結果は
 *   - window.__hostApiCheck  … automator が page.evaluate で読む
 *   - 画面右上のパネル        … スクリーンショットで人が読む
 * の両方へ出す。
 */
/** Float32Array の要約（生配列を全部持ち回らずに検証できるようにする）。 */
function summarize(px) {
  if (!px) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of px.data) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const n = px.data.length;
  return {
    imageId: px.imageId,
    sliceIndex: px.sliceIndex,
    rows: px.rows,
    cols: px.cols,
    unit: px.unit,
    spacing: px.spacing,
    length: n,
    isFloat32: px.data instanceof Float32Array,
    min,
    max,
    mean: sum / n,
    // 中央画素（body 内部＝空気ではないはず）。
    center: px.data[Math.floor(px.rows / 2) * px.cols + Math.floor(px.cols / 2)],
  };
}

export async function activate(host) {
  if (host.surface !== "viewer2d.menu" && host.surface !== "viewer2d.toolbar") return;

  const targets = host.getTargets();
  const payload = {
    at: new Date().toISOString(),
    // DOM 依存なし: 公式契約だけで対象タイルを列挙できるか。
    targets,
    // tileId 指定と省略（=対象の先頭）の両方。
    states: targets.map((t) => host.getViewState(t.tileId)),
    defaultState: host.getViewState(),
    unknownTile: host.getViewState("no-such-tile"),
    // H3: 校正済み画素。表示中スライス / 別スライス指定 / 範囲外 / 未知タイル。
    pixels: summarize(await host.getPixelData()),
    pixelsSlice0: summarize(await host.getPixelData(targets[0]?.tileId, { sliceIndex: 0 })),
    pixelsOutOfRange: await host.getPixelData(targets[0]?.tileId, { sliceIndex: 9999 }),
    pixelsUnknownTile: await host.getPixelData("no-such-tile"),
  };

  // H4a: 読んだ画素から閾値マスクを作って重ねる（NaN=透明）。サイズ不一致は拒否されること。
  const px = await host.getPixelData();
  if (px) {
    const mask = new Float32Array(px.data.length);
    let hit = 0;
    for (let i = 0; i < px.data.length; i++) {
      if (px.data[i] >= 300) {
        mask[i] = px.data[i];
        hit++;
      } else {
        mask[i] = NaN;
      }
    }
    payload.overlay = {
      shown: host.showOverlay(px.tileId, {
        data: mask,
        rows: px.rows,
        cols: px.cols,
        window: { center: 800, width: 1000 },
        // 本体の LUT 資産で色付けさせる（白い骨の上に白を重ねても人には見えないため）。
        colormap: "Hot_Iron",
        opacity: 0.6,
      }),
      hit,
      // 格子が合わないマップは拒否されるべき（勝手に伸縮しない）。
      mismatchRejected:
        host.showOverlay(px.tileId, { data: new Float32Array(4), rows: 2, cols: 2 }) === false,
      unknownTileRejected: host.showOverlay("no-such-tile", {
        data: mask,
        rows: px.rows,
        cols: px.cols,
      }) === false,
    };
  }
  // --- H5: ユーザーが描いた ROI（計測）の読み出し ---
  // 購読は activate ごとに張り直さない（メニューは何度も押される）。1 本だけ張って発火回数を数える。
  if (!window.__hostApiRoiWatch) {
    var watch = { events: 0, unsub: null };
    watch.unsub = host.subscribeRois(function () {
      watch.events++;
    });
    window.__hostApiRoiWatch = watch;
  }

  var rois = host.getRois();
  payload.rois = rois.map(function (r) {
    // 長径・短径の自己整合を **プラグイン側でも** 検算する: points（画素座標）× spacing から
    // 直接求めた最遠 2 点間距離が、本体が返す longAxisMm と一致するはず。
    var sx = r.spacing[0];
    var sy = r.spacing[1];
    var maxSq = 0;
    if (sx && sy) {
      for (var i = 0; i < r.points.length; i++) {
        for (var j = i + 1; j < r.points.length; j++) {
          var dx = (r.points[j][0] - r.points[i][0]) * sx;
          var dy = (r.points[j][1] - r.points[i][1]) * sy;
          var d2 = dx * dx + dy * dy;
          if (d2 > maxSq) maxSq = d2;
        }
      }
    }
    return {
      roiUid: r.roiUid,
      tool: r.tool,
      label: r.label,
      tileId: r.tileId,
      studyUid: r.studyUid,
      studyDate: r.studyDate,
      seriesUid: r.seriesUid,
      sopInstanceUid: r.sopInstanceUid,
      sliceIndex: r.sliceIndex,
      zScope: r.zScope,
      c: r.c,
      t: r.t,
      pointCount: r.points.length,
      spacing: r.spacing,
      measurements: r.measurements,
      visible: r.visible,
      // プラグイン側で独立に計算した長径（本体の longAxisMm と一致すべき）。
      recomputedLongMm: maxSq > 0 ? Math.sqrt(maxSq) : null,
    };
  });
  payload.roisUnknownTile = host.getRois("no-such-tile");
  payload.roiEvents = window.__hostApiRoiWatch.events;

  // ROI 属性の往復と、購読の解除が本当に効くか。
  if (rois.length > 0) {
    var uid = rois[0].roiUid;
    var tmp = 0;
    var un = host.subscribeRois(function () {
      tmp++;
    });
    var wrote = host.setRoiMeta(uid, { trackingId: "1", lymphNode: "true" });
    // **書いた直後**に読む（後段でもう一度書くので、順序を間違えると検証がずれる）。
    var readBack = host.getRoiMeta(uid);
    var afterSub = tmp;
    un();
    // 解除後の書き込み。既存キーはマージ更新（trackingId だけ変わり lymphNode は残る）。
    host.setRoiMeta(uid, { trackingId: "2" });
    payload.roiMeta = {
      wrote: wrote,
      readBack: readBack,
      merged: host.getRoiMeta(uid),
      writeUnknownRoi: host.setRoiMeta("no-such-roi", { a: "1" }),
      readUnknownRoi: host.getRoiMeta("no-such-roi"),
      subscribeFired: afterSub > 0,
      // 解除後は増えないこと。
      unsubscribeWorks: tmp === afterSub,
    };
  }

  window.__hostApiCheck = payload;

  const id = "hostapi-check-panel";
  document.getElementById(id)?.remove();
  const el = document.createElement("div");
  el.id = id;
  el.setAttribute("data-testid", id);
  el.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:99999;max-width:520px;padding:8px 10px;" +
    "background:#111c;color:#e8e8e8;font:11px/1.5 monospace;border:1px solid #4a90d9;" +
    "border-radius:4px;white-space:pre-wrap";
  const p = payload.pixels;
  const lines = ["[hostapi-check] targets=" + targets.length + " rois=" + payload.rois.length];
  for (const r of payload.rois) {
    const m = r.measurements;
    const mm = (v) => (v === undefined || v === null ? "-" : v.toFixed(2) + "mm");
    lines.push(
      "  roi[" + r.tool + "] slice=" + (r.sliceIndex + 1) + " zScope=" + r.zScope +
      "\n    tool: length=" + mm(m.length) + " short=" + mm(m.shortAxis) +
      "\n    shape: long=" + mm(m.longAxisMm) + " short=" + mm(m.shortAxisMm) +
      " (recomputed long=" + mm(r.recomputedLongMm) + ")" +
      "\n    sop=" + String(r.sopInstanceUid).slice(0, 48) + " points=" + r.pointCount,
    );
  }
  if (p) {
    lines.push(
      "  pixels: " + p.cols + "x" + p.rows + " " + p.unit +
      " min=" + p.min.toFixed(0) + " max=" + p.max.toFixed(0) +
      " mean=" + p.mean.toFixed(1) + " center=" + p.center.toFixed(0) +
      "\n    spacing=[" + p.spacing.join(", ") + "] float32=" + p.isFloat32,
    );
  }
  for (const t of targets) {
    const v = host.getViewState(t.tileId);
    lines.push(
      "  tile=" + t.tileId +
      "\n    series=" + t.seriesLabel + " (" + t.modality + ")" +
      "\n    slice=" + (t.sliceIndex + 1) + "/" + t.sliceCount + "  c=" + t.c + " t=" + t.t +
      "\n    studyUid=" + t.studyUid +
      "\n    seriesUid=" + t.seriesUid +
      "\n    imageId=" + String(t.imageId).slice(0, 72) +
      (v
        ? "\n    W/L=" + v.windowWidth.toFixed(0) + "/" + v.windowCenter.toFixed(0) + " " + v.unit +
          "\n    lut=" + v.colormap + " invert=" + v.invert + " flipH=" + v.flipH + " flipV=" + v.flipV +
          "\n    rot=" + v.rotation + " zoom=" + v.zoom.toFixed(3) + " pan=[" + v.pan.map((n) => n.toFixed(1)).join(", ") + "]"
        : "\n    (view state unavailable)"),
    );
  }
  el.textContent = lines.join("\n");
  document.body.appendChild(el);
}
