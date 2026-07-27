import { defineConfig } from "vitest/config";

// vite.config.ts を継承しないのは意図的。あちらは Cornerstone3D 向けの optimizeDeps / worker /
// CSP プラグインを積んでおり、純ロジックの単体テストには不要（かつ起動が重い）。
// UI コンポーネントのテストを足す段階になったら jsdom 環境と react プラグインを追加する。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "portable/src/**/*.test.ts"],
  },
});
