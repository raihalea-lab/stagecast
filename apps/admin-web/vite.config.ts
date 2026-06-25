import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      "@schedule-x/react",
      "@schedule-x/calendar",
      "@schedule-x/theme-default",
    ],
  },
});
