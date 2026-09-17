import { homedir } from "node:os"
import { join } from "node:path"
import {
  HTTP_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  TOKEN_HEADER,
} from "@dsh-pocketrelay/protocol"

export {
  HTTP_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  TOKEN_HEADER,
}

/** 默认监听端口。 */
export const DEFAULT_PORT = 8443
/** 默认绑定地址（公网 VPS）。 */
export const DEFAULT_BIND = "0.0.0.0"
/** 默认 host 展示名。 */
export const DEFAULT_HOST_NAME = "dsh-pocketrelay"

/** 默认数据目录：~/.dsh-pocketrelay。 */
export function defaultDataDir(): string {
  return join(homedir(), ".dsh-pocketrelay")
}

/** 配对码有效期（60s）。 */
export const PAIR_CODE_TTL_MS = 60_000
/** 配对挑战有效期（60s）。 */
export const CHALLENGE_TTL_MS = 60_000
/** 手机会话 cookie 有效期（30 天）。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 管理台会话有效期（12 小时）。 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000

/** 手机会话 cookie 名。 */
export const SESSION_COOKIE = "dsh-pocketrelay"
/** 管理台会话 cookie 名。 */
export const ADMIN_COOKIE = "dsh-pocketrelay-admin"

/** JSONL 持久化文件名（相对 dataDir）。 */
export const STORE_FILE = "relay.jsonl"
/** 自签证书缓存目录（相对 dataDir）。 */
export const TLS_DIR = "tls"
