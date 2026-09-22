/**
 * dsh-pocketrelay — relay-frame boundary parser.
 *
 * The single place untrusted wire JSON becomes a typed `Frame`: the WebSocket
 * payload is `unknown`, `parseFrame` narrows it against the protocol's
 * discriminated union (packages/protocol). Every interior module then receives
 * typed frames and never re-validates. The data-plane subset routed to the
 * data plane is {@link DataPlaneFrame}; outbound-only frame types (which the
 * relay never sends to a host) parse to `null` and are ignored.
 */
import {
  assertNever,
  type DataReqFrame,
  type DataReqKind,
  type Frame,
  type HelloDenyReason,
  type PeerState,
  T,
} from "@dsh-pocketrelay/protocol"

/** Inbound data-plane frames dispatched from the agent to the data plane. */
export type DataPlaneFrame = DataReqFrame

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

function readKind(value: unknown): DataReqKind | null {
  switch (value) {
    case "conversation":
    case "conversation-create":
    case "conversation-pending":
    case "conversation-respond":
    case "file-list":
    case "file-read":
    case "file-write":
    case "send-message":
    case "workspace-list":
      return value
    default:
      return null
  }
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
    case T.DATA_REQ: {
      const kind = readKind(raw["kind"])
      if (kind === null) return null
      const path = readNullableString(raw["path"])
      const content = readNullableString(raw["content"])
      const sessionId = readNullableString(raw["sessionId"])
      const workspaceId = readNullableString(raw["workspaceId"])
      const eventId = readNullableString(raw["eventId"])
      const frame: {
        t: "data-req"
        id: number
        kind: DataReqKind
        path?: string
        content?: string
        sessionId?: string
        workspaceId?: string
        eventId?: string
      } = { t: "data-req", id, kind }
      if (path !== null) frame.path = path
      if (content !== null) frame.content = content
      if (sessionId !== null) frame.sessionId = sessionId
      if (workspaceId !== null) frame.workspaceId = workspaceId
      if (eventId !== null) frame.eventId = eventId
      return frame
    }
    default:
      return null
  }
}

/** Exhaustive-switch sentinel re-exported for data-plane dispatch sites. */
export { assertNever }
