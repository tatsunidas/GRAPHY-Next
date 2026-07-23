import { defineConfig, type Plugin } from "vite";

// Portable 2D Viewer 専用ビルド（fw/export-portable-viewer.md 方式 A）。
// - root = portable/ （独立 index.html・vanilla TS。React 本体アプリとは別バンドル）。
// - 出力 = portable-dist/ （後で Export の VIEWER/ として ZIP 同梱する成果物）。
// - base "./" で file:// 直開き・相対配置に対応。
// - dicom-image-loader の worker/optimizeDeps 事情は本体 vite.config.ts と同一。

// 本体 vite.config.ts と同じ: dev 配信時に UMD コーデックへ ESM default を付与。
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

// file:// 直開きでも動くよう、厳格すぎない CSP を注入（本体は Electron 前提でより厳格）。
// worker(blob:) と wasm-unsafe-eval を許可。connect-src は不要（サーバへ接続しない）。
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
  ].join("; ");
  return {
    name: "graphy-portable-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig({
  root: "portable",
  base: "./",
  plugins: [cspPlugin(), cornerstoneCodecEsm()],
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["@cornerstonejs/dicom-image-loader"],
    include: ["dicom-parser"],
  },
  build: {
    outDir: "../portable-dist",
    emptyOutDir: true,
    target: "esnext",
  },
});
