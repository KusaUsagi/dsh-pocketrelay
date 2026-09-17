/**
 * dsh-pocketrelay — RelayAgent: the host-side tunnel client (PROTOCOL §3, §7).
 *
 * Owns the WebSocket link to the relay: `hello` registration, ping/pong
 * keepalive, exponential reconnect, and the status surface for the UI. Data
 * plane frames (http-* / ws-*) are not interpreted here — they are dispatched
 * to {@link setFrameSink} so this class stays a pure control-plane client.
 * The relay socket is the Node 22+ global `WebSocket`.
 */
// allow: SIZE_OK — indivisible reconnecting-WS-client state machine (connect, backoff,
// keepalive, pair settle all share one private state), mirroring dsh-remote's RelayAgent.
import {
  assertNever,
  type Frame,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  T,
} from "@dsh-pocketrelay/protocol"
import { type DataPlaneFrame, parseFrame } from "./parse.js"

export type ConnState = "idle" | "connecting" | "online" | "error"

export interface PairInfo {
  code: string
  expiresAt: number
}

export interface PeerInfo {
  online: boolean
  ua?: string
}

export interface AgentStatus {
  state: ConnState
  deviceId: string
  relayUrl: string
  hostName: string
  pair: PairInfo | null
  peer: PeerInfo | null
  lastError: string | null
  connectedAt: number | null
  retryInMs: number | null
}

export interface AgentOptions {
  deviceId: string
  relayUrl: string
  hostToken: string
  hostName: string
  log: (message: string) => void
  onStatus?: (status: AgentStatus) => void
}

interface PairWaiter {
  promise: Promise<PairInfo | null>
  settle: (pair: PairInfo | null) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

export class RelayAgent {
  private ws: WebSocket | null = null
  private state: ConnState = "idle"
  private pair: PairInfo | null = null
  private peer: PeerInfo | null = null
  private lastError: string | null = null
  private connectedAt: number | null = null
  private retryInMs: number | null = null
  private stopped = true
  private retryAttempt = 0
  private lastRx = 0
  private frameSink: ((frame: DataPlaneFrame) => void) | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private pairWaiter: PairWaiter | undefined

  constructor(private readonly options: AgentOptions) {}

  setFrameSink(sink: (frame: DataPlaneFrame) => void): void {
    this.frameSink = sink
  }

  getStatus(): AgentStatus {
    return {
      state: this.state,
      deviceId: this.options.deviceId,
      relayUrl: this.options.relayUrl,
      hostName: this.options.hostName,
      pair: this.pair,
      peer: this.peer,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      retryInMs: this.retryInMs,
    }
  }

  /** Apply settings, dropping any live connection so the next cycle re-arms. */
  applySettings(relayUrl: string, hostToken: string, autoConnect: boolean): void {
    this.options.relayUrl = relayUrl
    this.options.hostToken = hostToken
    this.stop()
    if (autoConnect && relayUrl.trim() !== "") this.start()
    else this.setState("idle")
  }

  start(): void {
    if (this.stopped === false) return
    if (this.options.relayUrl.trim() === "") {
      this.setState("idle")
      return
    }
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.settlePair(null)
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
    this.closeSocket(null)
    this.connectedAt = null
    this.retryInMs = null
  }

  /** Ask the relay for a fresh pairing code and wait for the `pair` reply. */
  refreshPair(): Promise<PairInfo | null> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(null)
    const waiter = this.pairWaiter
    if (waiter !== undefined) return waiter.promise
    let settle: (pair: PairInfo | null) => void = () => {}
    const promise = new Promise<PairInfo | null>((resolve) => {
      settle = resolve
    })
    const next: PairWaiter = { promise, settle, timer: undefined }
    this.pairWaiter = next
    next.timer = setTimeout(() => this.settlePair(null), 4000)
    this.sendFrame({ t: T.PAIR_REFRESH })
    return promise
  }

  dispose(): void {
    this.stop()
  }

  // ------------------------------------------------------------ internals

  private connect(): void {
    if (this.stopped) return
    const wsUrl = this.buildWsUrl()
    if (wsUrl === "") {
      this.setState("idle")
      return
    }
    this.setState("connecting")
    this.lastRx = Date.now()

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (error) {
      this.fail(`无法连接中继：${(error as Error).message}`)
      return
    }
    this.ws = ws
    ws.binaryType = "arraybuffer"
    ws.addEventListener("open", () => this.onOpen())
    ws.addEventListener("message", (event) => this.onMessage(event))
    ws.addEventListener("close", () => this.onClose())
    ws.addEventListener("error", () => this.log("relay socket error"))
  }

