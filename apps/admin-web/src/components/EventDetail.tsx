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

export function EventDetail(props: {
  event: EventDefinition;
  client: ControlApiClient;
  assets: AssetService;
  artifacts: ArtifactService;
  onChanged: () => void;
}) {
  const { event, client, assets, artifacts, onChanged } = props;
  const [invites, setInvites] = useState<IssuedInvite[]>([]);
  const [artifactList, setArtifactList] = useState<Artifact[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  // 操作を共通ラップ: 失敗を握り潰さずエラーバナーに出す (admin-web 全体と統一)。
  const guard = (fn: () => Promise<void>) => async () => {
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(toErrorMessage(err));
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
          <button onClick={() => changeStatus("live")}>配信開始 (live)</button>
        )}
        {event.status === "live" && (
          <button onClick={() => changeStatus("ended")}>配信終了 (ended)</button>
        )}
      </div>

      <h3>素材</h3>
      <label>
        QR コード画像
        <input
          type="file"
          accept="image/*"
          onChange={(e) => e.target.files?.[0] && uploadQr(e.target.files[0])}
        />
      </label>
      {event.qrAsset && <p>登録済み QR: {event.qrAsset.key}</p>}

      <h3>招待 URL</h3>
      <button onClick={() => issue("moderator")}>モデレーター招待を発行</button>
      <button onClick={() => issue("speaker")}>登壇者招待を発行</button>
      <ul>
        {invites.map((inv) => (
          <li key={inv.jti}>
            <strong>{inv.role}</strong>: <code>{inv.url}</code>
          </li>
        ))}
      </ul>

      <h3>成果物 (録画 / 字幕)</h3>
      <button onClick={loadArtifacts}>一覧を更新</button>
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
