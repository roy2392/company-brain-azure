import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3100,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
