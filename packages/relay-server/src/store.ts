import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { STORE_FILE } from "./const.js"

export interface DeviceRecord {
  type: "device"
  deviceId: string
  hostName: string
  createdAt: number
}
export interface PairingRecord {
  type: "pairing"
  deviceId: string
  codeSha: string
  expiresAt: number
}
export interface TokenRecord {
  type: "token"
  deviceId: string
  tokenSha: string
  createdAt: number
  revokedAt: number | null
}
type StoreRecord = DeviceRecord | PairingRecord | TokenRecord

export interface PairingLookup {
  deviceId: string
  codeSha: string
  expiresAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
function readStr(value: unknown): string {
  return typeof value === "string" ? value : ""
}
function readNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
function readNullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * 持久化存储：JSONL append-only，落盘只存 sha256 摘要（code/token 从不明文持久化）。
 * 启动时全量读入内存；运行时内存为准、磁盘追加。
 */
export class RelayStore {
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly pairingsByDevice = new Map<string, PairingRecord>()
  private readonly pairingsByCode = new Map<string, string>()
  private readonly tokensBySha = new Map<string, TokenRecord>()
  private readonly file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, STORE_FILE)
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return
    const text = await readFile(this.file, "utf8")
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (trimmed === "") continue
      let record: unknown
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      this.applyRecord(record)
    }
  }

  private applyRecord(raw: unknown): void {
    if (!isRecord(raw)) return
    const type = raw["type"]
    if (type === "device") {
      const deviceId = readStr(raw["deviceId"])
      if (deviceId === "") return
      this.devices.set(deviceId, {
        type: "device",
        deviceId,
        hostName: readStr(raw["hostName"]),
        createdAt: readNum(raw["createdAt"]),
      })
    } else if (type === "pairing") {
      const deviceId = readStr(raw["deviceId"])
      const codeSha = readStr(raw["codeSha"])
      if (deviceId === "" || codeSha === "") return
      const record: PairingRecord = {
        type: "pairing",
        deviceId,
        codeSha,
        expiresAt: readNum(raw["expiresAt"]),
      }
      this.pairingsByDevice.set(deviceId, record)
      this.pairingsByCode.set(codeSha, deviceId)
    } else if (type === "token") {
      const deviceId = readStr(raw["deviceId"])
      const tokenSha = readStr(raw["tokenSha"])
      if (deviceId === "" || tokenSha === "") return
      this.tokensBySha.set(tokenSha, {
        type: "token",
        deviceId,
        tokenSha,
        createdAt: readNum(raw["createdAt"]),
        revokedAt: readNullableNum(raw["revokedAt"]),
      })
    }
  }

  private async append(record: StoreRecord): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8")
  }

  async addDevice(deviceId: string, hostName: string): Promise<void> {
    const record: DeviceRecord = { type: "device", deviceId, hostName, createdAt: Date.now() }
    this.devices.set(deviceId, record)
    await this.append(record)
  }

  async setPairing(deviceId: string, codeSha: string, expiresAt: number): Promise<void> {
    const existing = this.pairingsByDevice.get(deviceId)
    if (existing !== undefined) this.pairingsByCode.delete(existing.codeSha)
    const record: PairingRecord = { type: "pairing", deviceId, codeSha, expiresAt }
    this.pairingsByDevice.set(deviceId, record)
    this.pairingsByCode.set(codeSha, deviceId)
    await this.append(record)
  }

  /** 按 codeSha 查当前有效配对；过期或索引陈旧返回 null。 */
  getPairingByCodeSha(codeSha: string): PairingLookup | null {
    const deviceId = this.pairingsByCode.get(codeSha)
    if (deviceId === undefined) return null
    const record = this.pairingsByDevice.get(deviceId)
    if (record === undefined || record.codeSha !== codeSha) return null
    if (Date.now() > record.expiresAt) return null
    return { deviceId: record.deviceId, codeSha: record.codeSha, expiresAt: record.expiresAt }
  }

  async clearPairing(deviceId: string): Promise<void> {
    const record = this.pairingsByDevice.get(deviceId)
    if (record === undefined) return
    this.pairingsByDevice.delete(deviceId)
    this.pairingsByCode.delete(record.codeSha)
  }

  hasDevice(deviceId: string): boolean {
    return this.devices.has(deviceId)
  }

  getDevice(deviceId: string): DeviceRecord | null {
    const record = this.devices.get(deviceId)
    return record === undefined ? null : record
  }

  async addToken(deviceId: string, tokenSha: string): Promise<void> {
    const record: TokenRecord = {
      type: "token",
      deviceId,
      tokenSha,
      createdAt: Date.now(),
      revokedAt: null,
    }
    this.tokensBySha.set(tokenSha, record)
    await this.append(record)
  }

  getToken(tokenSha: string): TokenRecord | null {
    const record = this.tokensBySha.get(tokenSha)
    return record === undefined ? null : record
  }

  async revokeToken(tokenSha: string): Promise<void> {
    const record = this.tokensBySha.get(tokenSha)
    if (record === undefined) return
    const next: TokenRecord = { ...record, revokedAt: Date.now() }
    this.tokensBySha.set(tokenSha, next)
    await this.append(next)
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.clearPairing(deviceId)
    for (const record of this.tokensBySha.values()) {
      if (record.deviceId === deviceId && record.revokedAt === null) {
        await this.revokeToken(record.tokenSha)
      }
    }
  }

  listDevices(): DeviceRecord[] {
    return [...this.devices.values()]
  }
}
