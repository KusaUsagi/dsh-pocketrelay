/**
 * dsh-pocketrelay — structured data plane, host side.
 *
 * The relay's `data-req` frames become direct calls into injected DSH SDK
 * services: `ctx.apiProxy` (sessions.list/history/prompt, host.describe) and
 * `ctx.fs` (resolve/listDir/readText/writeText). apiProxy is loaded via the
 * `api-gateway` bundle row inserted by this plugin's cordis.patch.yml (the
 * stock web-app bundle should have it, but some dsh versions ship without it;
 * the insert ensures ctx.apiProxy is available). The SDK shapes are probed at
 * runtime and degrade to `ok:false` per-kind: a missing service fails only its
 * own ops (no apiProxy → conversation ops fail, but file ops still work via
 * fs). `handle` is fire-and-forget; every frame is answered exactly once.
 *
 * IMPORTANT: service methods are PROTOTYPE methods that read `this.*` internally
 * — invoke with method-call syntax (`apiProxy.sessions.list({})`, `fs.resolve(p)`)
 * to preserve `this`; detaching (`const m = obj.method; m(...)`) loses `this`
 * and throws "Cannot read properties of undefined (reading 'store')".
 */
import {
  assertNever,
  type DataReqFrame,
  type DataReqKind,
  type DataResFrame,
  T,
} from "@dsh-pocketrelay/protocol"

/** 1 MiB serialized ceiling for a `data-res` frame (string length, not bytes). */
const MAX_PAYLOAD_CHARS = 1048576

interface SessionsCap {
  list?: (args: unknown) => Promise<unknown>
  history?: (args: unknown) => Promise<unknown>
  prompt?: (args: unknown) => Promise<unknown>
}
interface HostCap {
  describe?: (args: unknown) => Promise<unknown>
}
interface ApiProxyCap {
  sessions?: SessionsCap
  host?: HostCap
}
interface FsCap {
  resolve?: (path: unknown) => unknown
  listDir?: (path: unknown) => Promise<unknown>
  readText?: (path: unknown) => Promise<unknown>
  writeText?: (path: unknown, content: unknown) => Promise<unknown>
}

interface MutableDataRes {
  t: "data-res"
  id: number
  kind: DataReqKind
  ok: boolean
  data?: unknown
  error?: string
}

export interface DataPlaneOptions {
  log: (message: string) => void
  send: (frame: DataResFrame) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Describe a cap: own keys + ALL function names walking the full proto chain. */
function describeCap(label: string, cap: unknown): string {
  if (typeof cap !== "object" || cap === null) return `${label}=UNDEFINED`
  const own = Object.keys(cap)
  const fns = new Set<string>()
  const rec = cap as Record<string, unknown>
  let p: object | null = Object.getPrototypeOf(cap)
  let depth = 0
  while (p !== null && p !== Object.prototype && depth < 6) {
    try {
      for (const n of Object.getOwnPropertyNames(p)) {
        if (typeof rec[n] === "function") fns.add(n)
      }
    } catch {
      // ignore
    }
    p = Object.getPrototypeOf(p)
    depth += 1
  }
  return `${label}=own{${own.join(",")}} fns{${[...fns].slice(0, 40).join(",")}}`
}

export class DataPlane {
  private apiProxy: ApiProxyCap | undefined = undefined
  private fs: FsCap | undefined = undefined

  constructor(private readonly options: DataPlaneOptions) {}

  /** Set the apiProxy + fs caps (from ctx.get or ctx.inject). */
  setCaps(apiProxy: unknown, fs: unknown): void {
    this.apiProxy =
      typeof apiProxy === "object" && apiProxy !== null ? (apiProxy as ApiProxyCap) : undefined
    this.fs = typeof fs === "object" && fs !== null ? (fs as FsCap) : undefined
    console.warn(`[dsh-pocketrelay/data] ${describeCap("setCaps.apiProxy", this.apiProxy)}`)
    console.warn(`[dsh-pocketrelay/data] ${describeCap("setCaps.fs", this.fs)}`)
  }

  handle(frame: DataReqFrame): void {
    console.warn(
      `[dsh-pocketrelay/data] data-req received: kind=${frame.kind} id=${frame.id}${frame.path ? ` path=${frame.path}` : ""}${frame.sessionId ? ` sessionId=${frame.sessionId}` : ""}`,
    )
    void this.run(frame)
  }

  private async run(frame: DataReqFrame): Promise<void> {
    // Per-kind: conversation ops need apiProxy; file ops need fs.
    try {
      switch (frame.kind) {
        case "conversation":
          await this.conversation(frame)
          return
        case "send-message":
          await this.sendMessage(frame)
          return
        case "file-list":
          await this.fileList(frame)
          return
        case "file-read":
          await this.fileRead(frame)
          return
        case "file-write":
          await this.fileWrite(frame)
          return
        default:
          assertNever(frame.kind)
      }
    } catch (error) {
      this.respond(frame, false, undefined, errorMessage(error))
    }
  }

