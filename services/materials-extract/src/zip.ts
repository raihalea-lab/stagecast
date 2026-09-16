/**
 * ZIP の最小リーダー (ADR 0021 D-2)。PPTX (= ZIP) からスライド XML を取り出すためだけに使う。
 *
 * `fflate` 等を足さないのは、必要なのが「中央ディレクトリを読んで deflate を戻す」だけで、
 * 展開そのものは `node:zlib` が持っているため。汎用 ZIP 実装ではない:
 *  - 対応するのは stored (0) と deflate (8) のみ
 *  - ZIP64 は非対応 (PPTX が 4GB を超えることは想定しない)
 *  - 暗号化ファイルは読まない
 * 想定外の形式に当たったらそのエントリを飛ばす (資料 1 件の失敗で全体を止めない)。
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x0605_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const MAX_COMMENT = 0xffff;

export interface ZipEntry {
  name: string;
  read(): Uint8Array;
}

/** End of Central Directory を末尾から探す (可変長コメントがあるので後ろから走査する)。 */
function findEocd(buf: Buffer): number | null {
  const start = Math.max(0, buf.length - (MAX_COMMENT + 22));
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return null;
}

/**
 * ZIP のエントリを列挙する。中身は `read()` を呼んだときに展開する
 * (PPTX の大半は画像で、必要なのはスライド XML だけのため)。
 */
export function readZipEntries(data: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEocd(buf);
  if (eocd === null) return [];

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    entries.push({
      name,
      read(): Uint8Array {
        // ローカルヘッダの可変長は中央ディレクトリのものと一致しないことがあるので読み直す。
        if (localOffset + 30 > buf.length) return new Uint8Array();
        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const body = buf.subarray(dataStart, dataStart + compressedSize);
        if (method === 0) return new Uint8Array(body);
        if (method === 8) return new Uint8Array(inflateRawSync(body));
        return new Uint8Array();
      },
    });
  }
  return entries;
}
