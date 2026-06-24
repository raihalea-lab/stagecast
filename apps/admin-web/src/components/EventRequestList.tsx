import { useCallback, useEffect, useState } from "react";
import type { EventRequest } from "@stagecast/shared";
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@stagecast/ui";
import { Check, X } from "@stagecast/ui/icons";
import type { ControlApiClient } from "../api/types.js";
import { toErrorMessage } from "../lib/errors.js";

export function EventRequestList(props: {
  client: ControlApiClient;
  onApproved: (eventId: string) => void;
}) {
  const [requests, setRequests] = useState<EventRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const list = await props.client.listEventRequests();
      setRequests(list);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [props.client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const approve = async (id: string) => {
    setBusy(id);
    setError(undefined);
    try {
      const result = await props.client.approveEventRequest(id);
      await refresh();
      props.onApproved(result.event.id);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(undefined);
    }
  };

  const reject = async (id: string) => {
    setBusy(id);
    setError(undefined);
    try {
      await props.client.rejectEventRequest(id);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(undefined);
    }
  };

  const pending = requests.filter((r) => r.status === "pending");
  const resolved = requests.filter((r) => r.status !== "pending");

  if (loading) {
    return <p className="text-sm text-text-secondary">読み込み中…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold text-text-primary">イベントリクエスト</h2>
      {error && (
        <div className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}
      {pending.length === 0 && resolved.length === 0 && (
        <EmptyState title="リクエストなし" description="まだリクエストはありません" />
      )}
      {pending.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-text-secondary">承認待ち ({pending.length})</h3>
          {pending.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{r.title}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-4 text-xs text-text-secondary">
                  <span>申請者: {r.requesterName}</span>
                  {r.requesterEmail && <span>{r.requesterEmail}</span>}
                  <span>
                    {new Date(r.startsAt).toLocaleString("ja-JP")} 〜{" "}
                    {new Date(r.endsAt).toLocaleString("ja-JP")}
                  </span>
                </div>
                {r.description && <p className="text-sm text-text-secondary">{r.description}</p>}
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => approve(r.id)}
                    disabled={busy === r.id}
                    className="gap-1"
                  >
                    <Check className="size-3.5" />
                    承認
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => reject(r.id)}
                    disabled={busy === r.id}
                    className="gap-1"
                  >
                    <X className="size-3.5" />
                    却下
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {resolved.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-text-secondary">処理済み ({resolved.length})</h3>
          {resolved.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between rounded-md border border-line-1 px-3 py-2"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm text-text-primary">{r.title}</span>
                <span className="text-xs text-text-tertiary">
                  {r.requesterName} ・ {new Date(r.startsAt).toLocaleDateString("ja-JP")}
                </span>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  r.status === "approved"
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                }`}
              >
                {r.status === "approved" ? "承認済み" : "却下"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
