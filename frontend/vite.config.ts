import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// 本番ビルド時のみ index.html に厳格な Content-Security-Policy を注入する。
// dev(Vite/HMR は unsafe-eval を使う) には適用しない＝HMR を壊さない。
// 本番(Electron file:// / web)では eval 無し・スクリプトは self のみに制限。
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    // 'wasm-unsafe-eval' は WebAssembly(将来の Cornerstone3D コーデック)用。eval は許可しない狭い権限。
    "script-src 'self' 'wasm-unsafe-eval'",
    // インラインの style 属性を多用しているため style のみ unsafe-inline を許可（script より低リスク）
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // backend(localhost) へ接続。file:// 由来でも localhost を許可。
    "connect-src 'self' http://localhost:* http://127.0.0.1:*",
    // Cornerstone3D 等の Web Worker（blob: からの生成を許可）
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
  ].join("; ");
  return {
    name: "graphy-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`,
      );
    },
  };
}

// 設定値は .env（VITE_DEV_PORT / VITE_BACKEND_URL）から読む。
// base: "./" にすることで、Electron の file:// 読み込みでも資産パスが解決できる。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const devPort = Number(env.VITE_DEV_PORT ?? "5173");
  const backendUrl = env.VITE_BACKEND_URL ?? "http://localhost:8080";

  return {
    base: "./",
    plugins: [react(), cspPlugin()],
    // Cornerstone3D の dicom-image-loader はデコード用 Web Worker を ES module + 動的 import
    // （コーデックの遅延ロード）で構成するため、worker を ES 形式でバンドルする必要がある
    // （既定の iife はコード分割と非互換でビルドが失敗する）。
    worker: {
      format: "es",
    },
    // codec(WASM/emscripten グルー) や dicom-image-loader を事前バンドルから除外し、
    // ブラウザ向け解決に任せる（fs/path の node externalize 警告は無害）。
    optimizeDeps: {
      exclude: ["@cornerstonejs/dicom-image-loader"],
    },
    server: {
      port: devPort,
      // dev では /api を backend にプロキシし、ブラウザから同一オリジンで叩けるようにする。
      proxy: {
        "/api": backendUrl,
      },
    },
    build: {
      outDir: "dist",
      // WASM コーデックのトップレベル await を許可（esnext ターゲット）。
      target: "esnext",
    },
  };
});
