/**
 * 入室前デバイステスト UI (N7, DESIGN.md 4.1)。
 * マイク/カメラを選び、マイク音量メーターで実際に拾えているか確認する。
 * ブラウザ依存は `MediaDevicesProvider` 注入で切り離し、ロジックは devices.ts 側でテストする。
 *
 * D7: Tabs[マイク|カメラ] + DeviceMeter + Card で再構成。
 */
import { useEffect, useRef, useState } from "react";
import { toErrorMessage } from "@stagecast/shared";
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
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DeviceMeter,
  Label,
  Alert,
  FormField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@stagecast/ui";
import { Mic, Camera } from "@stagecast/ui/icons";

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
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState<string | undefined>();
  const meterRef = useRef<MicMeter | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);
  const smoothedRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewRef = useRef<CameraPreview | undefined>(undefined);

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
        setErr(toErrorMessage(e, "デバイスにアクセスできません"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        // プレビューはベストエフォート
      }
    })();
    return () => {
      stopped = true;
      if (videoRef.current) videoRef.current.srcObject = null;
      previewRef.current?.stop();
      previewRef.current = undefined;
    };
  }, [camId, provider]);

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
          const rounded = Math.round(smoothedRef.current * 100);
          setLevel((prev) => (prev === rounded ? prev : rounded));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // メーターはベストエフォート
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">デバイステスト</CardTitle>
      </CardHeader>
      <CardContent>
        {err && <Alert className="mb-4">{err}</Alert>}
        <Tabs defaultValue="mic">
          <TabsList className="mb-4">
            <TabsTrigger value="mic" className="gap-1.5">
              <Mic className="size-3.5" />
              マイク
            </TabsTrigger>
            <TabsTrigger value="camera" className="gap-1.5">
              <Camera className="size-3.5" />
              カメラ
            </TabsTrigger>
          </TabsList>

          <TabsContent value="mic" className="space-y-4">
            <FormField id="mic-select" label="マイクを選択">
              <Select value={micId ?? ""} onValueChange={onMic}>
                <SelectTrigger id="mic-select">
                  <SelectValue placeholder="マイクを選択" />
                </SelectTrigger>
                <SelectContent>
                  {microphones
                    // 権限付与前は deviceId が "" で来る。Radix は空文字の item を許さない。
                    .filter((d) => d.deviceId)
                    .map((d) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </FormField>
            <div className="space-y-1">
              <Label>音量レベル</Label>
              <DeviceMeter level={level / 100} size="lg" showDb />
            </div>
          </TabsContent>

          <TabsContent value="camera" className="space-y-4">
            <FormField id="camera-select" label="カメラを選択">
              <Select value={camId ?? ""} onValueChange={onCam}>
                <SelectTrigger id="camera-select">
                  <SelectValue placeholder="カメラを選択" />
                </SelectTrigger>
                <SelectContent>
                  {cameras
                    .filter((d) => d.deviceId)
                    .map((d) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </FormField>
            <div className="overflow-hidden rounded-lg border-2 border-preview-500 shadow-preview">
              <video
                ref={videoRef}
                className="block w-full max-w-sm bg-black"
                style={{ aspectRatio: "16/9", objectFit: "cover" }}
                autoPlay
                playsInline
                muted
                aria-label="カメラプレビュー"
              />
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
