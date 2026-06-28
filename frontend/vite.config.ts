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

// dev 専用: Cornerstone3D の WASM コーデック(@cornerstonejs/codec-*)は UMD/CJS で、
// `var <NAME> = (() => {...})()` ＋末尾の `module.exports = <NAME>` 形式。dev で素の ESM として
// 配信されると `default` が無く「does not provide an export named 'default'」でデコードに失敗する。
// dicom-image-loader 本体は worker のため exclude が必須なので、配下コーデックにだけ
// ESM の default を付与して両立させる（build は Rollup の CJS interop が効くため不要＝serve 限定）。
function cornerstoneCodecEsm(): Plugin {
  const isCodec = (id: string) => /@cornerstonejs[\\/]codec-[^\\/]+[\\/]dist[\\/][^\\/]+\.js$/.test(id);
  return {
    name: "graphy-cs-codec-esm",
    apply: "serve",
    transform(code, id) {
      const clean = id.split("?")[0];
      if (!isCodec(clean) || /export\s+default/.test(code)) return null;
      const m = code.match(/var\s+(\w+)\s*=\s*\(\(\)\s*=>/);
      if (!m) return null;
      return { code: `${code}\nexport default ${m[1]};\n`, map: null };
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
    plugins: [react(), cspPlugin(), cornerstoneCodecEsm()],
    // Cornerstone3D の dicom-image-loader はデコード用 Web Worker を ES module + 動的 import
    // （コーデックの遅延ロード）で構成するため、worker を ES 形式でバンドルする必要がある
    // （既定の iife はコード分割と非互換でビルドが失敗する）。
    worker: {
      format: "es",
    },
    optimizeDeps: {
      // dicom-image-loader は Web Worker(?worker_file)を内包し dep-optimizer と非互換のため除外する
      // （include すると "decodeImageFrameWorker.js が .vite/deps に無い" エラーになる）。
      // 除外すると配下の UMD コーデックに default が無くなる問題は cornerstoneCodecEsm() で補う。
      exclude: ["@cornerstonejs/dicom-image-loader"],
      // dicom-parser は UMD（package.json の module も UMD を指す）。明示 include しないと
      // 「excluded loader の依存」として中途半端に最適化され、esbuild が top-level this を undefined に
      // 書換えて UMD の global 分岐 `e.zlib` で落ちる。明示 include で CJS として正しく interop させる。
      include: ["dicom-parser"],
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
