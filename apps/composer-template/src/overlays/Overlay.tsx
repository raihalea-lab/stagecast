import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

export interface OverlayState {
  kind: "qr" | "image" | "video";
  url: string;
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  sizePercent?: number;
  autoHideMs?: number;
}

interface Props {
  overlay: OverlayState | null;
  onAutoHide: () => void;
}

const POSITION_STYLES: Record<string, React.CSSProperties> = {
  "top-left": { top: 24, left: 24 },
  "top-right": { top: 24, right: 24 },
  "bottom-left": { bottom: 24, left: 24 },
  "bottom-right": { bottom: 24, right: 24 },
};

const DEFAULT_SIZE: Record<string, number> = {
  qr: 15,
  image: 20,
  video: 100,
};

export function Overlay({ overlay, onAutoHide }: Props) {
  const [visible, setVisible] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (overlay?.kind === "qr") {
      let cancelled = false;
      QRCode.toDataURL(overlay.url, { width: 512, margin: 2 }).then((url) => {
        if (!cancelled) setQrDataUrl(url);
      });
      return () => {
        cancelled = true;
      };
    }
    setQrDataUrl(null);
  }, [overlay?.kind, overlay?.url]);

  useEffect(() => {
    if (!overlay) {
      setVisible(false);
      return;
    }
    requestAnimationFrame(() => setVisible(true));
    if (overlay.autoHideMs && overlay.autoHideMs > 0) {
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(onAutoHide, 400);
      }, overlay.autoHideMs);
      return () => clearTimeout(timer);
    }
  }, [overlay, onAutoHide]);

  const handleVideoEnd = useCallback(() => {
    setVisible(false);
    setTimeout(onAutoHide, 400);
  }, [onAutoHide]);

  if (!overlay) return null;

  const size = overlay.sizePercent ?? DEFAULT_SIZE[overlay.kind] ?? 20;
  const isFullscreen = overlay.kind === "video" && size >= 100;

  return (
    <div
      style={{
        position: "absolute",
        zIndex: 20,
        ...(isFullscreen
          ? { inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }
          : { ...POSITION_STYLES[overlay.position], width: `${size}%` }),
        opacity: visible ? 1 : 0,
        transition: "opacity 0.35s ease",
        pointerEvents: "none",
      }}
    >
      {overlay.kind === "video" ? (
        <video
          src={overlay.url}
          autoPlay
          muted
          onEnded={handleVideoEnd}
          style={{
            width: isFullscreen ? "100%" : "100%",
            height: isFullscreen ? "100%" : "auto",
            objectFit: isFullscreen ? "contain" : "cover",
            borderRadius: isFullscreen ? 0 : 8,
            background: isFullscreen ? "#000" : "transparent",
          }}
        />
      ) : overlay.kind === "qr" ? (
        qrDataUrl && (
          <img
            src={qrDataUrl}
            alt="QR Code"
            style={{
              width: "100%",
              height: "auto",
              borderRadius: 8,
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
              background: "#fff",
              padding: 8,
            }}
          />
        )
      ) : (
        <img
          src={overlay.url}
          alt=""
          style={{
            width: "100%",
            height: "auto",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        />
      )}
    </div>
  );
}
