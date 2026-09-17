import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import {
  type Frame,
  HTTP_CHUNK_BYTES,
  type HttpAbortFrame,
  type HttpChunkFrame,
  type HttpEndFrame,
  type HttpErrFrame,
  type HttpHeadFrame,
  type HttpMethod,
  T,
  type WsCloseFrame,
  type WsFrameFrame,
  type WsOpenErrFrame,
  type WsOpenOkFrame,
} from "@dsh-pocketrelay/protocol"
import { type WebSocket, WebSocketServer } from "ws"
import { SESSION_COOKIE } from "./const.js"
import type { PhoneSession, SessionRegistry } from "./sessions.js"
import type { RelayStore } from "./store.js"

interface InflightHttp {
  res: ServerResponse
  aborted: boolean
}
interface InflightWs {
  phone: WebSocket
  closed: boolean
}

export interface HttpProxyOptions {
  store: RelayStore
  sessions: SessionRegistry
  sendToHost: (deviceId: string, frame: Frame) => boolean
  log: (msg: string) => void
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
])

/** /d/<deviceId>/<rest> HTTP 反向代理 + /d/<deviceId>/events/* WS 隧道桥接。 */
export class HttpProxy {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly http = new Map<string, InflightHttp>()
  private readonly ws = new Map<string, InflightWs>()
  private nextId = 1
  private readonly opts: HttpProxyOptions

  constructor(opts: HttpProxyOptions) {
    this.opts = opts
  }

  close(): void {
    this.wss.close()
  }

