import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { loadRuntimeConfig } from "./config.js";
import "@stagecast/ui/styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

void loadRuntimeConfig().then((config) => {
  createRoot(rootEl).render(
    <StrictMode>
      <BrowserRouter>
        <App config={config} />
      </BrowserRouter>
    </StrictMode>,
  );
});
