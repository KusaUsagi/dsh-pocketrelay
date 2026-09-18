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
 * NOTE: the original design used `ctx.apiProxy` (which wraps sessions/host), but
 * apiProxy is not registered in the stock web profile — so we access the
 * underlying `sessions`/`host` services directly (they ARE registered), plus `fs`.
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

/** Local probing surface of the unconfirmed `ctx.sessions` (or apiProxy.sessions). */
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

export class DataPlane {
  private sessions: SessionsCap | undefined = undefined
  private host: HostCap | undefined = undefined
  private fs: FsCap | undefined = undefined

  /** One in-flight `host.describe({})` promise, dropped on reject. */
  private cwdPromise: Promise<string> | undefined = undefined

  constructor(private readonly options: DataPlaneOptions) {}

  /** Set the `sessions` cap (from ctx.get("sessions") or ctx.inject(["sessions"])). */
  setSessions(sessions: unknown): void {
    this.sessions =
      typeof sessions === "object" && sessions !== null ? (sessions as SessionsCap) : undefined
    console.warn(
      `[dsh-pocketrelay/data] setSessions: ${this.sessions === undefined ? "UNDEFINED" : `object{${Object.keys(this.sessions).join(",")}}`}`,
    )
  }

  /** Set the `host` cap (from ctx.get("host") or ctx.inject(["host"])). */
  setHost(host: unknown): void {
    this.host = typeof host === "object" && host !== null ? (host as HostCap) : undefined
    console.warn(
      `[dsh-pocketrelay/data] setHost: ${this.host === undefined ? "UNDEFINED" : `object{${Object.keys(this.host).join(",")}}`}`,
    )
  }

  /** Set the `fs` cap (from ctx.get("fs") or ctx.inject(["fs"])). */
  setFs(fs: unknown): void {
    this.fs = typeof fs === "object" && fs !== null ? (fs as FsCap) : undefined
    console.warn(
      `[dsh-pocketrelay/data] setFs: ${this.fs === undefined ? "UNDEFINED" : `object{${Object.keys(this.fs).join(",")}}`}`,
    )
  }

  handle(frame: DataReqFrame): void {
    console.warn(
      `[dsh-pocketrelay/data] data-req received: kind=${frame.kind} id=${frame.id}${frame.path ? ` path=${frame.path}` : ""}${frame.sessionId ? ` sessionId=${frame.sessionId}` : ""}`,
    )
    void this.run(frame)
  }

  private async run(frame: DataReqFrame): Promise<void> {
    // Per-kind cap checks (not a global both-check): file ops need only fs;
    // conversation ops need sessions; cwd resolution (pathless file-list) needs
    // host. A profile missing one service still serves the others.
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
    if (frame.sessionId !== undefined) {
      const history = sessions.history
      if (typeof history !== "function") {
        this.respond(frame, false, undefined, "sessions.history unavailable")
        return
      }
      const data = await history({ sessionId: frame.sessionId, maxMessages: 200 })
      this.respondData(frame, data)
      return
    }
    const list = sessions.list
    if (typeof list !== "function") {
      this.respond(frame, false, undefined, "sessions.list unavailable")
      return
    }
    const data = await list({})
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
    const prompt = sessions.prompt
    if (typeof prompt !== "function") {
      this.respond(frame, false, undefined, "sessions.prompt unavailable")
      return
    }
    const data = await prompt({
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
    const resolve = fs.resolve
    const listDir = fs.listDir
    if (typeof resolve !== "function") {
      this.respond(frame, false, undefined, "fs.resolve unavailable")
      return
    }
    if (typeof listDir !== "function") {
      this.respond(frame, false, undefined, "fs.listDir unavailable")
      return
    }
    const data = await listDir(resolve(frame.path ?? (await this.getCwd())))
    this.respondData(frame, data)
  }

  private async fileRead(frame: DataReqFrame): Promise<void> {
    const fs = this.fs
    if (fs === undefined) {
      this.respond(frame, false, undefined, "fs service unavailable")
      return
    }
    const resolve = fs.resolve
    const readText = fs.readText
    if (typeof resolve !== "function") {
      this.respond(frame, false, undefined, "fs.resolve unavailable")
      return
    }
    if (typeof readText !== "function") {
      this.respond(frame, false, undefined, "fs.readText unavailable")
      return
    }
    const data = await readText(resolve(frame.path))
    this.respondData(frame, data)
  }

  private async fileWrite(frame: DataReqFrame): Promise<void> {
    const fs = this.fs
    if (fs === undefined) {
      this.respond(frame, false, undefined, "fs service unavailable")
      return
    }
    const resolve = fs.resolve
    const writeText = fs.writeText
    if (typeof resolve !== "function") {
      this.respond(frame, false, undefined, "fs.resolve unavailable")
      return
    }
    if (typeof writeText !== "function") {
      this.respond(frame, false, undefined, "fs.writeText unavailable")
      return
    }
    await writeText(resolve(frame.path), frame.content)
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
      // e.g. the SDK returned a function/symbol — not representable on the wire.
      this.respond(frame, false, undefined, "serialization")
      return
    }
    if (serialized.length > MAX_PAYLOAD_CHARS) {
      this.respond(frame, false, undefined, "payload too large")
      return
    }
    this.respond(frame, true, data)
  }

  /**
   * Cached cwd lookup: one in-flight `host.describe({})` promise. On reject the
   * cache is dropped and the rejection rethrown (next call retries). Needs the
   * `host` service; if absent, throws (caught by run → ok:false) — pathless
   * file-list then can't resolve a relative path; callers should pass a path.
   */
  private getCwd(): Promise<string> {
    const cached = this.cwdPromise
    if (cached !== undefined) return cached

    const describe = this.host?.describe
    if (typeof describe !== "function") {
      throw new Error("host.describe unavailable (host service not registered)")
    }

    const promise = describe({}).then((result): string => {
      if (!isRecord(result)) return ""
      const cwd = result["cwd"]
      return typeof cwd === "string" ? cwd : ""
    })

    this.cwdPromise = promise
    promise.catch(() => {
      this.cwdPromise = undefined
    })
    return promise
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
