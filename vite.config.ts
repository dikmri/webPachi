import { defineConfig } from "vite";

// GitHub Pages はサブパス配信のため相対ベースにする
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
    // マルチページ構成: 本編(index.html)と盤面エディタ(editor.html)を両方ビルドする
    rollupOptions: {
      input: {
        main: import.meta.dirname + "/index.html",
        editor: import.meta.dirname + "/editor.html",
      },
    },
  },
  // 作業フォルダ完結: キャッシュもプロジェクト内に置く
  cacheDir: "./runtime/vite-cache",
});
