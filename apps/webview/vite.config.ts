import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

export default defineConfig({
  plugins: [vue()],
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "../extension/media/webview"),
    emptyOutDir: true
  }
});
