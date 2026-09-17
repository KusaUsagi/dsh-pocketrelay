/**
 * dsh-pocketrelay — relay-frame boundary parser.
 *
 * The single place untrusted wire JSON becomes a typed `Frame`: the WebSocket
 * payload is `unknown`, `parseFrame` narrows it against the protocol's
 * discriminated union (packages/protocol). Every interior module then receives
 * typed frames and never re-validates. The data-plane subset routed to the
 * http/ws planes is {@link DataPlaneFrame}; outbound-only frame types (which
 * the relay never sends to a host) parse to `null` and are ignored.
 */
import {
  assertNever,
  type Frame,
  type HelloDenyReason,
  type HttpAbortFrame,
  type HttpBodyEndFrame,
  type HttpBodyFrame,
  type HttpMethod,
  type HttpReqFrame,
  type PeerState,
  T,
  type WsCloseFrame,
  type WsFrameFrame,
  type WsOpenFrame,
} from "@dsh-pocketrelay/protocol"

/** Inbound data-plane frames dispatched from the agent to a plane. */
export type DataPlaneFrame =
  | HttpReqFrame
  | HttpBodyFrame
  | HttpBodyEndFrame
  | HttpAbortFrame
  | WsOpenFrame
  | WsFrameFrame
  | WsCloseFrame

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function readStringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  const map: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") map[key] = entry
  }
  return map
}

function readPair(value: unknown): { readonly code: string; readonly expiresAt: number } | null {
  if (!isRecord(value)) return null
  const code = readString(value["code"])
  const expiresAt = readNumber(value["expiresAt"])
  if (code === "" || expiresAt === 0) return null
  return { code, expiresAt }
}

function readPeerState(value: unknown): PeerState | null {
  if (!isRecord(value)) return null
  const hostName = readNullableString(value["hostName"])
  return hostName === null
    ? { online: value["online"] === true }
    : { online: value["online"] === true, hostName }
}

function readDenyReason(value: unknown): HelloDenyReason {
  if (value === "BAD_TOKEN" || value === "UNKNOWN_DEVICE" || value === "BAD_VERSION") return value
  return "UNKNOWN_DEVICE"
}

function readHttpMethod(value: unknown): HttpMethod {
  switch (value) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
    case "OPTIONS":
      return value
    default:
      return "GET"
  }
}

function readOpcode(value: unknown): 1 | 2 {
  return value === 2 ? 2 : 1
}

/**
 * Parse one relay JSON payload into a typed frame.
 * @param raw - the parsed (unknown) WebSocket payload.
 * @returns the narrowed frame, or `null` for non-frames and outbound-only types.
 */
export function parseFrame(raw: unknown): Frame | null {
  if (!isRecord(raw)) return null
  const t = raw["t"]
  if (typeof t !== "string") return null
  const id = readNumber(raw["id"])

  switch (t) {
    case T.HELLO_OK:
      return { t, pair: readPair(raw["pair"]), peer: readPeerState(raw["peer"]) }
    case T.HELLO_DENY:
      return { t, reason: readDenyReason(raw["reason"]) }
    case T.PEER: {
      const ua = readNullableString(raw["ua"])
      return ua === null
        ? { t, state: raw["state"] === "online" ? "online" : "offline" }
        : { t, state: raw["state"] === "online" ? "online" : "offline", ua }
    }
    case T.REVOKE:
      return { t }
    case T.PAIR_REFRESH:
      return { t }
    case T.PAIR: {
      const pair = readPair(raw) ?? {
        code: readString(raw["code"]),
        expiresAt: readNumber(raw["expiresAt"]),
      }
      return { t, code: pair.code, expiresAt: pair.expiresAt }
    }
    case T.PING:
      return { t }
    case T.PONG:
      return { t }
    case T.HTTP_REQ:
      return {
        t,
        id,
        method: readHttpMethod(raw["method"]),
        path: readString(raw["path"], "/"),
        query: readString(raw["query"]),
        headers: readStringMap(raw["headers"]),
        bodyBase64: readNullableString(raw["bodyBase64"]),
      }
    case T.HTTP_BODY:
      return { t, id, dataBase64: readString(raw["dataBase64"]) }
    case T.HTTP_BODY_END:
      return { t, id }
    case T.HTTP_ABORT:
      return { t, id }
    case T.WS_OPEN:
      return { t, id, path: readString(raw["path"], "/"), headers: readStringMap(raw["headers"]) }
    case T.WS_FRAME:
      return { t, id, opcode: readOpcode(raw["opcode"]), dataBase64: readString(raw["dataBase64"]) }
    case T.WS_CLOSE: {
      const reason = readNullableString(raw["reason"])
      return reason === null
        ? { t, id, code: readNumber(raw["code"], 1000) }
        : { t, id, code: readNumber(raw["code"], 1000), reason }
    }
    default:
      return null
  }
}

/** Exhaustive-switch sentinel re-exported for data-plane dispatch sites. */
export { assertNever }
