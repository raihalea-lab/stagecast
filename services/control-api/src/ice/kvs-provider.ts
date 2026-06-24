/**
 * R12-followup-19 / ADR 0011 案 E: AWS KVS WebRTC (Amazon Kinesis Video Streams) を TURN として使う。
 *
 * `GetSignalingChannelEndpoint` で TURN を取得するための HTTPS endpoint を 1 回だけ解決し、
 * 以降は `GetIceServerConfig` で participant 毎に短期 credential 付きの iceServers を取得する。
 * クライアント (stage-web) は受け取った iceServers を `rtcConfig.iceServers` として Room.connect に渡し、
 * LiveKit Client SDK の `if (!rtcConfig.iceServers)` 判定で server からの iceServers を完全 bypass する。
 *
 * - `--region` は SDK のデフォルト (Lambda 実行リージョン) を使う。
 * - HTTPS endpoint はリージョン × Channel ARN で一意なので、 同じ Lambda インスタンス内では cache する。
 * - GetIceServerConfig は 1 回呼ぶごとに TTL 秒だけ有効な credential を返す (デフォルト 300s)。
 */
import { createLogger } from "@stagecast/shared";
import {
  KinesisVideoClient,
  GetSignalingChannelEndpointCommand,
} from "@aws-sdk/client-kinesis-video";
import {
  KinesisVideoSignalingClient,
  GetIceServerConfigCommand,
} from "@aws-sdk/client-kinesis-video-signaling";
import type { IceServer, IceServerProvider } from "../usecases/join.js";

const logger = createLogger({ component: "kvs-ice" });

export function createKvsIceServerProvider(deps: {
  channelArn: string;
  /** テスト用に SDK を差し替えるための optional フック。 */
  kinesisVideo?: KinesisVideoClient;
  signalingFactory?: (httpsEndpoint: string) => KinesisVideoSignalingClient;
}): IceServerProvider {
  const kvs = deps.kinesisVideo ?? new KinesisVideoClient({});
  const signalingFactory =
    deps.signalingFactory ??
    ((endpoint: string) =>
      new KinesisVideoSignalingClient({
        endpoint,
      }));

  // Lambda コンテナ内で endpoint を cache (リージョン × ARN で固定値)。
  let cachedEndpoint: string | undefined;

  async function resolveEndpoint(): Promise<string> {
    if (cachedEndpoint) return cachedEndpoint;
    const res = await kvs.send(
      new GetSignalingChannelEndpointCommand({
        ChannelARN: deps.channelArn,
        SingleMasterChannelEndpointConfiguration: {
          Protocols: ["HTTPS"],
          Role: "MASTER",
        },
      }),
    );
    const httpsEndpoint = res.ResourceEndpointList?.find(
      (e) => e.Protocol === "HTTPS",
    )?.ResourceEndpoint;
    if (!httpsEndpoint) {
      throw new Error("KVS HTTPS endpoint not returned by GetSignalingChannelEndpoint");
    }
    cachedEndpoint = httpsEndpoint;
    return httpsEndpoint;
  }

  return {
    async resolve(input): Promise<IceServer[]> {
      try {
        const endpoint = await resolveEndpoint();
        const signaling = signalingFactory(endpoint);
        const res = await signaling.send(
          new GetIceServerConfigCommand({
            ChannelARN: deps.channelArn,
            ClientId: input.participantIdentity,
          }),
        );
        const iceServers = (res.IceServerList ?? [])
          .filter((s) => Array.isArray(s.Uris) && s.Uris.length > 0)
          .map<IceServer>((s) => ({
            urls: s.Uris ?? [],
            ...(s.Username ? { username: s.Username } : {}),
            ...(s.Password ? { credential: s.Password } : {}),
          }));
        logger.info("ice servers resolved", { count: iceServers.length });
        return iceServers;
      } catch (err) {
        logger.warn("failed to resolve ice servers", { error: String(err) });
        // join.ts 側で握って続行する設計なので、 throw して上位に伝播させる。
        throw err;
      }
    },
  };
}
