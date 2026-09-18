/**
 * dsh-pocketrelay 隧道协议的 TS 类型契约（v1）。
 *
 * 纯类型 + 常量，零运行时行为；relay 与 host 共享。
 * 边界解析（把 unknown JSON 解析为 Frame）由各端在自身边界完成。
 *
 * 各接口的 `t` 字面量必须与 frames.ts 的 T 严格对齐（见 docs/PROTOCOL.md §11）。
 * `v` 字段在边界处校验 === PROTOCOL_VERSION（frames.ts）。
 */

export * from "./frames.js"

/** hello 握手角色。 */
export type Role = "host" | "phone"

/** relay 允许转发的 HTTP 方法白名单。 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

/** hello-deny 的原因码。 */
export type HelloDenyReason = "BAD_TOKEN" | "UNKNOWN_DEVICE" | "BAD_VERSION"

/** 配对码（6 位十进制字符串）。 */
export type PairCode = string

/** host/phone 设备标识（32 位十六进制）。 */
export type DeviceId = string

/** 手机/主机在线状态片段。 */
export interface PeerState {
  readonly online: boolean
  readonly hostName?: string
  readonly ua?: string
}

/** host → relay：注册。 */
export interface HelloHostFrame {
  readonly t: "hello"
  readonly v: number
  readonly role: "host"
  readonly deviceId: DeviceId
  readonly hostToken: string
  readonly hostName?: string
}

/** phone → relay：配对挑战响应。 */
export interface HelloPhoneFrame {
  readonly t: "hello"
  readonly v: number
  readonly role: "phone"
  readonly deviceId: DeviceId
  readonly challenge: string
  readonly response: string
  readonly token: string
}

/** relay → 端：握手成功（pair 仅发给 host；peer 双向）。 */
export interface HelloOkFrame {
  readonly t: "hello-ok"
  readonly pair: { readonly code: PairCode; readonly expiresAt: number } | null
  readonly peer: PeerState | null
}

/** relay → 端：握手失败并关闭。 */
export interface HelloDenyFrame {
  readonly t: "hello-deny"
  readonly reason: HelloDenyReason
}

/** relay ↔ 端：对端在线态变化。 */
export interface PeerFrame {
  readonly t: "peer"
  readonly state: "online" | "offline"
  readonly ua?: string
}

/** relay → host：撤销某设备。 */
export interface RevokeFrame {
  readonly t: "revoke"
}

/** host → relay：确认已撤销。 */
export interface RevokedFrame {
  readonly t: "revoked"
}

/** relay → host：重新轮询 /pair 取码。 */
export interface PairRefreshFrame {
  readonly t: "pair-refresh"
}

/** relay → host：下发新配对码。 */
export interface PairFrame {
  readonly t: "pair"
  readonly code: PairCode
  readonly expiresAt: number
}

/** 心跳。 */
export interface PingFrame {
  readonly t: "ping"
}
export interface PongFrame {
  readonly t: "pong"
}

/** relay → host：一个 HTTP 请求的开端。 */
export interface HttpReqFrame {
  readonly t: "http-req"
  readonly id: number
  readonly method: HttpMethod
  readonly path: string
  readonly query: string
  readonly headers: Record<string, string> | null
  readonly bodyBase64: string | null
}

/** host → relay：请求 body 分块。 */
export interface HttpBodyFrame {
  readonly t: "http-body"
  readonly id: number
  readonly dataBase64: string
}

/** host → relay：body 结束。 */
export interface HttpBodyEndFrame {
  readonly t: "http-body-end"
  readonly id: number
}

/** 双向：中止某请求。 */
export interface HttpAbortFrame {
  readonly t: "http-abort"
  readonly id: number
}

/** host → relay：响应首部。 */
export interface HttpHeadFrame {
  readonly t: "http-head"
  readonly id: number
  readonly status: number
  readonly headers: Record<string, string> | null
}

/** host → relay：响应 body 分块。 */
export interface HttpChunkFrame {
  readonly t: "http-chunk"
  readonly id: number
  readonly dataBase64: string
}

/** host → relay：响应结束。 */
export interface HttpEndFrame {
  readonly t: "http-end"
  readonly id: number
}

/** host → relay：上游错误（无法连本地 dsh web 等）。 */
export interface HttpErrFrame {
  readonly t: "http-err"
  readonly id: number
  readonly code: string
  readonly message: string
}

/** relay → host：建立本地 WS。 */
export interface WsOpenFrame {
  readonly t: "ws-open"
  readonly id: number
  readonly path: string
  readonly headers: Record<string, string> | null
}

/** host → relay：本地 WS 已建立。 */
export interface WsOpenOkFrame {
  readonly t: "ws-open-ok"
  readonly id: number
}

/** host → relay：本地 WS 拒绝。 */
export interface WsOpenErrFrame {
  readonly t: "ws-open-err"
  readonly id: number
  readonly reason: string
}

/** 双向：WS 数据帧。 */
export interface WsFrameFrame {
  readonly t: "ws-frame"
  readonly id: number
  readonly opcode: 1 | 2
  readonly dataBase64: string
}

/** 双向：WS 关闭。 */
export interface WsCloseFrame {
  readonly t: "ws-close"
  readonly id: number
  readonly code: number
  readonly reason?: string
}

/** relay→host：结构化数据请求（新数据面，取代 http/ws 反代）。 */
export type DataReqKind =
  | "conversation"
  | "file-list"
  | "file-read"
  | "file-write"
  | "send-message"

export interface DataReqFrame {
  readonly t: "data-req"
  readonly id: number
  readonly kind: DataReqKind
  /** file-read/file-write 的路径；send-message/conversation 的会话 id（可选，缺省取活动会话）。 */
  readonly path?: string
  /** file-write 的内容；send-message 的用户消息文本。 */
  readonly content?: string
  readonly sessionId?: string
}

/** host→relay：结构化数据响应。data 形状按 kind 由 relay/host 约定（conversation=消息数组,file-list=目录项,file-read=文本,…）。 */
export interface DataResFrame {
  readonly t: "data-res"
  readonly id: number
  readonly kind: DataReqKind
  readonly ok: boolean
  readonly data?: unknown
  readonly error?: string
}

/** 协议所有帧的判别联合；消费方必须用 exhaustive switch 处理。 */
export type Frame =
  | HelloHostFrame
  | HelloPhoneFrame
  | HelloOkFrame
  | HelloDenyFrame
  | PeerFrame
  | RevokeFrame
  | RevokedFrame
  | PairRefreshFrame
  | PairFrame
  | PingFrame
  | PongFrame
  | HttpReqFrame
  | HttpBodyFrame
  | HttpBodyEndFrame
  | HttpAbortFrame
  | HttpHeadFrame
  | HttpChunkFrame
  | HttpEndFrame
  | HttpErrFrame
  | WsOpenFrame
  | WsOpenOkFrame
  | WsOpenErrFrame
  | WsFrameFrame
  | WsCloseFrame
  | DataReqFrame
  | DataResFrame

/** exhaustive switch 兜底：新增帧类型时编译期即报错。 */
export function assertNever(value: never): never {
  throw new Error(`Unreachable: unexpected frame ${JSON.stringify(value)}`)
}
