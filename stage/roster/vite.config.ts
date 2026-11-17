import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      // Vendor code changes rarely, so it gets its own long-cached files; a deploy only re-downloads app code.
      output: { manualChunks: { react: ["react", "react-dom"], supabase: ["@supabase/supabase-js"] } },
    },
  },
});
