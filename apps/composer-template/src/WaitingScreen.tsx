/**
 * WaitingScreen - publishing participant が 0 人の時に表示する待機画面 (ADR 0012 D-5, 要件 3)。
 *
 * 「誰も投影してなくても何かしらの配信が続いているように」見せるための fallback。
 * R15 では静的なテキスト + アニメーション背景。 R16 以降で admin から
 * テキスト・ロゴ・BGM を data channel で動的設定できるようにする。
 *
 * 注: YouTube Live は完全無音のストリームを「異常」と判定して切断する場合がある。
 * R15 では HTML `<audio>` で常時無音を再生せず (mute publish と区別できない可能性)、
 * 静的な背景音は次の R で検討。
 */
export function WaitingScreen() {
  return (
    <div
      className="waiting-screen"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #1a2a6c 0%, #b21f1f 50%, #fdbb2d 100%)",
        color: "#fff",
        fontFamily: "sans-serif",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: 64, margin: 0, textShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>
        Stagecast
      </h1>
      <p style={{ fontSize: 28, marginTop: 24, opacity: 0.9 }}>まもなく配信を開始します</p>
      <div
        className="pulse"
        style={{
          marginTop: 48,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          opacity: 0.8,
          animation: "pulse 1.6s ease-in-out infinite",
        }}
      />
    </div>
  );
}
