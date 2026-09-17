/**
 * dsh-pocketrelay — WebSocket tunnel plane (PROTOCOL §6), host side.
 *
 * `ws-open` makes us dial the same path on the local dsh web server with the
 * Node global `WebSocket`; after `ws-open-ok`, `ws-frame` traffic flows both
 * ways and `ws-close` tears the full link down. Text/binary opcodes are
 * distinguished via the WHATWG message payload (string vs ArrayBuffer).
 *
 * NOTE: the native global `WebSocket` cannot attach a `Cookie` header on the
 * upgrade, so the browser-auth cookie is not forwarded here (only the HTTP
 * plane carries it). The local dsh events WebSocket is reached over loopback,
 * which passes the trust fence as a non-browser client.
 */
import {
  T,
  type WsCloseFrame,
  type WsFrameFrame,
  type WsOpenFrame,
} from "@dsh-pocketrelay/protocol"
import type { Send } from "./http-plane.js"
import { assertNever } from "./parse.js"

type WsPlaneFrame = WsOpenFrame | WsFrameFrame | WsCloseFrame

interface Bridge {
  ws: WebSocket | null
  open: boolean
  /** Phone closed first — don't echo the close back to the relay. */
  phoneClosed: boolean
}

export interface WsPlaneOptions {
  origin: () => string
  log: (message: string) => void
  send: Send
}

export class WsPlane {
  private readonly bridges = new Map<number, Bridge>()

  constructor(private readonly options: WsPlaneOptions) {}

  handle(frame: WsPlaneFrame): void {
    const id = frame.id
    switch (frame.t) {
      case T.WS_OPEN:
        this.open(id, frame.path, frame.headers ?? {})
        return
      case T.WS_FRAME: {
        const bridge = this.bridges.get(id)
        if (bridge === undefined) return
        const ws = bridge.ws
        if (ws === null || !bridge.open) return
        const bytes = Buffer.from(frame.dataBase64, "base64")
        try {
          if (frame.opcode === 2) ws.send(bytes)
          else ws.send(bytes.toString("utf8"))
        } catch (error) {
          this.options.log(`bridge ${id} send failed: ${(error as Error).message}`)
        }
        return
      }
      case T.WS_CLOSE: {
        const bridge = this.bridges.get(id)
        if (bridge === undefined) return
        bridge.phoneClosed = true
        if (bridge.ws !== null && bridge.ws.readyState === WebSocket.OPEN) {
          try {
            bridge.ws.close(frame.code, frame.reason ?? undefined)
          } catch {
            // already closing
          }
        }
        return
      }
      default:
        assertNever(frame)
    }
  }

  private open(id: number, path: string, headers: Record<string, string>): void {
    if (this.bridges.has(id)) return
    const bridge: Bridge = { ws: null, open: false, phoneClosed: false }
    this.bridges.set(id, bridge)

    const protocols = (headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")

    const address = this.options.origin().replace(/^http/, "ws") + path

    let ws: WebSocket
    try {
      ws = new WebSocket(address, protocols)
    } catch (error) {
      this.bridges.delete(id)
      this.options.send({ t: T.WS_OPEN_ERR, id, reason: (error as Error).message })
      return
    }
    ws.binaryType = "arraybuffer"
    bridge.ws = ws

    ws.addEventListener("error", () => {
      if (bridge.open) return
      this.options.log(`bridge ${id} dial error`)
      if (this.bridges.has(id)) this.bridges.delete(id)
      this.options.send({ t: T.WS_OPEN_ERR, id, reason: "upstream connection failed" })
    })

    ws.addEventListener("open", () => {
      bridge.open = true
      this.options.send({ t: T.WS_OPEN_OK, id })
    })

    ws.addEventListener("message", (event) => {
      if (!bridge.open) return
      const data: unknown = event.data
      let opcode: 1 | 2
      let bytes: Buffer
      if (typeof data === "string") {
        opcode = 1
        bytes = Buffer.from(data, "utf8")
      } else if (data instanceof ArrayBuffer) {
        opcode = 2
        bytes = Buffer.from(data)
      } else {
        return
      }
      this.options.send({ t: T.WS_FRAME, id, opcode, dataBase64: bytes.toString("base64") })
    })

    ws.addEventListener("close", (event) => {
      this.bridges.delete(id)
      if (bridge.phoneClosed) return
      const code = event.code === 1006 ? 1011 : event.code
      this.options.send({ t: T.WS_CLOSE, id, code, reason: event.reason ?? "peer closed" })
    })
  }
}
