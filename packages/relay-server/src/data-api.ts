/**
 * dsh-pocketrelay relay-server — /api 关联引擎 + 鉴权门。
 *
 * 手机命中 relay 的 /api/* 路由时，relay 把每个请求翻译成一条 data-req 帧发往 host
 * （WS 数据面），等待 host 回送同 id 的 data-res，再响应手机。本模块负责：
 *   - 鉴权门（会话 cookie + 吊销 token 校验）
 *   - data-req 帧的铸造与 id 分配
 *   - inflight 关联表（pending Map）生命周期：mint → settle / 超时 / 客户端中止 / host 离线 / 关闭。
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  type DataReqFrame,
  type DataReqKind,
  type DataResFrame,
  type Frame,
  T,
} from "@dsh-pocketrelay/protocol"
import { DATA_REQ_TIMEOUT_MS, SESSION_COOKIE } from "./const.js"
import type { PhoneSession, SessionRegistry } from "./sessions.js"
import type { RelayStore } from "./store.js"

interface Inflight {
  deviceId: string
  kind: DataReqKind
  res: ServerResponse
  timer: NodeJS.Timeout
  settled: boolean
}

/** 一条待发送 data-req 帧的可选字段（id 由 mint 分配）。 */
interface DataReqSpec {
  readonly kind: DataReqKind
  readonly path?: string
  readonly content?: string
  readonly sessionId?: string
}

export interface DataApiOptions {
  store: RelayStore
  sessions: SessionRegistry
  sendToHost: (deviceId: string, frame: Frame) => boolean
  log: (msg: string) => void
  dataTimeoutMs?: number
}

/** /api 关联引擎：phone HTTP 请求 ⇄ host data-res 帧的 id 关联与超时/失败清理。 */
export class DataApi {
  private nextId = 1
  private readonly pending = new Map<number, Inflight>()
  private readonly opts: DataApiOptions
  private readonly timeoutMs: number

  constructor(opts: DataApiOptions) {
    this.opts = opts
    this.timeoutMs = opts.dataTimeoutMs ?? DATA_REQ_TIMEOUT_MS
  }

  /** 鉴权门：会话 cookie → 手机会话 → 吊销 token 校验；通过返回会话，否则 null。 */
  requirePhoneSession(req: IncomingMessage): PhoneSession | null {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (sid === null) return null
    const session = this.opts.sessions.getPhone(sid)
    if (session === null) return null
    const token = this.opts.store.getToken(session.tokenSha)
    if (token === null || token.revokedAt !== null) return null
    return session
  }

  /** 处理已鉴权手机 /api 请求：翻译为 data-req 帧发往 host，等待 data-res。 */
  async handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    session: PhoneSession,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay")
    const path = url.pathname
    const qs = url.searchParams
    const method = (req.method ?? "GET").toUpperCase()
    const deviceId = session.deviceId

    if (method === "GET" && path === "/api/sessions") {
      return this.mint(res, deviceId, { kind: "conversation" })
    }
    if (method === "GET" && path === "/api/history") {
      const sessionId = qs.get("sessionId")
      return sessionId === null
        ? this.mint(res, deviceId, { kind: "conversation" })
        : this.mint(res, deviceId, { kind: "conversation", sessionId })
    }
    if (method === "POST" && path === "/api/message") {
      const body = await readJsonBody(req)
      const sessionId = body?.["sessionId"]
      const text = body?.["text"]
      if (
        typeof sessionId !== "string" ||
        sessionId === "" ||
        typeof text !== "string" ||
        text === ""
      )
        return fail(res, 400, "sessionId and text required")
      return this.mint(res, deviceId, { kind: "send-message", sessionId, content: text })
    }
    if (method === "GET" && path === "/api/files") {
      const p = qs.get("path")
      return p === null
        ? this.mint(res, deviceId, { kind: "file-list" })
        : this.mint(res, deviceId, { kind: "file-list", path: p })
    }
    if (method === "GET" && path === "/api/file") {
      const p = qs.get("path")
      if (p === null) return fail(res, 400, "path required")
      return this.mint(res, deviceId, { kind: "file-read", path: p })
    }
    if (method === "PUT" && path === "/api/file") {
      const body = await readJsonBody(req)
      const p = body?.["path"]
      const content = body?.["content"]
      if (typeof p !== "string" || p === "" || typeof content !== "string" || content === "")
        return fail(res, 400, "path and content required")
      return this.mint(res, deviceId, { kind: "file-write", path: p, content })
    }
    return fail(res, 404, "not found")
  }

  /** 把 host 回送的 data-res 路由到对应 pending /api 响应。 */
  handleDataRes(deviceId: string, frame: DataResFrame): void {
    const inflight = this.pending.get(frame.id)
    if (inflight === undefined || inflight.deviceId !== deviceId) {
      this.opts.log(
        `data-res dropped: t=${frame.t} id=${frame.id} kind=${frame.kind} device=${deviceId}`,
      )
      return
    }
    inflight.settled = true
    clearTimeout(inflight.timer)
    this.pending.delete(frame.id)
    if (frame.ok) {
      const body: { ok: true; data?: unknown } = { ok: true }
      if (frame.data !== undefined) body.data = frame.data
      json(inflight.res, 200, body)
    } else {
      json(inflight.res, 502, { ok: false, error: frame.error ?? "host error" })
    }
  }

  /** host 离线：该设备所有 pending /api 请求立即 503。 */
  failAllForDevice(deviceId: string): void {
    for (const [id, inflight] of this.pending) {
      if (inflight.deviceId !== deviceId) continue
      inflight.settled = true
      clearTimeout(inflight.timer)
      this.pending.delete(id)
      fail(inflight.res, 503, "host offline")
    }
  }

  /** relay 关停：清理全部定时器并 503 所有幸存请求。 */
  close(): void {
    for (const inflight of this.pending.values()) {
      inflight.settled = true
      clearTimeout(inflight.timer)
      fail(inflight.res, 503, "relay shutting down")
    }
    this.pending.clear()
  }

  // --------------------------------------------------------------- internals

  private mint(res: ServerResponse, deviceId: string, spec: DataReqSpec): void {
    const id = this.nextId++
    const frame = buildDataReq(id, spec)
    if (!this.opts.sendToHost(deviceId, frame)) {
      fail(res, 503, "host offline")
      return
    }
    const timer = setTimeout(() => this.onTimeout(id), this.timeoutMs)
    this.pending.set(id, { deviceId, kind: spec.kind, res, timer, settled: false })
    res.on("close", () => this.onClientClose(id))
  }

  private onTimeout(id: number): void {
    const inflight = this.pending.get(id)
    if (inflight === undefined) return
    inflight.settled = true
    this.pending.delete(id)
    fail(inflight.res, 504, "host timeout")
  }

  private onClientClose(id: number): void {
    const inflight = this.pending.get(id)
    if (inflight === undefined) return
    inflight.settled = true
    clearTimeout(inflight.timer)
    this.pending.delete(id)
  }
}

function buildDataReq(id: number, spec: DataReqSpec): DataReqFrame {
  return {
    t: T.DATA_REQ,
    id,
    kind: spec.kind,
    ...(spec.path !== undefined ? { path: spec.path } : {}),
    ...(spec.content !== undefined ? { content: spec.content } : {}),
    ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

function fail(res: ServerResponse, status: number, error: string): void {
  json(res, status, { ok: false, error })
}

function readCookie(cookie: string | undefined, name: string): string | null {
  if (cookie === undefined) return null
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readRaw(req)
  try {
    const value = JSON.parse(raw.toString())
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
