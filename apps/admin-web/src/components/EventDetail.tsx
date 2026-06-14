/**
 * イベント詳細: 素材アップロード・招待URL発行・配信開始/終了 (DESIGN.md 8 章, 7.1, 4.1)。
 */
import { useState } from "react";
import type { EventDefinition, InvitedRole } from "@stagecast/shared";
import type { AssetService, ControlApiClient, IssuedInvite } from "../api/types.js";

export function EventDetail(props: {
  event: EventDefinition;
  client: ControlApiClient;
  assets: AssetService;
  onChanged: () => void;
}) {
  const { event, client, assets, onChanged } = props;
  const [invites, setInvites] = useState<IssuedInvite[]>([]);

  const uploadQr = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ref = await assets.upload(event.id, {
      name: file.name,
      contentType: file.type,
      bytes,
    });
    await client.updateEvent(event.id, { qrAsset: ref });
    onChanged();
  };

  const issue = async (role: InvitedRole) => {
    const invite = await client.issueInvite(event.id, role, 60 * 60 * 12);
    setInvites((prev) => [...prev, invite]);
  };

  const changeStatus = async (status: EventDefinition["status"]) => {
    await client.setStatus(event.id, status);
    onChanged();
  };

  return (
    <section className="event-detail">
      <h2>
        {event.title} <span className={`status status-${event.status}`}>{event.status}</span>
      </h2>

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
    </section>
  );
}
