/*
 * UVS（胎児心エコー動画要約）の骨組み — `fw/uvs-plugin-design.md` の段 2。
 *
 * 🔴 **解析はまだしない。** ここで確かめるのは **JAR 面の継ぎ目**だけ:
 *    JAR が読まれて `run()` が呼ばれるか、そして**この先の段で必要なものが揃っているか**。
 *
 *    本体側に JAR 面のプラグインの実例が無い（社外のデモ 1 本だけ）ので、
 *    **穴があるとしたらここで出る**。
 *
 * 結果は `window.__uvsSkeleton` に置く（automator が読む）。
 */
export function activate(host) {
  const out = {
    surface: host.surface || null,
    hasRunBackend: typeof host.runBackend === "function",
    targets: null,
    backend: null,
    error: null,
  };

  const finish = () => {
    window.__uvsSkeleton = out;
    try {
      const w = host.openWindow
        ? host.openWindow({ title: "UVS (skeleton)", width: 460, height: 300 })
        : null;
      const root = w && (w.container || w.root);
      if (root) {
        const div = root.ownerDocument.createElement("div");
        div.setAttribute("data-testid", "uvs-skeleton-panel");
        div.style.font = "12px sans-serif";
        div.style.padding = "10px";
        div.style.whiteSpace = "pre-wrap";
        div.textContent = out.error
          ? "NG: " + out.error
          : "OK: backend に到達しました（解析はまだ行いません）\n" +
            JSON.stringify(out.backend, null, 1);
        root.appendChild(div);
      }
    } catch (e) {
      /* 窓が開けなくても本筋は済んでいる */
    }
    if (host.notify) host.notify(out.error ? "uvs-skeleton: " + out.error : "uvs-skeleton: ok");
  };

  try {
    // どの検査を見ているか（対象の SOP を backend に渡す）。
    const targets = typeof host.getTargets === "function" ? host.getTargets() : [];
    out.targets = (targets || []).map((t) => ({
      seriesUid: t.seriesUid,
      sopInstanceUid: t.sopInstanceUid || null,
      modality: t.modality || null,
      sliceCount: t.sliceCount,
    }));

    if (!out.hasRunBackend) {
      out.error = "host に runBackend が生えていない（standalone か確認）";
      finish();
      return;
    }

    const first = (targets || [])[0] || {};
    host
      .runBackend({
        probe: true,
        studyUid: first.studyUid || null,
        seriesUid: first.seriesUid || null,
        sopInstanceUid: first.sopInstanceUid || null,
      })
      .then((res) => {
        out.backend = res;
        finish();
      })
      .catch((e) => {
        // 🔴 **失敗を握り潰さない。** JAR が読まれていない／例外が出た、はここに出る。
        out.error = "runBackend が失敗: " + String((e && e.message) || e);
        finish();
      });
  } catch (e) {
    out.error = String((e && e.stack) || e);
    finish();
  }
}
