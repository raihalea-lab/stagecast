/**
 * イベント詳細: 素材アップロード・招待URL発行・配信開始/終了 (DESIGN.md 8 章, 7.1, 4.1)。
 */
import { useState } from "react";
import type { EventDefinition, InvitedRole } from "@stagecast/shared";
import type {
  Artifact,
  ArtifactService,
  AssetService,
  ControlApiClient,
  IssuedInvite,
} from "../api/types.js";
import { toErrorMessage } from "../lib/errors.js";
import { LayoutControl } from "./LayoutControl.js";
import { LivePreview } from "./LivePreview.js";

export function EventDetail(props: {
  event: EventDefinition;
  client: ControlApiClient;
  assets: AssetService;
  artifacts: ArtifactService;
  /** R17: composer-template の URL (LivePreview iframe で使う、 runtime config 由来)。 */
  composerTemplateUrl?: string;
  onChanged: () => void;
}) {
  const { event, client, assets, artifacts, composerTemplateUrl, onChanged } = props;
  const [invites, setInvites] = useState<IssuedInvite[]>([]);
  const [artifactList, setArtifactList] = useState<Artifact[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [egressInfo, setEgressInfo] = useState<{ egressId: string } | undefined>();

  // 操作を共通ラップ: 失敗をエラーバナーに出し、実行中は busy で連打を防ぐ (admin-web 全体と統一)。
  const guard = (fn: () => Promise<void>) => async () => {
    setError(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loadArtifacts = guard(async () => {
    setArtifactList(await artifacts.list(event.id));
  });

  const uploadQr = (file: File) =>
    guard(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ref = await assets.upload(event.id, {
        name: file.name,
        contentType: file.type,
        bytes,
      });
      await client.updateEvent(event.id, { qrAsset: ref });
      onChanged();
    })();

  const issue = (role: InvitedRole) =>
    guard(async () => {
      const invite = await client.issueInvite(event.id, role, 60 * 60 * 12);
      setInvites((prev) => [...prev, invite]);
    })();

  const changeStatus = (status: EventDefinition["status"]) =>
    guard(async () => {
      await client.setStatus(event.id, status);
      onChanged();
    })();

  // R12: Egress (RTMP 送出) を起動して YouTube Live への配信を開始する。
  const startEgress = guard(async () => {
    const result = await client.startEgress(event.id);
    setEgressInfo({ egressId: result.egressId });
  });

  return (
    <section className="event-detail">
      <h2>
        {event.title} <span className={`status status-${event.status}`}>{event.status}</span>
      </h2>
      {error && (
        <p className="error" role="alert">
          {error} <button onClick={() => setError(undefined)}>×</button>
        </p>
      )}

      <div className="lifecycle">
        {event.status === "draft" && (
          <button onClick={() => changeStatus("live")} disabled={busy}>
            配信開始 (live)
          </button>
        )}
        {event.status === "live" && (
          <>
            <button onClick={() => changeStatus("ended")} disabled={busy}>
              配信終了 (ended)
            </button>
            {/* R12: live + media.livekitUrl + youtube.rtmpUrl/streamKeyRef が揃ったら RTMP 送出可能。 */}
            {event.media?.livekitUrl && event.youtube?.rtmpUrl && event.youtube.streamKeyRef && (
              <button onClick={startEgress} disabled={busy}>
                YouTube に配信開始 (Egress)
              </button>
            )}
          </>
        )}
        {egressInfo && (
          <p className="info">
            Egress 起動済み: <code>{egressInfo.egressId}</code>
          </p>
        )}
      </div>

      {/* R16 / ADR 0012 D-4: live イベント + media 確定後は layout 切替 UI を表示する。
          composer-template (Egress) に data channel で broadcast → sub-second で反映される。 */}
      {event.status === "live" && event.media?.livekitUrl && (
        <LayoutControl eventId={event.id} client={client} />
      )}

      {/* R17 / ADR 0012 D-6: live + media 確定後はライブプレビューを toggle 可能に表示。
          composer-template を iframe で開いて Egress と同じ合成画面を sub-second で確認できる。 */}
      {event.status === "live" && event.media?.livekitUrl && (
        <LivePreview
          eventId={event.id}
          client={client}
          composerTemplateUrl={composerTemplateUrl}
        />
      )}

      <h3>素材</h3>
      <label>
        QR コード画像
        <input
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(e) => e.target.files?.[0] && uploadQr(e.target.files[0])}
        />
      </label>
      {event.qrAsset && <p>登録済み QR: {event.qrAsset.key}</p>}

      <h3>招待 URL</h3>
      <button onClick={() => issue("moderator")} disabled={busy}>
        モデレーター招待を発行
      </button>
      <button onClick={() => issue("speaker")} disabled={busy}>
        登壇者招待を発行
      </button>
      <ul>
        {invites.map((inv) => (
          <li key={inv.jti}>
            <strong>{inv.role}</strong>: <code>{inv.url}</code>
          </li>
        ))}
      </ul>

      <h3>成果物 (録画 / 字幕)</h3>
      <button onClick={loadArtifacts} disabled={busy}>
        一覧を更新
      </button>
      {artifactList && (
        <ul className="artifacts">
          {artifactList.map((a) => (
            <li key={a.key}>
              <span className={`artifact-kind artifact-${a.kind}`}>
                {a.kind === "recording" ? "録画" : "字幕"}
              </span>
              :{" "}
              <a href={a.downloadUrl} download={a.name} rel="noreferrer">
                {a.name}
              </a>
            </li>
          ))}
          {artifactList.length === 0 && <li>(成果物なし / 配信終了後に表示されます)</li>}
        </ul>
      )}
    </section>
  );
}
