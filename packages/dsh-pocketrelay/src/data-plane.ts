/**
 * dsh-pocketrelay — structured data plane, host side.
 *
 * The relay's `data-req` frames are answered two ways:
 *  - Conversation ops (sessions list/history/prompt): the plugin FETCHES the
 *    local dsh web HTTP API (`POST http://127.0.0.1:<webServer.port>/api/<method>`).
 *    The dsh web's /api/* handler (owned by the connection plugin) runs in a
 *    scope where ctx.apiProxy IS defined (the web UI uses it), so loopback
 *    fetches pass the trust fence (Host: 127.0.0.1) and reach the high-level
 *    conversation gateway — no apiProxy needed in THIS plugin's scope.
 *  - File ops (list/read/write): direct calls into `ctx.fs` (resolve/listDir/
 *    readText/writeText) with method-call syntax to preserve `this`.
 *
 * The dsh web HTTP API envelope (per harness source):
 *   request  = { type:'client-request', rpcId, method, payload }
 *   response = { type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error} }
 * Methods: session.list, session.history, session.prompt.
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

interface ApiResponse {
  result?: { ok?: boolean; value?: unknown; error?: { message?: string; code?: string } }
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

/** Describe the fs cap: own keys + ALL function names walking the proto chain. */
function describeFs(fs: unknown): string {
  if (typeof fs !== "object" || fs === null) return "UNDEFINED"
  const own = Object.keys(fs)
  const fns = new Set<string>()
  const rec = fs as Record<string, unknown>
  let p: object | null = Object.getPrototypeOf(fs)
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
  return `own{${own.join(",")}} fns{${[...fns].slice(0, 40).join(",")}}`
}

export class DataPlane {
  private fs: FsCap | undefined = undefined
  private origin: string | undefined = undefined

  constructor(private readonly options: DataPlaneOptions) {}

  /** Set the fs cap (from ctx.get("fs") or ctx.inject(["fs"])). */
  setFs(fs: unknown): void {
    this.fs = typeof fs === "object" && fs !== null ? (fs as FsCap) : undefined
    console.warn(
      `[dsh-pocketrelay/data] setFs: ${this.fs === undefined ? "UNDEFINED" : describeFs(this.fs)}`,
    )
  }

  /** Set the dsh web origin for HTTP API calls (http://127.0.0.1:<webServer.port>). */
  setOrigin(origin: string): void {
    this.origin = origin
    console.warn(`[dsh-pocketrelay/data] setOrigin: ${origin}`)
  }

  handle(frame: DataReqFrame): void {
    console.warn(
      `[dsh-pocketrelay/data] data-req received: kind=${frame.kind} id=${frame.id}${frame.path ? ` path=${frame.path}` : ""}${frame.sessionId ? ` sessionId=${frame.sessionId}` : ""}`,
    )
    void this.run(frame)
  }

  private async run(frame: DataReqFrame): Promise<void> {
    // Per-kind: conversation ops need the web origin (HTTP API); file ops need fs.
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

  /** POST to the dsh web /api/<method> with the client-request envelope; returns
   *  result.value on ok:true, throws on ok:false / HTTP error. Loopback Host
   *  passes the trust fence; no token needed. */
  private async apiCall(method: string, payload: unknown): Promise<unknown> {
    if (this.origin === undefined) throw new Error("webServer origin not set")
    const rpcId = Math.random().toString(36).slice(2, 12)
    const res = await fetch(`${this.origin}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const body = (await res.json()) as ApiResponse
    if (body?.result?.ok !== true) {
      throw new Error(body?.result?.error?.message ?? body?.result?.error?.code ?? "api error")
    }
    return body.result.value
  }

  private async conversation(frame: DataReqFrame): Promise<void> {
    if (frame.sessionId !== undefined) {
      const data = await this.apiCall("session.history", {
        sessionId: frame.sessionId,
        maxMessages: 200,
      })
      this.respondData(frame, data)
      return
    }
    const data = await this.apiCall("session.list", { cursor: "" })
    this.respondData(frame, data)
  }

  private async sendMessage(frame: DataReqFrame): Promise<void> {
    const sessionId = frame.sessionId
    const content = frame.content
    if (sessionId === undefined || content === undefined) {
      this.respond(frame, false, undefined, "sessionId and content required")
      return
    }
    const data = await this.apiCall("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: content }],
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
    // No path → resolve "." (workspace cwd). resolve takes a string, returns FsTarget.
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
