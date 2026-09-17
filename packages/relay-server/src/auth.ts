import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"
import { SESSION_COOKIE, SESSION_TTL_MS } from "./const.js"

/** sha256 hex 摘要。 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

/** 6 位十进制配对码。 */
export function generatePairCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0")
}

/** 32 字节十六进制 token（手机设备令牌）。 */
export function generateToken(): string {
  return randomBytes(32).toString("hex")
}

/** 32 字节十六进制挑战。 */
export function generateChallenge(): string {
  return randomBytes(32).toString("hex")
}

/**
 * response = HMAC_SHA256(key = SHA256(code) 原始 32 字节, msg = challenge) hex。
 * 手机侧用同一公式（见 docs/PROTOCOL.md §4）。
 */
export function computeResponse(code: string, challenge: string): string {
  const key = createHash("sha256").update(code).digest()
  return createHmac("sha256", key).update(challenge).digest("hex")
}

export function verifyResponse(code: string, challenge: string, response: string): boolean {
  const expected = computeResponse(code, challenge)
  const a = Buffer.from(expected)
  const b = Buffer.from(response)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 手机会话 Set-Cookie 值（HttpOnly+Secure, 30 天）。 */
export function mintSessionCookie(sessionId: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000)
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`
}

const SALT_LEN = 16
const KEY_LEN = 64

/** scrypt 哈希管理台口令，返回 "saltB64:hashB64"。 */
export function hashAdminPassword(password: string): string {
  const salt = randomBytes(SALT_LEN)
  const hash = scryptSync(password, salt, KEY_LEN)
  return `${salt.toString("base64")}:${hash.toString("base64")}`
}

export function verifyAdminPassword(password: string, stored: string): boolean {
  const sep = stored.indexOf(":")
  if (sep === -1) return false
  const salt = Buffer.from(stored.slice(0, sep), "base64")
  const expected = Buffer.from(stored.slice(sep + 1), "base64")
  const hash = scryptSync(password, salt, KEY_LEN)
  return hash.length === expected.length && timingSafeEqual(hash, expected)
}
