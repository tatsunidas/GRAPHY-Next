/* UVS (skeleton) v0.1.0 — 胎児心エコー動画の要約（UVS）
 * 研究・教育目的。診断機器ではありません。
 * このファイルは tools/build.mjs が src/ui/ から生成します。直接編集しないこと。
 */

// src/ui/ui.ts
function activate(host) {
  const out = {
    surface: host.surface || null,
    hasRunBackend: typeof host.runBackend === "function",
    targets: null,
    backend: null,
    error: null,
    pluginVersion: true ? "0.1.0" : void 0
  };
  const finish = () => {
    window.__uvsSkeleton = out;
    try {
      const w = host.openWindow ? host.openWindow({ title: "UVS (skeleton)", width: 460, height: 300 }) : null;
      const root = w && (w.container || w.root);
      if (root) {
        const div = root.ownerDocument.createElement("div");
        div.setAttribute("data-testid", "uvs-skeleton-panel");
        div.style.font = "12px sans-serif";
        div.style.padding = "10px";
        div.style.whiteSpace = "pre-wrap";
        div.textContent = out.error ? "NG: " + out.error : "OK: backend \u306B\u5230\u9054\u3057\u307E\u3057\u305F\uFF08\u89E3\u6790\u306F\u307E\u3060\u884C\u3044\u307E\u305B\u3093\uFF09\n" + JSON.stringify(out.backend, null, 1);
        root.appendChild(div);
      }
    } catch {
    }
    if (host.notify) host.notify(out.error ? "uvs-skeleton: " + out.error : "uvs-skeleton: ok");
  };
  try {
    const targets = (typeof host.getTargets === "function" ? host.getTargets() : []) ?? [];
    out.targets = targets.map((t) => ({
      seriesUid: t.seriesUid,
      sopInstanceUid: t.sopInstanceUid || null,
      modality: t.modality || null,
      kind: t.kind || null,
      sliceCount: t.sliceCount
    }));
    if (!out.hasRunBackend) {
      out.error = "host \u306B runBackend \u304C\u751F\u3048\u3066\u3044\u306A\u3044\uFF08standalone \u304B\u78BA\u8A8D\uFF09";
      finish();
      return;
    }
    const first = targets[0] ?? {};
    const parsed = (() => {
      if (first.apiBase || first.sopInstanceUid) {
        return { apiBase: first.apiBase || "", sop: first.sopInstanceUid || null };
      }
      const id = first.imageId || "";
      const m = /^[a-z]+:(https?:\/\/[^/]+)\/api\/instances\/([^/?&#]+)\//.exec(id);
      return m ? { apiBase: m[1], sop: m[2] } : { apiBase: "", sop: null };
    })();
    out.imageId = first.imageId || null;
    out.apiBase = parsed.apiBase;
    out.sopInstanceUid = parsed.sop;
    const req = window.__uvsRequest || {};
    host.runBackend(
      Object.assign(
        {
          probe: true,
          apiBase: parsed.apiBase,
          studyUid: first.studyUid || null,
          seriesUid: first.seriesUid || null,
          sopInstanceUid: parsed.sop
        },
        req
      )
    ).then((res) => {
      out.backend = res;
      finish();
    }).catch((e) => {
      out.error = "runBackend \u304C\u5931\u6557: " + String(e?.message ?? e);
      finish();
    });
  } catch (e) {
    out.error = String(e?.stack ?? e);
    finish();
  }
}
export {
  activate
};
