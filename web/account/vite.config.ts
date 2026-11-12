import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// https://vitejs.dev/config/
export default defineConfig({
  base: "/account/",
  plugins: [
    react(),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      generatedRouteTree: "./src/route-tree.gen.ts",
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