  /** HTTPS upgrade 路由：/d/<id>/events/* 走 WS 隧道。 */
  handleEventsUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    deviceId: string,
    rest: string,
  ): void {
    if (this.auth(req, deviceId) === null) {
      socket.destroy()
      return
    }
    const id = this.nextId++
    this.wss.handleUpgrade(req, socket, head, (phone) => {
      const key = keyOf(deviceId, id)
      const inflight: InflightWs = { phone, closed: false }
      this.ws.set(key, inflight)
      this.opts.sendToHost(deviceId, {
        t: T.WS_OPEN,
        id,
        path: rest,
        headers: filterHeaders(req.headers),
      })
      phone.on("message", (data, isBinary) => {
        if (inflight.closed) return
        this.opts.sendToHost(deviceId, {
          t: T.WS_FRAME,
          id,
          opcode: isBinary ? 2 : 1,
          dataBase64: toBase64(data),
        })
      })
      phone.on("close", () => {
        if (inflight.closed) return
        inflight.closed = true
        this.ws.delete(key)
        this.opts.sendToHost(deviceId, { t: T.WS_CLOSE, id, code: 1000 })
      })
    })
  }

  /** /d/<deviceId>/<rest> HTTP 请求转发。 */
  async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    deviceId: string,
    rest: string,
  ): Promise<void> {
    const session = this.auth(req, deviceId)
    if (session === null) {
      res.statusCode = 401
      res.end("unauthorized")
      return
    }
    const id = this.nextId++
    const key = keyOf(deviceId, id)
    const inflight: InflightHttp = { res, aborted: false }
    this.http.set(key, inflight)
    res.on("close", () => {
      if (inflight.aborted) return
      inflight.aborted = true
      this.http.delete(key)
      this.opts.sendToHost(deviceId, { t: T.HTTP_ABORT, id })
    })

    const body = await readBody(req)
    const method = normalizeMethod(req.method)
    const query = extractQuery(req.url ?? "")
    const small = body.length <= HTTP_CHUNK_BYTES
    this.opts.sendToHost(deviceId, {
      t: T.HTTP_REQ,
      id,
      method,
      path: rest,
      query,
      headers: filterHeaders(req.headers),
      bodyBase64: body.length === 0 ? null : small ? body.toString("base64") : null,
    })
    if (!small) {
      for (let i = 0; i < body.length; i += HTTP_CHUNK_BYTES) {
        const slice = body.subarray(i, i + HTTP_CHUNK_BYTES)
        this.opts.sendToHost(deviceId, { t: T.HTTP_BODY, id, dataBase64: slice.toString("base64") })
      }
    }
    // 始终发 http-body-end:host 端 http-plane 收到 body-end 才执行 run()。即便 body
    // 内联在 http-req 里或为空也必须发,否则 host 永不执行 → 手机端读条卡死。
    this.opts.sendToHost(deviceId, { t: T.HTTP_BODY_END, id })
  }

  /** host→relay 响应/WS 帧分发。由 WsBridge 的 onHostFrame 调用。 */
  dispatch(deviceId: string, frame: Frame): void {
    switch (frame.t) {
      case T.HTTP_HEAD:
        this.onHead(deviceId, frame)
        return
      case T.HTTP_CHUNK:
        this.onChunk(deviceId, frame)
        return
      case T.HTTP_END:
        this.onEnd(deviceId, frame)
        return
      case T.HTTP_ERR:
        this.onErr(deviceId, frame)
        return
      case T.HTTP_ABORT:
        this.onAbort(deviceId, frame)
        return
      case T.WS_OPEN_OK:
        this.onWsOk(deviceId, frame)
        return
      case T.WS_OPEN_ERR:
        this.onWsErr(deviceId, frame)
        return
      case T.WS_FRAME:
        this.onWsData(deviceId, frame)
        return
      case T.WS_CLOSE:
        this.onWsClose(deviceId, frame)
        return
      default:
        return
    }
  }

  private auth(req: IncomingMessage, deviceId: string): PhoneSession | null {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (sid === null) return null
    const session = this.opts.sessions.getPhone(sid)
    if (session === null || session.deviceId !== deviceId) return null
    const token = this.opts.store.getToken(session.tokenSha)
    if (token === null || token.revokedAt !== null) return null
    return session
  }

  private onHead(deviceId: string, frame: HttpHeadFrame): void {
    const inflight = this.http.get(keyOf(deviceId, frame.id))
    if (inflight === undefined || inflight.aborted) return
    inflight.res.writeHead(frame.status, frame.headers ?? {})
  }

  private onChunk(deviceId: string, frame: HttpChunkFrame): void {
    const inflight = this.http.get(keyOf(deviceId, frame.id))
    if (inflight === undefined || inflight.aborted) return
    inflight.res.write(Buffer.from(frame.dataBase64, "base64"))
  }

  private onEnd(deviceId: string, frame: HttpEndFrame): void {
    const key = keyOf(deviceId, frame.id)
    const inflight = this.http.get(key)
    if (inflight === undefined || inflight.aborted) return
    this.http.delete(key)
    inflight.aborted = true
    inflight.res.end()
  }

  private onErr(deviceId: string, frame: HttpErrFrame): void {
    const key = keyOf(deviceId, frame.id)
    const inflight = this.http.get(key)
    if (inflight === undefined || inflight.aborted) return
    this.http.delete(key)
    inflight.aborted = true
    inflight.res.statusCode = 502
    inflight.res.end(`upstream: ${frame.code}`)
  }

  private onAbort(deviceId: string, frame: HttpAbortFrame): void {
    const key = keyOf(deviceId, frame.id)
    const inflight = this.http.get(key)
    if (inflight === undefined) return
    this.http.delete(key)
    inflight.aborted = true
    inflight.res.destroy()
  }

  private onWsOk(deviceId: string, frame: WsOpenOkFrame): void {
    const inflight = this.ws.get(keyOf(deviceId, frame.id))
    if (inflight === undefined || inflight.closed) return
    // host 已连本地 WS；phone 端 socket 已就绪
  }

  private onWsErr(deviceId: string, frame: WsOpenErrFrame): void {
    const key = keyOf(deviceId, frame.id)
    const inflight = this.ws.get(key)
    if (inflight === undefined || inflight.closed) return
    inflight.closed = true
    this.ws.delete(key)
    try {
      inflight.phone.close(1006, frame.reason)
    } catch {
      // 已关闭
    }
  }

  private onWsData(deviceId: string, frame: WsFrameFrame): void {
    const inflight = this.ws.get(keyOf(deviceId, frame.id))
    if (inflight === undefined || inflight.closed) return
    inflight.phone.send(Buffer.from(frame.dataBase64, "base64"), { binary: frame.opcode === 2 })
  }

  private onWsClose(deviceId: string, frame: WsCloseFrame): void {
    const key = keyOf(deviceId, frame.id)
    const inflight = this.ws.get(key)
    if (inflight === undefined || inflight.closed) return
    inflight.closed = true
    this.ws.delete(key)
    try {
      inflight.phone.close(frame.code, frame.reason ?? undefined)
    } catch {
      // 已关闭
    }
  }
}

function keyOf(deviceId: string, id: number): string {
  return deviceId + ":" + id
}

function normalizeMethod(method: string | undefined): HttpMethod {
  const upper = (method ?? "GET").toUpperCase()
  switch (upper) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
    case "OPTIONS":
      return upper
    default:
      return "GET"
  }
}

function extractQuery(url: string): string {
  const q = url.indexOf("?")
  return q === -1 ? "" : url.slice(q + 1)
}

function filterHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key)) continue
    if (typeof value === "string") out[key] = value
    else if (Array.isArray(value)) out[key] = value.join(", ")
  }
  return out
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

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function toBase64(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString("base64")
  if (Array.isArray(data)) {
    const buffers = data.filter(Buffer.isBuffer)
    return Buffer.concat(buffers).toString("base64")
  }
  return Buffer.from(String(data)).toString("base64")
}
