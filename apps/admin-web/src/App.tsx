/**
 * 管理コンソールのルート (DESIGN.md 3.1, 8 章)。
 * イベント一覧・作成・詳細を束ねる。データ層はクライアント抽象に委譲する。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EventDefinition } from '@stagecast/shared';
import type { CreateEventInput } from '@stagecast/control-api';
import { HttpControlApiClient } from './api/http-client.js';
import { HttpAssetService } from './api/http-asset-service.js';
import type { ControlApiClient, AssetService } from './api/types.js';
import { EventForm } from './components/EventForm.js';
import { EventDetail } from './components/EventDetail.js';

const apiBaseUrl = (): string => import.meta.env.VITE_CONTROL_API_URL ?? '';
// Cognito で取得した JWT を sessionStorage 等から取り出す想定 (F-12)。
const idToken = (): string | undefined => sessionStorage.getItem('stagecast.idToken') ?? undefined;

/** ブラウザ既定は HTTP クライアント。ローカル/テストは LocalControlApiClient を注入する。 */
function defaultClient(): ControlApiClient {
  return new HttpControlApiClient(apiBaseUrl(), idToken);
}

export function App(props: { client?: ControlApiClient; assets?: AssetService }) {
  const client = useMemo(() => props.client ?? defaultClient(), [props.client]);
  const assets = useMemo(
    () => props.assets ?? new HttpAssetService(apiBaseUrl(), idToken),
    [props.assets],
  );

  const [events, setEvents] = useState<EventDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    const list = await client.listEvents();
    setEvents(list);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async (input: CreateEventInput) => {
    const created = await client.createEvent(input);
    await refresh();
    setSelectedId(created.id);
  };

  const selected = events.find((e) => e.id === selectedId);

  return (
    <main className="app">
      <header>
        <h1>Stagecast 管理コンソール</h1>
      </header>
      <div className="layout">
        <aside>
          <EventForm onCreate={create} />
          <h2>イベント一覧</h2>
          <ul className="event-list">
            {events.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => setSelectedId(e.id)}
                  className={e.id === selectedId ? 'active' : ''}
                >
                  {e.title} ({e.status})
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <article>
          {selected ? (
            <EventDetail event={selected} client={client} assets={assets} onChanged={refresh} />
          ) : (
            <p>イベントを選択してください。</p>
          )}
        </article>
      </div>
    </main>
  );
}
