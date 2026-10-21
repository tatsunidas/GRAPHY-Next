import path from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { portableStubs } from "./portable-app/stubPlugin";

// 本体の UI アイコン（相対 URL `icons/tools/...`）。段 2 では丸ごと入れ、使うものだけへの絞り込みは後で行う。
function copyIcons(): Plugin {
  return {
    name: "graphy-portable-icons",
    apply: "build",
    closeBundle() {
      cpSync(path.join(here, "public/icons/tools"), path.join(here, "portable-app-dist/icons/tools"), { recursive: true });
    },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "portable-app",
  base: "./",
  plugins: [portableStubs(path.join(here, "src"), path.join(here, "portable-app/src/shims")), react(), copyIcons()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@cornerstonejs/dicom-image-loader"], include: ["dicom-parser"] },
  build: { outDir: "../portable-app-dist", emptyOutDir: true, target: "esnext" },
});
