import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "@stagecast/ui/styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

async function loadConfig(): Promise<{ controlApiUrl: string }> {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) return (await res.json()) as { controlApiUrl: string };
  } catch {
    // ローカル開発
  }
  return { controlApiUrl: "" };
}

void loadConfig().then((config) => {
  createRoot(rootEl).render(
    <StrictMode>
      <App controlApiUrl={config.controlApiUrl} />
    </StrictMode>,
  );
});
