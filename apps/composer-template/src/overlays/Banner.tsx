import { useEffect, useState } from "react";

export interface BannerState {
  text: string;
  subtext?: string;
  position: "bottom" | "top";
  autoHideMs?: number;
}

interface Props {
  banner: BannerState | null;
  onAutoHide: () => void;
}

export function Banner({ banner, onAutoHide }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!banner) {
      setVisible(false);
      return;
    }
    requestAnimationFrame(() => setVisible(true));
    if (banner.autoHideMs && banner.autoHideMs > 0) {
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(onAutoHide, 400);
      }, banner.autoHideMs);
      return () => clearTimeout(timer);
    }
  }, [banner, onAutoHide]);

  if (!banner) return null;

  const isTop = banner.position === "top";

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        ...(isTop ? { top: 0 } : { bottom: 0 }),
        zIndex: 10,
        display: "flex",
        justifyContent: "center",
        padding: "24px 48px",
        pointerEvents: "none",
        transform: visible ? "translateY(0)" : isTop ? "translateY(-100%)" : "translateY(100%)",
        opacity: visible ? 1 : 0,
        transition: "transform 0.35s ease, opacity 0.35s ease",
      }}
    >
      <div
        style={{
          background: "rgba(0, 0, 0, 0.75)",
          backdropFilter: "blur(8px)",
          borderRadius: 8,
          padding: "12px 32px",
          maxWidth: "80%",
          textAlign: "center",
        }}
      >
        <div
          style={{
            color: "#fff",
            fontSize: 28,
            fontWeight: 700,
            lineHeight: 1.3,
          }}
        >
          {banner.text}
        </div>
        {banner.subtext && (
          <div
            style={{
              color: "rgba(255,255,255,0.7)",
              fontSize: 18,
              fontWeight: 400,
              marginTop: 4,
              lineHeight: 1.3,
            }}
          >
            {banner.subtext}
          </div>
        )}
      </div>
    </div>
  );
}
