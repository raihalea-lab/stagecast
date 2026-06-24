import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { loadRuntimeConfig } from "./config.js";
import "@stagecast/ui/styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// ランタイム設定 (/config.json) を読み込んでから描画する。dist は環境非依存。
void loadRuntimeConfig().then((config) => {
  createRoot(rootEl).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
});
