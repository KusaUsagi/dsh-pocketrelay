/**
 * dsh-pocketrelay — structured data plane, host side.
 *
 * The relay's `data-req` frames become direct calls into injected DSH SDK
 * services: `ctx.sessions` (list/history/prompt), `ctx.host` (describe → cwd),
 * and `ctx.fs` (resolve/listDir/readText/writeText). The SDK shapes are
 * UNCONFIRMED, so every surface is probed at runtime and degrades to `ok:false`
 * instead of throwing: a service may be absent in this dsh profile (e.g.
 * sessions not registered → conversation ops fail, but file ops still work via
 * fs), a method may be missing, the result may not be JSON-serializable, or it
 * may blow the 1 MiB `data-res` ceiling. `handle` is fire-and-forget; every
 * frame is answered exactly once.
 *
 * IMPORTANT: the service methods (list/history/prompt/describe/resolve/listDir/
 * readText/writeText) are PROTOTYPE methods — they read `this.store`/`this.*`
 * internally, so they MUST be invoked with method-call syntax (`sessions.list({})`,
 * `fs.resolve(p)`) to preserve `this`. Detaching (`const m = sessions.list; m({})`)
 * loses `this` and throws "Cannot read properties of undefined (reading 'store')".
 *
 * NOTE: apiProxy (which wraps sessions/host) is not registered in the stock web
 * profile, so we access sessions/host/fs directly. host is also absent in the
 * stock profile, so pathless file-list falls back to `fs.resolve(".")` instead
 * of host.describe.
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

/**
 * Local probing surface of the unconfirmed `ctx.sessions` (or apiProxy.sessions).
 * Methods are optional because the real shape is unknown; each is narrowed with
 * `typeof === "function"` before invocation (and called with method-call syntax).
 */
interface SessionsCap {
  list?: (args: unknown) => Promise<unknown>
  history?: (args: unknown) => Promise<unknown>
  prompt?: (args: unknown) => Promise<unknown>
}

/** Local probing surface of the unconfirmed `ctx.host` (or apiProxy.host). */
interface HostCap {
  describe?: (args: unknown) => Promise<unknown>
}

/** Local probing surface of the unconfirmed `ctx.fs` (harness working directory). */
interface FsCap {
  resolve?: (path: unknown) => unknown
  listDir?: (path: unknown) => Promise<unknown>
  readText?: (path: unknown) => Promise<unknown>
  writeText?: (path: unknown, content: unknown) => Promise<unknown>
}

/** Mutable twin of `DataResFrame`, built for the conditional `data`/`error` fields. */
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
 * Describe a service cap: own enumerable keys + the prototype's FUNCTION names.
 * Service methods (list/history/prompt/resolve/...) live on the prototype and
 * are NON-enumerable, so `Object.keys` misses them — `getPrototypeOf` +
 * `getOwnPropertyNames` reveals the real API surface for diagnosis.
 */
function describeCap(label: string, cap: unknown): string {
  if (typeof cap !== "object" || cap === null) return `${label}=UNDEFINED`
  const own = Object.keys(cap)
  const protoFns: string[] = []
  try {
    const p = Object.getPrototypeOf(cap)
    if (p !== null && p !== Object.prototype) {
      const rec = cap as Record<string, unknown>
      for (const n of Object.getOwnPropertyNames(p)) {
        if (typeof rec[n] === "function") protoFns.push(n)
      }
    }
  } catch {
    // ignore
  }
  return `${label}=own{${own.join(",")}} proto{${protoFns.slice(0, 24).join(",")}}`
}

export class DataPlane {
  private sessions: SessionsCap | undefined = undefined
  private host: HostCap | undefined = undefined
  private fs: FsCap | undefined = undefined

  constructor(private readonly options: DataPlaneOptions) {}

  /** Set the `sessions` cap (from ctx.get("sessions") or ctx.inject(["sessions"])). */
  setSessions(sessions: unknown): void {
    this.sessions =
      typeof sessions === "object" && sessions !== null ? (sessions as SessionsCap) : undefined
    console.warn(`[dsh-pocketrelay/data] ${describeCap("setSessions", this.sessions)}`)
  }

  /** Set the `host` cap (from ctx.get("host") or ctx.inject(["host"])). */
  setHost(host: unknown): void {
    this.host = typeof host === "object" && host !== null ? (host as HostCap) : undefined
    console.warn(`[dsh-pocketrelay/data] ${describeCap("setHost", this.host)}`)
  }

  /** Set the `fs` cap (from ctx.get("fs") or ctx.inject(["fs"])). */
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
    // Per-kind cap checks: file ops need only fs; conversation ops need sessions.
    // A profile missing one service still serves the others.
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
      this.respond(
        frame,
        false,
        undefined,
        "sessions service unavailable (not registered in this dsh profile)",
      )
      return
    }
    // Method-call syntax (sessions.history({...})) preserves `this=sessions`;
    // detaching (const h = sessions.history; h({...})) loses `this` and throws
    // "Cannot read properties of undefined (reading 'store')".
    if (frame.sessionId !== undefined) {
      if (typeof sessions.history !== "function") {
        this.respond(frame, false, undefined, "sessions.history unavailable")
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
      this.respond(
        frame,
        false,
        undefined,
        "sessions service unavailable (not registered in this dsh profile)",
      )
      return
    }
    const sessionId = frame.sessionId
    const content = frame.content
    if (sessionId === undefined || content === undefined) {
      this.respond(frame, false, undefined, "sessionId and content required")
      return
    }
    if (typeof sessions.prompt !== "function") {
      this.respond(frame, false, undefined, "sessions.prompt unavailable")
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
    // No explicit path → resolve "." (the workspace root). Avoids host.describe
    // (host service is also absent in the stock web profile).
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

  /**
   * Serialize + size-guard a successful SDK result, then respond ok:true. The
   * result itself is passed through verbatim (never reshaped).
   */
  private respondData(frame: DataReqFrame, data: unknown): void {
    if (data === undefined) {
      // SDK returned nothing — succeed with no data field (omit, not undefined).
      this.respond(frame, true)
      return
    }
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
