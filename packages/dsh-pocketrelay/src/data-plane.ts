/**
 * dsh-pocketrelay — structured data plane, host side.
 *
 * The relay's `data-req` frames become direct calls into the injected DSH SDK —
 * `ctx.apiProxy` for conversation/session effects and `ctx.fs` for the harness
 * working-directory file store — with the SDK result streamed back verbatim as a
 * `data-res` frame. The SDK shapes are UNCONFIRMED, so the module probes every
 * surface at runtime and degrades to `ok:false` instead of throwing: the caps may
 * be absent (they only exist once `ctx.inject(["apiProxy", "fs"])` resolves), a
 * method may be missing, the result may not be JSON-serializable, or it may blow
 * the 1 MiB `data-res` ceiling. `handle` is fire-and-forget; every frame is
 * answered exactly once.
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
 * Local probing surface of the unconfirmed `ctx.apiProxy`. Fields and methods are
 * all optional because the real shape is unknown; each method is narrowed with
 * `typeof === "function"` before it is invoked, never trusted statically.
 */
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
  private apiProxy: ApiProxyCap | undefined = undefined
  private fs: FsCap | undefined = undefined

  /** One in-flight `apiProxy.host.describe({})` promise, dropped on reject. */
  private cwdPromise: Promise<string> | undefined = undefined

  constructor(private readonly options: DataPlaneOptions) {}

  /** Called once `ctx.inject(["apiProxy", "fs"])` resolves; caps stay undefined until then. */
  setCaps(apiProxy: unknown, fs: unknown): void {
    this.apiProxy =
      typeof apiProxy === "object" && apiProxy !== null ? (apiProxy as ApiProxyCap) : undefined
    this.fs = typeof fs === "object" && fs !== null ? (fs as FsCap) : undefined
  }

  handle(frame: DataReqFrame): void {
    void this.run(frame)
  }

  private async run(frame: DataReqFrame): Promise<void> {
    const apiProxy = this.apiProxy
    const fs = this.fs
    if (apiProxy === undefined || fs === undefined) {
      this.respond(frame, false, undefined, "host capabilities not ready")
      return
    }
    try {
      switch (frame.kind) {
        case "conversation":
          await this.conversation(frame, apiProxy)
          return
        case "send-message":
          await this.sendMessage(frame, apiProxy)
          return
        case "file-list":
          await this.fileList(frame, fs)
          return
        case "file-read":
          await this.fileRead(frame, fs)
          return
        case "file-write":
          await this.fileWrite(frame, fs)
          return
        default:
          assertNever(frame.kind)
      }
    } catch (error) {
      this.respond(frame, false, undefined, errorMessage(error))
    }
  }

  private async conversation(frame: DataReqFrame, apiProxy: ApiProxyCap): Promise<void> {
    if (frame.sessionId !== undefined) {
      const history = apiProxy.sessions?.history
      if (typeof history !== "function") {
        this.respond(frame, false, undefined, "history unavailable")
        return
      }
      const data = await history({ sessionId: frame.sessionId, maxMessages: 200 })
      this.respondData(frame, data)
      return
    }
    const list = apiProxy.sessions?.list
    if (typeof list !== "function") {
      this.respond(frame, false, undefined, "list unavailable")
      return
    }
    const data = await list({})
    this.respondData(frame, data)
  }

  private async sendMessage(frame: DataReqFrame, apiProxy: ApiProxyCap): Promise<void> {
    const sessionId = frame.sessionId
    const content = frame.content
    if (sessionId === undefined || content === undefined) {
      this.respond(frame, false, undefined, "sessionId and content required")
      return
    }
    const prompt = apiProxy.sessions?.prompt
    if (typeof prompt !== "function") {
      this.respond(frame, false, undefined, "prompt unavailable")
      return
    }
    const data = await prompt({
      sessionId,
      content: [{ type: "text", text: content }],
      mode: "queue",
    })
    this.respondData(frame, data)
  }

  private async fileList(frame: DataReqFrame, fs: FsCap): Promise<void> {
    const resolve = fs.resolve
    const listDir = fs.listDir
    if (typeof resolve !== "function") {
      this.respond(frame, false, undefined, "resolve unavailable")
      return
    }
    if (typeof listDir !== "function") {
      this.respond(frame, false, undefined, "listDir unavailable")
      return
    }
    const data = await listDir(resolve(frame.path ?? (await this.getCwd())))
    this.respondData(frame, data)
  }

  private async fileRead(frame: DataReqFrame, fs: FsCap): Promise<void> {
    const resolve = fs.resolve
    const readText = fs.readText
    if (typeof resolve !== "function") {
      this.respond(frame, false, undefined, "resolve unavailable")
      return
    }
    if (typeof readText !== "function") {
      this.respond(frame, false, undefined, "readText unavailable")
      return
    }
    const data = await readText(resolve(frame.path))
    this.respondData(frame, data)
  }

  private async fileWrite(frame: DataReqFrame, fs: FsCap): Promise<void> {
    const resolve = fs.resolve
    const writeText = fs.writeText
    if (typeof resolve !== "function") {
      this.respond(frame, false, undefined, "resolve unavailable")
      return
    }
    if (typeof writeText !== "function") {
      this.respond(frame, false, undefined, "writeText unavailable")
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
   * Cached cwd lookup: one in-flight `apiProxy.host.describe({})` promise, so a
   * burst of `file-list` frames shares a single call. On reject the cache is
   * dropped and the rejection rethrown to the caller (next call retries).
   */
  private getCwd(): Promise<string> {
    const cached = this.cwdPromise
    if (cached !== undefined) return cached

    const describe = this.apiProxy?.host?.describe
    if (typeof describe !== "function") {
      throw new Error("host.describe unavailable")
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
