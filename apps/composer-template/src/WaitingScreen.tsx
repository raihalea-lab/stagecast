/**
 * WaitingScreen - publishing participant が 0 人の時に表示する待機画面。
 *
 * D11 刷新: 紺-赤-黄グラデを廃止し、完全黒地 + STAGECAST (Inter 600) +
 * ON AIR SHORTLY (mono) + hairline + tally dot (breathing) に変更。
 */
export function WaitingScreen() {
  return (
    <div className="waiting-screen">
      <h1 className="waiting-title">STAGECAST</h1>
      <p className="waiting-subtitle">ON AIR SHORTLY</p>
      <div className="waiting-hairline" />
      <div className="waiting-tally-dot" />
    </div>
  );
}