  private buildWsUrl(): string {
    const trimmed = this.options.relayUrl.trim().replace(/\/+$/, "")
    if (/^wss?:\/\//i.test(trimmed)) return `${trimmed}/ws?role=host`
    if (/^https?:\/\//i.test(trimmed)) {
      const protocol = /^https/i.test(trimmed) ? "wss" : "ws"
      return `${trimmed.replace(/^https?/i, protocol)}/ws?role=host`
    }
    return `ws://${trimmed}/ws?role=host`
  }

  private onOpen(): void {
    this.log("relay connected")
    this.connectedAt = Date.now()
    this.retryAttempt = 0
    this.retryInMs = null
    this.sendFrame({
      t: T.HELLO,
      v: PROTOCOL_VERSION,
      role: "host",
      deviceId: this.options.deviceId,
      hostToken: this.options.hostToken,
      hostName: this.options.hostName,
    })
    this.setState("connecting")
    if (this.tickTimer === undefined)
      this.tickTimer = setInterval(() => this.tick(), PING_INTERVAL_MS)
  }

  private onMessage(event: MessageEvent): void {
    this.lastRx = Date.now()
    if (typeof event.data !== "string") return // control plane is JSON text only
    const frame = parseFrame(JSON.parse(event.data) as unknown)
    if (frame === null) {
      this.log("ignoring unrecognized relay frame")
      return
    }
    this.handleFrame(frame)
  }

  private onClose(): void {
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
    this.ws = null
    this.settlePair(null)
    if (this.stopped) return
    this.setState("error")
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.retryAttempt, RECONNECT_MAX_MS)
    this.retryAttempt += 1
    this.retryInMs = delay
    this.log(`reconnecting in ${Math.round(delay / 1000)}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.retryInMs = null
      this.connect()
    }, delay)
  }

  private tick(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    if (Date.now() - this.lastRx > PING_TIMEOUT_MS) {
      this.log("relay silent too long; reconnecting")
      this.closeSocket("remote silence")
      return
    }
    this.sendFrame({ t: T.PING })
  }

  private handleFrame(frame: Frame): void {
    switch (frame.t) {
      case T.HELLO_OK: {
        this.pair =
          frame.pair === null ? null : { code: frame.pair.code, expiresAt: frame.pair.expiresAt }
        this.lastError = null
        this.setState("online")
        this.log(`relay hello-ok (pair ${this.pair === null ? "none" : "armed"})`)
        return
      }
      case T.HELLO_DENY:
        this.fail(`relay 拒绝认证：${frame.reason}`)
        return
      case T.PAIR: {
        this.pair = { code: frame.code, expiresAt: frame.expiresAt }
        this.settlePair(this.pair)
        this.log("pair code refreshed")
        return
      }
      case T.PEER:
        this.peer = {
          online: frame.state === "online",
          ...(frame.ua === undefined ? {} : { ua: frame.ua }),
        }
        this.log(`peer ${this.peer.online ? "online" : "offline"}`)
        return
      case T.PAIR_REFRESH:
        // Relay nudges the host to fetch a fresh code; re-requesting makes it
        // mint and push a new `pair` frame.
        this.sendFrame({ t: T.PAIR_REFRESH })
        return
      case T.REVOKE:
        this.pair = null
        this.peer = null
        this.log("device revoked")
        this.sendFrame({ t: T.REVOKED })
        return
      case T.PING:
        this.sendFrame({ t: T.PONG })
        return
      case T.PONG:
        return
      case T.HTTP_REQ:
      case T.HTTP_BODY:
      case T.HTTP_BODY_END:
      case T.HTTP_ABORT:
      case T.WS_OPEN:
      case T.WS_FRAME:
      case T.WS_CLOSE:
        this.frameSink?.(frame)
        return
      case T.HELLO:
      case T.REVOKED:
      case T.HTTP_HEAD:
      case T.HTTP_CHUNK:
      case T.HTTP_END:
      case T.HTTP_ERR:
      case T.WS_OPEN_OK:
      case T.WS_OPEN_ERR:
        // Outbound-only types the relay never sends to a host; ignore quietly.
        return
      default:
        assertNever(frame)
    }
  }

  private fail(message: string): void {
    this.lastError = message
    this.setState("error")
    this.log(message)
    this.closeSocket("failed")
  }

  private settlePair(pair: PairInfo | null): void {
    const waiter = this.pairWaiter
    if (waiter === undefined) return
    this.pairWaiter = undefined
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    waiter.settle(pair)
  }

  private closeSocket(reason: string | null): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close(1000, reason ?? undefined)
      } catch {
        // socket already gone
      }
    }
  }

  sendFrame(frame: Frame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch (error) {
      this.log(`send failed: ${(error as Error).message}`)
      this.closeSocket("send error")
    }
  }

  private setState(state: ConnState): void {
    if (this.state === state) return
    this.state = state
    this.options.onStatus?.(this.getStatus())
  }

  private readonly log = (message: string): void => {
    this.options.log(`[relay] ${message}`)
  }
}
