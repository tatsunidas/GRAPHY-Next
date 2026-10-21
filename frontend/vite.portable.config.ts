import path from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { portableStubs } from "./portable/stubPlugin";

// 本体の UI アイコン（相対 URL `icons/tools/...`）。段 2 では丸ごと入れ、使うものだけへの絞り込みは後で行う。
function copyIcons(): Plugin {
  return {
    name: "graphy-portable-icons",
    apply: "build",
    closeBundle() {
      cpSync(path.join(here, "public/icons/tools"), path.join(here, "portable-dist/icons/tools"), { recursive: true });
    },
  };
}

// 配信元（起動スクリプトのローカルサーバ）以外へは何も読みに行かせない。worker/wasm/blob だけ許可する。
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "graphy-portable-csp",
    apply: "build",
    transformIndexHtml: (html) => html.replace("</head>", `    <meta http-equiv="Content-Security-Policy" content="${csp}" />
  </head>`),
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "portable",
  base: "./",
  plugins: [portableStubs(path.join(here, "src"), path.join(here, "portable/src/shims")), react(), copyIcons(), cspPlugin()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@cornerstonejs/dicom-image-loader"], include: ["dicom-parser"] },
  build: { outDir: "../portable-dist", emptyOutDir: true, target: "esnext" },
});
