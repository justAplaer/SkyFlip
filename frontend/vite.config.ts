import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: "index.html", archive: "archive.html" } } },
  server: {
    port: Number(process.env.SKYFLIP_FRONTEND_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": process.env.SKYFLIP_BACKEND_URL ?? "http://127.0.0.1:8000",
    },
  },
  preview: {
    port: Number(process.env.SKYFLIP_FRONTEND_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": process.env.SKYFLIP_BACKEND_URL ?? "http://127.0.0.1:8000",
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});