import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// electron-vite bundles the three Electron layers together with HMR. The
// security model (contextIsolation/sandbox) lives in src/main/index.ts, not here.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, "src/main/index.ts") },
    },
  },
  preload: {
    build: {
      lib: {
        entry: {
          index: resolve(__dirname, "src/preload/index.ts"),
          workbench: resolve(__dirname, "src/preload/workbench.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          workbench: resolve(__dirname, "src/renderer/workbench.html"),
        },
      },
    },
    plugins: [react()],
  },
});
