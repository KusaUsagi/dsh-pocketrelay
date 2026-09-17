import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import {
  type Frame,
  type HelloHostFrame,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  T,
} from "@dsh-pocketrelay/protocol"
import { WebSocket, WebSocketServer } from "ws"
import { generatePairCode, sha256Hex } from "./auth.js"
import { DEFAULT_HOST_NAME, PAIR_CODE_TTL_MS } from "./const.js"
import { parseFrame } from "./parse.js"
import type { RelayStore } from "./store.js"

interface HostConn {
  ws: WebSocket
  deviceId: string
  hostName: string
  lastRx: number
  tick: ReturnType<typeof setInterval> | undefined
}

export type HostFrameSink = (deviceId: string, frame: Frame) => void

export interface WsBridgeOptions {
  store: RelayStore
  hostToken: string
  log: (msg: string) => void
  onHostFrame: HostFrameSink
  onHostOffline: (deviceId: string) => void
}

/** WS 控制面：仅 `/ws?role=host`。host 注册、配对码签发/刷新、心跳、host→relay 数据面帧路由。 */
export class WsBridge {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly hosts = new Map<string, HostConn>()
  private readonly opts: WsBridgeOptions

  constructor(opts: WsBridgeOptions) {
    this.opts = opts
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req))
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req))
  }

  isHostOnline(deviceId: string): boolean {
    return this.hosts.has(deviceId)
  }

  /** 向 host 推送手机在线态变化。 */
  notifyPeer(deviceId: string, online: boolean): void {
    const conn = this.hosts.get(deviceId)
    if (conn !== undefined) this.send(conn, { t: T.PEER, state: online ? "online" : "offline" })
  }

  /** 向某 host 发送任意帧。 */
  sendToHost(deviceId: string, frame: Frame): boolean {
    const conn = this.hosts.get(deviceId)
    if (conn === undefined) return false
    this.send(conn, frame)
    return true
  }

  close(): void {
    for (const conn of this.hosts.values()) {
      if (conn.tick !== undefined) clearInterval(conn.tick)
      try {
        conn.ws.close()
      } catch {
        // 已关闭
      }
    }
    this.hosts.clear()
    this.wss.close()
  }

  // --------------------------------------------------------------- internals

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://relay")
    if (url.searchParams.get("role") !== "host") {
      ws.close(1000, "only role=host on /ws")
      return
    }
    let conn: HostConn | null = null

    const onMessage = (data: unknown, isBinary: boolean): void => {
      if (isBinary || !Buffer.isBuffer(data)) return
      let frame: Frame | null
      try {
        frame = parseFrame(JSON.parse(data.toString()))
      } catch {
        return
      }
      if (frame === null) return
      if (conn === null) {
        if (frame.t !== T.HELLO || frame.role !== "host") {
          ws.close(1000, "expect hello host")
          return
        }
        conn = this.registerHost(ws, frame)
        return
      }
      conn.lastRx = Date.now()
      this.dispatch(conn, frame)
    }

    ws.on("message", onMessage)
    ws.on("close", () => {
      if (conn !== null) this.removeHost(conn)
    })
    ws.on("error", () => {
      // 单连接错误不拖垮 relay
    })
  }

  private registerHost(ws: WebSocket, hello: HelloHostFrame): HostConn | null {
    if (!safeEqualStr(hello.hostToken, this.opts.hostToken)) {
      this.sendRaw(ws, { t: T.HELLO_DENY, reason: "BAD_TOKEN" })
      ws.close(1000, "bad host token")
      return null
    }
    if (hello.v !== PROTOCOL_VERSION) {
      this.sendRaw(ws, { t: T.HELLO_DENY, reason: "BAD_VERSION" })
      ws.close(1000, "bad protocol version")
      return null
    }
    const deviceId = hello.deviceId
    const hostName = hello.hostName ?? DEFAULT_HOST_NAME
    const conn: HostConn = { ws, deviceId, hostName, lastRx: Date.now(), tick: undefined }
    // 若该设备已有旧连接，先清理其定时器（旧 ws 由其自身 close 处理）
    const prev = this.hosts.get(deviceId)
    if (prev !== undefined && prev.tick !== undefined) clearInterval(prev.tick)
    this.hosts.set(deviceId, conn)
    void this.opts.store
      .addDevice(deviceId, hostName)
      .catch((e) => this.opts.log(`store error: ${String(e)}`))
    void this.acknowledge(conn)
    conn.tick = setInterval(() => this.tick(conn), PING_INTERVAL_MS)
    return conn
  }

  /** 签发新配对码并落盘 codeSha（不发送）；返回 {code, expiresAt}。 */
  private async mintPair(conn: HostConn): Promise<{ code: string; expiresAt: number }> {
    const code = generatePairCode()
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS
    await this.opts.store.setPairing(conn.deviceId, sha256Hex(code), expiresAt)
    return { code, expiresAt }
  }

  /** host 注册回执：hello-ok{pair, peer:null}。 */
  private async acknowledge(conn: HostConn): Promise<void> {
    const pair = await this.mintPair(conn)
    this.send(conn, { t: T.HELLO_OK, pair, peer: null })
  }

  /** host 请求刷新配对码：回送 pair 帧。 */
  private async refreshPair(conn: HostConn): Promise<void> {
    const pair = await this.mintPair(conn)
    this.send(conn, { t: T.PAIR, code: pair.code, expiresAt: pair.expiresAt })
  }

  private tick(conn: HostConn): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - conn.lastRx > PING_TIMEOUT_MS) {
      this.opts.log(`host ${conn.deviceId} silent too long; dropping`)
      conn.ws.close(1000, "ping timeout")
      return
    }
    this.send(conn, { t: T.PING })
  }

  private dispatch(conn: HostConn, frame: Frame): void {
    switch (frame.t) {
      case T.PONG:
        return
      case T.PING:
        this.send(conn, { t: T.PONG })
        return
      case T.PAIR_REFRESH:
        void this.refreshPair(conn)
        return
      case T.REVOKED:
        return
      case T.HTTP_HEAD:
      case T.HTTP_CHUNK:
      case T.HTTP_END:
      case T.HTTP_ERR:
      case T.HTTP_ABORT:
      case T.WS_OPEN_OK:
      case T.WS_OPEN_ERR:
      case T.WS_FRAME:
      case T.WS_CLOSE:
        this.opts.onHostFrame(conn.deviceId, frame)
        return
      default:
        // hello/hello-ok/hello-deny/pair/peer/revoke 由 relay 发出，host 不应回送；忽略。
        return
    }
  }

  private removeHost(conn: HostConn): void {
    if (this.hosts.get(conn.deviceId) === conn) this.hosts.delete(conn.deviceId)
    if (conn.tick !== undefined) clearInterval(conn.tick)
    this.opts.onHostOffline(conn.deviceId)
  }

  private send(conn: HostConn, frame: Frame): void {
    this.sendRaw(conn.ws, frame)
  }

  private sendRaw(ws: WebSocket, frame: Frame): void {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // socket 已关闭等；忽略
    }
  }
}

function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
