/*
 * UVS（胎児心エコー動画要約）— `fw/uvs-plugin-design.md` 段 6。
 *
 * 段 2〜5 は「JAR 面の継ぎ目が通っているか」を確かめる骨組みだった。ここから画面が乗る。
 *
 * 🔑 **この骨組みの振る舞いは変えない**（段 6-5 は TS 化だけ）。`window.__uvsSkeleton` に
 *    結果を置き、`window.__uvsRequest` の指示を**丸ごと**backend へ転送する作法は、
 *    段 2〜5 の 40 検査がそのまま乗っている契約である。
 *
 * ⚠️ このファイルは `tools/build.mjs` が `ui.js` にバンドルする。**`ui.js` を直接編集しない。**
 */
import type { ViewerTarget, Viewer2DPluginHost } from "../../graphy-plugin";
import { mountPanel } from "./panel";

/** ビルド時に埋まるプラグインの版（`tools/build.mjs` の define）。 */
declare const __PLUGIN_VERSION__: string;

/** automator が読む結果。段 2〜5 の検査がこの形に依存している。 */
interface SkeletonOut {
  surface: string | null;
  hasRunBackend: boolean;
  targets:
    | {
        seriesUid: string;
        sopInstanceUid: string | null;
        modality: string | null;
        kind: string | null;
        sliceCount: number;
      }[]
    | null;
  backend: unknown;
  error: string | null;
  imageId?: string | null;
  apiBase?: string;
  sopInstanceUid?: string | null;
  pluginVersion?: string;
}

type UnknownRecord = Record<string, unknown>;

// このプラグインは `viewer2d.menu` にしか出さない（plugin.json の contributes）。
export function activate(host: Viewer2DPluginHost): void {
  const out: SkeletonOut = {
    surface: host.surface || null,
    hasRunBackend: typeof host.runBackend === "function",
    targets: null,
    backend: null,
    error: null,
    pluginVersion: typeof __PLUGIN_VERSION__ === "string" ? __PLUGIN_VERSION__ : undefined,
  };

  /**
   * 窓を開く。
   *
   * 🔑 **automator が指示（`__uvsRequest`）を置いているときは、画面を出さずに素の結果を見せる。**
   *    段 2〜5 の 40 検査は 1 回のクリックにつき 1 回の `run()` を前提にしており、画面が自分で
   *    `op:"info"` を投げると往復の数が変わってしまう。利用者の経路（指示なし）では**画面を出す**
   *    ——どちらも実機検査が通る（画面は検査 9-x が押す）。
   */
  const finish = (): void => {
    (window as unknown as { __uvsSkeleton?: SkeletonOut }).__uvsSkeleton = out;
    try {
      const automatorMode = !!(window as unknown as { __uvsRequest?: unknown }).__uvsRequest;
      const w = host.openWindow
        ? host.openWindow({
            title: "UVS",
            width: automatorMode ? 460 : 560,
            height: automatorMode ? 300 : 720,
          })
        : null;
      const root = w && ((w as { container?: HTMLElement }).container || (w as { root?: HTMLElement }).root);
      if (root && !automatorMode && !out.error && out.sopInstanceUid) {
        mountPanel(root, host, {
          apiBase: out.apiBase ?? "",
          sopInstanceUid: out.sopInstanceUid ?? null,
        });
      } else if (root) {
        const div = root.ownerDocument.createElement("div");
        div.setAttribute("data-testid", "uvs-skeleton-panel");
        div.style.font = "12px sans-serif";
        div.style.padding = "10px";
        div.style.whiteSpace = "pre-wrap";
        div.textContent = out.error
          ? "NG: " + out.error
          : "OK: backend に到達しました\n" + JSON.stringify(out.backend, null, 1);
        root.appendChild(div);
      }
    } catch {
      /* 窓が開けなくても本筋は済んでいる */
    }
    if (host.notify) host.notify(out.error ? "uvs: " + out.error : "uvs: ok");
  };

  try {
    // どの検査を見ているか（対象の SOP を backend に渡す）。
    const targets = (typeof host.getTargets === "function" ? host.getTargets() : []) ?? [];
    out.targets = targets.map((t: ViewerTarget) => ({
      seriesUid: t.seriesUid,
      sopInstanceUid: t.sopInstanceUid || null,
      modality: t.modality || null,
      kind: t.kind || null,
      sliceCount: t.sliceCount,
    }));

    if (!out.hasRunBackend) {
      out.error = "host に runBackend が生えていない（standalone か確認）";
      finish();
      return;
    }

    const first = (targets[0] ?? {}) as Partial<ViewerTarget>;

    // 🔑 **API のベース URL と SOP UID は host が渡してくれる**（0.2.9 で H1 に追加）。
    //    JAR 側は自分の backend のポートを知らない（`run()` に渡るのは要求本文だけ）ので、
    //    フロントが渡すしかない。段 2 でこれを渡し忘れ、`/rendered` を確認できなかった。
    //
    //    ⚠️ **0.2.8 以前の host には無い**ので、そのときだけ imageId から削り出す
    //    （形: `wadouri:http://localhost:18090/api/instances/<sop>/file[&frame=N]`）。
    //    🔴 **動画タイルには imageId が無い**——UVS の入力である US Multi-frame(H.264) は
    //    動画再生器に出るので、フォールバックの正規表現はそこでは効かない。
    const parsed = ((): { apiBase: string; sop: string | null } => {
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

    // 解析の指示は automator が仕込む（`window.__uvsRequest`）。既定は疎通確認のみ。
    //
    // 🔴 **指示は丸ごと転送する。** 最初は `analyze` 系だけを列挙して渡しており、
    //    段 4 で足した `roi` / `stride` / `frameIndex` が**黙って落ちていた**
    //    （backend は「指示が無い」として何も返さず、検査は空の結果を見ていた）。
    //    鍵を 1 つ足すたびに 2 箇所を直す作りにしない。
    const req = (window as unknown as { __uvsRequest?: UnknownRecord }).__uvsRequest || {};
    host
      .runBackend(
        Object.assign(
          {
            probe: true,
            apiBase: parsed.apiBase,
            studyUid: first.studyUid || null,
            seriesUid: first.seriesUid || null,
            sopInstanceUid: parsed.sop,
          },
          req,
        ),
      )
      .then((res: unknown) => {
        out.backend = res;
        finish();
      })
      .catch((e: unknown) => {
        // 🔴 **失敗を握り潰さない。** JAR が読まれていない／例外が出た、はここに出る。
        out.error = "runBackend が失敗: " + String((e as { message?: string })?.message ?? e);
        finish();
      });
  } catch (e) {
    out.error = String((e as { stack?: string })?.stack ?? e);
    finish();
  }
}
