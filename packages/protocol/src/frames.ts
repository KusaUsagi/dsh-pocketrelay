/**
 * dsh-pocketrelay 隧道协议常量 —— 帧的 wire 契约。
 *
 * 必须与 packages/relay-server 的 const.ts、docs/PROTOCOL.md (v1) 保持一致。
 * 任何取值变更必须先 bump {@link PROTOCOL_VERSION}。
 */

/** 帧类型标签（JSON `t` 字段取值）。 */
export const T = {
  // hello / lifecycle
  HELLO: "hello",
  HELLO_OK: "hello-ok",
  HELLO_DENY: "hello-deny",
  PEER: "peer",
  REVOKE: "revoke",
  REVOKED: "revoked",
  PAIR_REFRESH: "pair-refresh",
  PAIR: "pair",
  // keepalive
  PING: "ping",
  PONG: "pong",
  // http proxy plane
  HTTP_REQ: "http-req",
  HTTP_BODY: "http-body",
  HTTP_BODY_END: "http-body-end",
  HTTP_ABORT: "http-abort",
  HTTP_HEAD: "http-head",
  HTTP_CHUNK: "http-chunk",
  HTTP_END: "http-end",
  HTTP_ERR: "http-err",
  // websocket tunnel plane
  WS_OPEN: "ws-open",
  WS_OPEN_OK: "ws-open-ok",
  WS_OPEN_ERR: "ws-open-err",
  WS_FRAME: "ws-frame",
  WS_CLOSE: "ws-close",
} as const

export type FrameType = (typeof T)[keyof typeof T]

/** 协议版本，由 hello 帧携带，relay 拒绝不匹配的版本。 */
export const PROTOCOL_VERSION = 1

/** 单个 WS 文本帧最大字节数；relay 把更大的 body 切成多个 http-body / http-chunk。 */
export const MAX_FRAME_BYTES = 64 * 1024

/** 心跳：host 每 30s 发 ping，90s 无 pong 视为死链。 */
export const PING_INTERVAL_MS = 30_000
export const PING_TIMEOUT_MS = 90_000

/** host 断线重连指数退避（1s → 2s → 4s → … 封顶 60s）。 */
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 60_000

/** relay 识别转发上游请求中手机设备 token 的请求头。 */
export const TOKEN_HEADER = "x-dsh-pocketrelay-token"

/** HTTP 平面 body 分块大小。 */
export const HTTP_CHUNK_BYTES = 32 * 1024
