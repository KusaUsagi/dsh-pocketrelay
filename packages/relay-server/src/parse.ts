/**
 * dsh-pocketrelay relay-server — 边界解析器。
 *
 * 唯一把 untrusted wire JSON 收敛为 typed {@link Frame} 的地方：WS 负载是
 * `unknown`，{@link parseFrame} 按 protocol 的判别联合收窄。relay 同时收发
 * host 与 phone 两端，因此解析所有 24 种帧（host→relay 的响应面帧也在此解析）。
 */
import {
  type Frame,
  type HelloDenyReason,
  type HttpMethod,
  type PeerState,
  PROTOCOL_VERSION,
  T,
} from "@dsh-pocketrelay/protocol"

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

function readPair(value: unknown): { code: string; expiresAt: number } | null {
  if (!isRecord(value)) return null
  const code = readString(value["code"])
  const expiresAt = readNumber(value["expiresAt"])
  if (code === "" || expiresAt === 0) return null
  return { code, expiresAt }
}

function readPeerState(value: unknown): PeerState | null {
  if (!isRecord(value)) return null
  const hostName = readNullableString(value["hostName"])
  const online = value["online"] === true
  return hostName === null ? { online } : { online, hostName }
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

function readRole(value: unknown): "host" | "phone" | null {
  return value === "host" || value === "phone" ? value : null
}

/**
 * 解析一条 relay JSON 负载为 typed frame。
 * @returns 收敛后的帧；非帧或结构不全返回 `null`。
 */
export function parseFrame(raw: unknown): Frame | null {
  if (!isRecord(raw)) return null
  const t = raw["t"]
  if (typeof t !== "string") return null
  const id = readNumber(raw["id"])
  const v = readNumber(raw["v"], PROTOCOL_VERSION)

  switch (t) {
    case T.HELLO: {
      const role = readRole(raw["role"])
      const deviceId = readString(raw["deviceId"])
      if (deviceId === "") return null
      if (role === "host") {
        const hostToken = readString(raw["hostToken"])
        if (hostToken === "") return null
        const hostName = readNullableString(raw["hostName"])
        return hostName === null
          ? { t, v, role: "host", deviceId, hostToken }
          : { t, v, role: "host", deviceId, hostToken, hostName }
      }
      if (role === "phone") {
        const challenge = readString(raw["challenge"])
        const response = readString(raw["response"])
        const token = readString(raw["token"])
        if (challenge === "" || response === "" || token === "") return null
        return { t, v, role: "phone", deviceId, challenge, response, token }
      }
      return null
    }
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
    case T.REVOKED:
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
    case T.HTTP_HEAD:
      return {
        t,
        id,
        status: readNumber(raw["status"], 200),
        headers: readStringMap(raw["headers"]),
      }
    case T.HTTP_CHUNK:
      return { t, id, dataBase64: readString(raw["dataBase64"]) }
    case T.HTTP_END:
      return { t, id }
    case T.HTTP_ERR:
      return {
        t,
        id,
        code: readString(raw["code"], "UPSTREAM_DOWN"),
        message: readString(raw["message"]),
      }
    case T.WS_OPEN:
      return { t, id, path: readString(raw["path"], "/"), headers: readStringMap(raw["headers"]) }
    case T.WS_OPEN_OK:
      return { t, id }
    case T.WS_OPEN_ERR: {
      const reason = readNullableString(raw["reason"])
      return reason === null ? { t, id, reason: "" } : { t, id, reason }
    }
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
