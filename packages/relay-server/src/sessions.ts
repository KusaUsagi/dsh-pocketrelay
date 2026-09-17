import { randomBytes, timingSafeEqual } from "node:crypto"
import { computeResponse } from "./auth.js"
import { ADMIN_SESSION_TTL_MS, CHALLENGE_TTL_MS, SESSION_TTL_MS } from "./const.js"

export interface PhoneSession {
  deviceId: string
  tokenSha: string
  expiresAt: number
}
interface ChallengeEntry {
  deviceId: string
  code: string
  token: string
  expiresAt: number
}

/**
 * 内存态：手机会话 cookie、管理台会话、一次性配对挑战。
 * 挑战在 /pair 签发（暂存 code 用于复算 response）、在 WS 握手消费。
 */
export class SessionRegistry {
  private readonly phone = new Map<string, PhoneSession>()
  private readonly admin = new Map<string, { expiresAt: number }>()
  private readonly challenges = new Map<string, ChallengeEntry>()

  createPhone(deviceId: string, tokenSha: string): string {
    const sid = randomBytes(32).toString("base64url")
    this.phone.set(sid, { deviceId, tokenSha, expiresAt: Date.now() + SESSION_TTL_MS })
    return sid
  }

  getPhone(sid: string): PhoneSession | null {
    const entry = this.phone.get(sid)
    if (entry === undefined) return null
    if (Date.now() > entry.expiresAt) {
      this.phone.delete(sid)
      return null
    }
    return entry
  }

  revokePhoneByDevice(deviceId: string): void {
    for (const [sid, entry] of this.phone) {
      if (entry.deviceId === deviceId) this.phone.delete(sid)
    }
  }

  createAdmin(): string {
    const sid = randomBytes(32).toString("base64url")
    this.admin.set(sid, { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS })
    return sid
  }

  getAdmin(sid: string): boolean {
    const entry = this.admin.get(sid)
    if (entry === undefined) return false
    if (Date.now() > entry.expiresAt) {
      this.admin.delete(sid)
      return false
    }
    return true
  }

  issueChallenge(
    deviceId: string,
    code: string,
    token: string,
  ): { challenge: string; challengeTtlMs: number } {
    const challenge = randomBytes(32).toString("hex")
    this.challenges.set(challenge, {
      deviceId,
      code,
      token,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    })
    return { challenge, challengeTtlMs: CHALLENGE_TTL_MS }
  }

  /** 验证并消费一次性挑战；成功返回 {deviceId, token}，失败/过期返回 null。 */
  consumeChallenge(
    challenge: string,
    response: string,
  ): { deviceId: string; token: string } | null {
    const entry = this.challenges.get(challenge)
    if (entry === undefined) return null
    this.challenges.delete(challenge)
    if (Date.now() > entry.expiresAt) return null
    const expected = computeResponse(entry.code, challenge)
    if (!safeEqual(expected, response)) return null
    return { deviceId: entry.deviceId, token: entry.token }
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