  private async conversation(frame: DataReqFrame): Promise<void> {
    const apiProxy = this.apiProxy
    if (apiProxy === undefined) {
      this.respond(
        frame,
        false,
        undefined,
        "apiProxy unavailable (api-gateway bundle row not loaded)",
      )
      return
    }
    // Method-call syntax preserves `this`.
    if (frame.sessionId !== undefined) {
      if (typeof apiProxy.sessions?.history !== "function") {
        this.respond(frame, false, undefined, "apiProxy.sessions.history unavailable")
        return
      }
      const data = await apiProxy.sessions.history({ sessionId: frame.sessionId, maxMessages: 200 })
      this.respondData(frame, data)
      return
    }
    if (typeof apiProxy.sessions?.list !== "function") {
      this.respond(frame, false, undefined, "apiProxy.sessions.list unavailable")
      return
    }
    const data = await apiProxy.sessions.list({})
    this.respondData(frame, data)
  }

  private async sendMessage(frame: DataReqFrame): Promise<void> {
    const apiProxy = this.apiProxy
    if (apiProxy === undefined) {
      this.respond(
        frame,
        false,
        undefined,
        "apiProxy unavailable (api-gateway bundle row not loaded)",
      )
      return
    }
    const sessionId = frame.sessionId
    const content = frame.content
    if (sessionId === undefined || content === undefined) {
      this.respond(frame, false, undefined, "sessionId and content required")
      return
    }
    if (typeof apiProxy.sessions?.prompt !== "function") {
      this.respond(frame, false, undefined, "apiProxy.sessions.prompt unavailable")
      return
    }
    const data = await apiProxy.sessions.prompt({
      sessionId,
      content: [{ type: "text", text: content }],
      mode: "queue",
    })
    this.respondData(frame, data)
  }

  private async fileList(frame: DataReqFrame): Promise<void> {
    const fs = this.fs
    if (fs === undefined) {
      this.respond(frame, false, undefined, "fs service unavailable")
      return
    }
    if (typeof fs.resolve !== "function") {
      this.respond(frame, false, undefined, "fs.resolve unavailable")
      return
    }
    if (typeof fs.listDir !== "function") {
      this.respond(frame, false, undefined, "fs.listDir unavailable")
      return
    }
    // No path → resolve "." (the workspace cwd target). resolve takes a string
    // path and returns an FsTarget (confirmed); method-call preserves this.
    const target = fs.resolve(frame.path ?? ".")
    const data = await fs.listDir(target)
    this.respondData(frame, data)
  }

  private async fileRead(frame: DataReqFrame): Promise<void> {
    const fs = this.fs
    if (fs === undefined) {
      this.respond(frame, false, undefined, "fs service unavailable")
      return
    }
    if (typeof fs.resolve !== "function") {
      this.respond(frame, false, undefined, "fs.resolve unavailable")
      return
    }
    if (typeof fs.readText !== "function") {
      this.respond(frame, false, undefined, "fs.readText unavailable")
      return
    }
    const target = fs.resolve(frame.path)
    const data = await fs.readText(target)
    this.respondData(frame, data)
  }

  private async fileWrite(frame: DataReqFrame): Promise<void> {
    const fs = this.fs
    if (fs === undefined) {
      this.respond(frame, false, undefined, "fs service unavailable")
      return
    }
    if (typeof fs.resolve !== "function") {
      this.respond(frame, false, undefined, "fs.resolve unavailable")
      return
    }
    if (typeof fs.writeText !== "function") {
      this.respond(frame, false, undefined, "fs.writeText unavailable")
      return
    }
    const target = fs.resolve(frame.path)
    await fs.writeText(target, frame.content)
    this.respond(frame, true)
  }

  /** Serialize + size-guard a result; logs shape BEFORE the size check. */
  private respondData(frame: DataReqFrame, data: unknown): void {
    if (data === undefined) {
      this.respond(frame, true)
      return
    }
    const shape =
      data === null
        ? "null"
        : Array.isArray(data)
          ? `array[${data.length}]${data.length > 0 && typeof data[0] === "object" && data[0] !== null ? ` first{${Object.keys(data[0]).join(",")}}` : ""}`
          : isRecord(data)
            ? `object{${Object.keys(data).join(",")}}`
            : typeof data
    console.warn(`[dsh-pocketrelay/data] result shape: kind=${frame.kind} ${shape}`)
    let serialized: unknown
    try {
      serialized = JSON.stringify(data)
    } catch {
      this.respond(frame, false, undefined, "serialization")
      return
    }
    if (typeof serialized !== "string") {
      this.respond(frame, false, undefined, "serialization")
      return
    }
    if (serialized.length > MAX_PAYLOAD_CHARS) {
      this.respond(frame, false, undefined, "payload too large")
      return
    }
    this.respond(frame, true, data)
  }

  private respond(frame: DataReqFrame, ok: boolean, data?: unknown, error?: string): void {
    if (!ok && error !== undefined) {
      this.options.log(`data-res ${frame.kind} ${frame.id} failed: ${error}`)
    }
    const dataDesc =
      data === undefined
        ? "none"
        : data === null
          ? "null"
          : Array.isArray(data)
            ? `array[${data.length}]`
            : isRecord(data)
              ? `object{${Object.keys(data).join(",")}}`
              : typeof data
    console.warn(
      `[dsh-pocketrelay/data] data-res: kind=${frame.kind} id=${frame.id} ok=${ok}${ok ? ` data=${dataDesc}` : ` error=${error ?? ""}`}`,
    )
    const res: MutableDataRes = {
      t: T.DATA_RES,
      id: frame.id,
      kind: frame.kind,
      ok,
    }
    if (data !== undefined) res.data = data
    if (error !== undefined) res.error = error
    this.options.send(res)
  }
}
