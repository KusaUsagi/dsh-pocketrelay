/**
 * dsh-pocketrelay — structured data plane, host side.
 *
 * The relay's `data-req` frames become direct calls into injected DSH SDK
 * services: `ctx.sessions` (list — session lifecycle), `ctx.fs` (file store).
 * The SDK shapes are UNCONFIRMED and the stock web profile does NOT register
 * apiProxy/host (so conversation history/prompt need either enabling apiProxy
 * or the dsh web HTTP API — under investigation). Every surface is probed at
 * runtime and degrades to `ok:false` instead of throwing. `handle` is
 * fire-and-forget; every frame is answered exactly once.
 *
 * IMPORTANT: service methods are PROTOTYPE methods that read `this.*`
 * internally — invoke with method-call syntax (`sessions.list({})`,
 * `fs.resolve(p)`) to preserve `this`; detaching throws
 * "Cannot read properties of undefined (reading 'store')".
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

/**
 * Describe a service cap: own enumerable keys + ALL function names found by
 * walking the ENTIRE prototype chain (methods are non-enumerable, so Object.keys
 * misses them; a single getPrototypeOf only sees the immediate layer). Reveals
 * the full API surface for diagnosis.
 */
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
  private sessions: SessionsCap | undefined = undefined
  private host: HostCap | undefined = undefined
  private fs: FsCap | undefined = undefined

  constructor(private readonly options: DataPlaneOptions) {}

  setSessions(sessions: unknown): void {
    this.sessions =
      typeof sessions === "object" && sessions !== null ? (sessions as SessionsCap) : undefined
    console.warn(`[dsh-pocketrelay/data] ${describeCap("setSessions", this.sessions)}`)
  }

  setHost(host: unknown): void {
    this.host = typeof host === "object" && host !== null ? (host as HostCap) : undefined
    console.warn(`[dsh-pocketrelay/data] ${describeCap("setHost", this.host)}`)
  }

  setFs(fs: unknown): void {
    this.fs = typeof fs === "object" && fs !== null ? (fs as FsCap) : undefined
    console.warn(`[dsh-pocketrelay/data] ${describeCap("setFs", this.fs)}`)
  }

  handle(frame: DataReqFrame): void {
    console.warn(
      `[dsh-pocketrelay/data] data-req received: kind=${frame.kind} id=${frame.id}${frame.path ? ` path=${frame.path}` : ""}${frame.sessionId ? ` sessionId=${frame.sessionId}` : ""}`,
    )
    void this.run(frame)
  }

  private async run(frame: DataReqFrame): Promise<void> {
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
    const sessions = this.sessions
    if (sessions === undefined) {
      this.respond(frame, false, undefined, "sessions service unavailable")
      return
    }
    // Method-call syntax preserves `this=sessions`.
    if (frame.sessionId !== undefined) {
      if (typeof sessions.history !== "function") {
        this.respond(
          frame,
          false,
          undefined,
          "sessions.history unavailable (likely needs apiProxy)",
        )
        return
      }
      const data = await sessions.history({ sessionId: frame.sessionId, maxMessages: 200 })
      this.respondData(frame, data)
      return
    }
    if (typeof sessions.list !== "function") {
      this.respond(frame, false, undefined, "sessions.list unavailable")
      return
    }
    const data = await sessions.list({})
    this.respondData(frame, data)
  }

  private async sendMessage(frame: DataReqFrame): Promise<void> {
    const sessions = this.sessions
    if (sessions === undefined) {
      this.respond(frame, false, undefined, "sessions service unavailable")
      return
    }
    const sessionId = frame.sessionId
    const content = frame.content
    if (sessionId === undefined || content === undefined) {
      this.respond(frame, false, undefined, "sessionId and content required")
      return
    }
    if (typeof sessions.prompt !== "function") {
      this.respond(frame, false, undefined, "sessions.prompt unavailable (likely needs apiProxy)")
      return
    }
    const data = await sessions.prompt({
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
    // No explicit path → probe several inputs; fs.resolve's expected arg shape
    // is UNCONFIRMED (it returned undefined for "." in 0.2.5). Try string paths
    // + an object form; use the first that yields a non-null target.
    const inputs: unknown[] =
      frame.path !== undefined ? [frame.path] : [".", "", "/", { path: "." }]
    let target: unknown
    const tried: string[] = []
    for (const inp of inputs) {
      try {
        const r = fs.resolve(inp)
        const desc = r === undefined ? "undefined" : r === null ? "null" : typeof r
        tried.push(`${typeof inp === "string" ? JSON.stringify(inp) : "obj"}→${desc}`)
        if (r !== undefined && r !== null) {
          target = r
          break
        }
      } catch (e) {
        tried.push(
          `${typeof inp === "string" ? JSON.stringify(inp) : "obj"}→threw:${errorMessage(e)}`,
        )
      }
    }
    if (target === undefined || target === null) {
      this.respond(
        frame,
        false,
        undefined,
        `fs.resolve yielded no target; tried: ${tried.join(" | ")}`,
      )
      return
    }
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

  /**
   * Serialize + size-guard a successful SDK result, then respond ok:true. Logs
   * the result SHAPE before the size check so oversized results (e.g.
   * sessions.list returning the full store) still reveal what they are.
   */
  private respondData(frame: DataReqFrame, data: unknown): void {
    if (data === undefined) {
      this.respond(frame, true)
      return
    }
    // Log shape BEFORE the size guard (oversized results are the common failure).
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
