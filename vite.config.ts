import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 宿主机端口通过环境变量 PORT 配置（docker compose 已映射）。
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: Number(process.env.PORT) || 5173,
  },
  preview: {
    host: true,
    port: Number(process.env.PORT) || 4173,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
