import { defineConfig } from "vite";

// GitHub Pages はサブパス配信のため相対ベースにする
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
  },
  // 作業フォルダ完結: キャッシュもプロジェクト内に置く
  cacheDir: "./runtime/vite-cache",
});
