import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// 設定値は .env（VITE_DEV_PORT / VITE_BACKEND_URL）から読む。
// base: "./" にすることで、Electron の file:// 読み込みでも資産パスが解決できる。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const devPort = Number(env.VITE_DEV_PORT ?? "5173");
  const backendUrl = env.VITE_BACKEND_URL ?? "http://localhost:8080";

  return {
    base: "./",
    plugins: [react()],
    server: {
      port: devPort,
      // dev では /api を backend にプロキシし、ブラウザから同一オリジンで叩けるようにする。
      proxy: {
        "/api": backendUrl,
      },
    },
    build: {
      outDir: "dist",
    },
  };
});
