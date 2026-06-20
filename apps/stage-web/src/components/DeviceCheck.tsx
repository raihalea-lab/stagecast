/**
 * 入室前デバイステスト UI (N7, DESIGN.md 4.1)。
 * マイク/カメラを選び、マイク音量メーターで実際に拾えているか確認する。
 * ブラウザ依存は `MediaDevicesProvider` 注入で切り離し、ロジックは devices.ts 側でテストする。
 */
import { useEffect, useRef, useState } from "react";
import {
  loadPreferredDevices,
  resolveSelected,
  savePreferredDevices,
  smoothLevel,
  splitDevices,
  type CameraPreview,
  type DeviceInfo,
  type KeyValueStore,
  type MediaDevicesProvider,
  type MicMeter,
  type PreferredDevices,
} from "../lib/devices.js";

function toPrefs(microphoneId?: string, cameraId?: string): PreferredDevices {
  const prefs: PreferredDevices = {};
  if (microphoneId) prefs.microphoneId = microphoneId;
  if (cameraId) prefs.cameraId = cameraId;
  return prefs;
}

export function DeviceCheck(props: {
  provider: MediaDevicesProvider;
  store?: KeyValueStore;
  onChange: (prefs: PreferredDevices) => void;
}) {
  const { provider, onChange } = props;
  const store = props.store ?? window.localStorage;
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [micId, setMicId] = useState<string | undefined>();
  const [camId, setCamId] = useState<string | undefined>();
  // メーターは 0..100 の整数% で保持し、値が変わったフレームだけ再描画する
  // (毎フレーム setState すると入室画面全体が 60fps で再描画されるため)。
  const [levelPct, setLevelPct] = useState(0);
  const [err, setErr] = useState<string | undefined>();
  const meterRef = useRef<MicMeter | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);
  const smoothedRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewRef = useRef<CameraPreview | undefined>(undefined);

  // 初回: 権限要求 + 列挙 + 保存済み選択の復元。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await provider.list();
        if (cancelled) return;
        const saved = loadPreferredDevices(store);
        const { microphones, cameras } = splitDevices(list);
        const m = resolveSelected(microphones, saved.microphoneId);
        const c = resolveSelected(cameras, saved.cameraId);
        setDevices(list);
        setMicId(m);
        setCamId(c);
        onChange(toPrefs(m, c));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "デバイスにアクセスできません");
      }
    })();
    return () => {
      cancelled = true;
    };
    // 初回のみ実行する (provider/store/onChange は安定参照を前提)。
  }, []);

  // 選択カメラが変わるたびにプレビュー stream を開き直す (N7 入室前プレビュー)。
  useEffect(() => {
    let stopped = false;
    void (async () => {
      if (!camId) return;
      try {
        const preview = await provider.openCameraPreview(camId);
        if (stopped) {
          preview.stop();
          return;
        }
        previewRef.current = preview;
        if (videoRef.current) {
          videoRef.current.srcObject = preview.stream;
        }
      } catch {
        // プレビューはベストエフォート (権限拒否などは無視)。
      }
    })();
    return () => {
      stopped = true;
      if (videoRef.current) videoRef.current.srcObject = null;
      previewRef.current?.stop();
      previewRef.current = undefined;
    };
  }, [camId, provider]);

  // 選択マイクが変わるたびにメーターを開き直す。
  useEffect(() => {
    let stopped = false;
    void (async () => {
      if (!micId) return;
      try {
        const meter = await provider.openMicMeter(micId);
        if (stopped) {
          meter.stop();
          return;
        }
        meterRef.current = meter;
        const tick = () => {
          smoothedRef.current = smoothLevel(smoothedRef.current, meter.level());
          const pct = Math.round(smoothedRef.current * 100);
          setLevelPct((prev) => (prev === pct ? prev : pct));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // メーターはベストエフォート (権限拒否などは無視)。
      }
    })();
    return () => {
      stopped = true;
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
      meterRef.current?.stop();
      meterRef.current = undefined;
    };
  }, [micId, provider]);

  const onMic = (id: string) => {
    setMicId(id);
    const prefs = toPrefs(id, camId);
    savePreferredDevices(store, prefs);
    onChange(prefs);
  };
  const onCam = (id: string) => {
    setCamId(id);
    const prefs = toPrefs(micId, id);
    savePreferredDevices(store, prefs);
    onChange(prefs);
  };

  const { microphones, cameras } = splitDevices(devices);
  return (
    <section className="device-check">
      <h2>デバイステスト</h2>
      {err && <p className="error">{err}</p>}
      <label>
        マイク
        <select value={micId ?? ""} onChange={(e) => onMic(e.target.value)}>
          {microphones.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mic-meter" aria-label="マイク音量レベル">
        <div className="mic-meter-bar" style={{ width: `${levelPct}%` }} />
      </div>
      <label>
        カメラ
        <select value={camId ?? ""} onChange={(e) => onCam(e.target.value)}>
          {cameras.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <video
        ref={videoRef}
        className="camera-preview"
        autoPlay
        playsInline
        muted
        aria-label="カメラプレビュー"
      />
    </section>
  );
}
