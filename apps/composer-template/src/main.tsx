/**
 * Composer Template - Egress エントリポイント (ADR 0012 D-1)。
 *
 * LiveKit Egress の Chrome ヘッドレスから以下の URL で開かれる:
 *   {template_base}?layout={layout}&token={JWT}&url={ws_url}
 * 例: https://cloudfront.example/composer/?layout=grid&token=...&url=wss%3A%2F%2F...
 *
 * URL パラメータから LiveKit 接続情報を読み、 `<Composer />` に渡して描画する。
 * 不正な URL パラメータの場合はエラー画面を出し、 Egress の Chrome がクラッシュして
 * 再起動ループに入らないようにする (描画は続行)。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "./Composer.js";
import { ALL_LAYOUTS, type LayoutKind } from "@stagecast/shared";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

const params = new URLSearchParams(window.location.search);
const token = params.get("token");
const url = params.get("url");
// layout は admin-web からの data channel 受信で動的に切替可能だが、 初期値は
// URL パラメータから取る (LiveKit Egress が template URL を組み立てるときに渡す)。
// 不正値 (LiveKit Egress が新しい layout を勝手に送る場合に備えて) は grid に fallback。
const rawLayout = params.get("layout") ?? "grid";
const initialLayout: LayoutKind = ALL_LAYOUTS.includes(rawLayout as LayoutKind)
  ? (rawLayout as LayoutKind)
  : "grid";

if (!token || !url) {
  // Egress の Chrome は invalid URL でもクラッシュしないように、 エラー画面で fallback。
  createRoot(rootEl).render(
    <div style={{ color: "#fff", background: "#111", padding: 24, fontFamily: "sans-serif" }}>
      Missing required URL params: token / url
    </div>,
  );
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <Composer token={token} url={url} initialLayout={initialLayout} />
    </StrictMode>,
  );
}
