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
 *    BUT browserAuth.isAuthenticated then rejects cookieless requests with 401,
 *    so the plugin mints the browser-session cookie in-process: it reads the
 *    launch token from `ctx.get("connection").browserAuth.launchToken`, GETs
 *    `/?token=<token>` (303 Set-Cookie), and replays `cookie: dsh-auth-...=v1...`
 *    on every /api POST. See `ensureCookie()` + `apiCall()`.
 *  - File ops (list/read/write): direct calls into `ctx.fs` (resolve/listDir/
 *    readText/writeText) with method-call syntax to preserve `this`.
 *
 * The dsh web HTTP API envelope (per dsh-client-connection clientRequestSchema
 * + dsh-api-gateway remoteRequest):
 *   request  = { type:'client-request', rpcId, method, payload }
 *              where `payload` MUST be `{ args: <plain-object> }` — business
 *              params go under payload.args (remoteRequest throws if `args`
 *              is absent or payload has extra keys)
 *   response = { type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error} }
 * Endpoints (namespace/method, slash-separated — dsh-api-gateway endpointOf
 * joins with `/`, dot-separated names are NOT claimed and 404):
 *   session/list   — visible Session summaries (returns { items: [...] })
 *   session/page   — one message-aligned history page (params: address{kind,
 *                    sessionId}, throughSeq:-1, maxMessages?)
 *   session/prompt — admit one prompt (params: requestId, sessionId, mode,
 *                    content[])
 *   session/create — create a new session bound to a workspace (params:
 *                    workspaceId; returns { sessionId, agentPreset? })
 */

import { randomUUID } from "node:crypto"
import {
  assertNever,
  type DataReqFrame,
  type DataReqKind,
  type DataResFrame,
  T,
} from "@dsh-pocketrelay/protocol"
import { WebSocket as WsClient } from "ws"

/** 4 MiB serialized ceiling for a `data-res` frame (string length, not bytes).
 *  WS can carry larger frames, but the phone JSON.parse path degrades on very
 *  large payloads. 4 MiB covers a full 50-message history page including tool
 *  results and long content blocks; if a session exceeds this, paginate via
 *  beforeSeq instead of raising the limit further. */
const MAX_PAYLOAD_CHARS = 4194304

/** Workspace cwd used as the base for every fs.resolve call.
 *  dsh-fs-local's LocalFileSystem.config.cwd defaults to process.cwd() —
 *  which is the directory `dsh --profile web` was launched from (typically
 *  C:\Users\<user>, NOT the project workspace). Until the relay/host pair
 *  exposes a workspace selector in the pairing flow, hardcode the testing
 *  workspace so the mobile file tree points at the project, not the user
 *  home. TODO: replace with a per-session/per-workspace selector once
 *  multi-workspace lands. */
const WORKSPACE_CWD = "D:/Desktop/myWorkspace/dsh-workspace"

/** dsh-fs-local LocalFileSystem.resolve accepts an optional opts.cwd that
 *  overrides config.cwd for one resolution. Modeled as a narrow structural
 *  type so the plugin compiles without importing @deepseek-ai/dsh-fs-local. */
interface FsResolveOpts {
  cwd?: string
}

interface FsCap {
  resolve?: (path: unknown, opts?: FsResolveOpts) => unknown
  listDir?: (path: unknown) => Promise<unknown>
  readText?: (path: unknown) => Promise<unknown>
  writeText?: (path: unknown, content: unknown) => Promise<unknown>
}

/** Narrow structural type for ctx.workspaceRegistry (dsh-workspace's
 *  WorkspaceRegistry Service). We only call the synchronous `list()` method,
 *  which returns ordered Workspace entities. Each entity exposes `id`,
 *  `path`, `title`, `createdAt`, `updatedAt`, and a `sessionIds` getter —
 *  all plain JSON-safe strings, so we project them to a serializable shape
 *  before sending over the wire. Modeled structurally so the plugin compiles
 *  without importing @deepseek-ai/dsh-workspace. */
interface WorkspaceEntityCap {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Getter filtered by the registry's startup header-cwd index; returns
   *  only the session ids that still belong to this workspace's path. */
  readonly sessionIds: string[]
}

interface WorkspaceRegistryCap {
  list: () => WorkspaceEntityCap[]
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

/** A pending user-question or approval interaction from the dsh web's $events
 *  stream. Keyed by `eventId` in the RemoteEventsClient's pending Map. */
interface PendingInteraction {
  readonly eventId: string
  /** "user-questions/request" | "approval/request" — the waterfall event name. */
  readonly event: string
  /** The request payload:
   *  - user-questions/request: { questions: AskUserQuestionItem[] }
   *  - approval/request: { toolName, callId?, reason? } */
  readonly request: unknown
}

/** Maintains a persistent WS to the dsh web's `/api/remote.mux` subscribed to the
 *  `$events` stream. The dsh web pushes `waterfall` frames for pending user
 *  questions and tool approvals; without subscribing, these interactions are
 *  invisible and the task hangs forever (the session log only records audit
 *  events like `approval/asked` that don't carry the `eventId`/`clientId`
 *  needed to answer).
 *
 *  The client stores pending interactions in memory and exposes them via the
 *  `conversation-pending` data-req kind. Answers are sent back via
 *  `conversation-respond` → POST `/api/$events/result` with the stored
 *  clientId + eventId. On WS disconnect the pending Map is cleared; on
 *  reconnect the dsh web replays still-pending waterfalls with the same
 *  eventIds but a new clientId. */
class RemoteEventsClient {
  private ws: WsClient | null = null
  private clientId: string | undefined = undefined
  private readonly pending = new Map<string, PendingInteraction>()
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined
  private closed = false
  private cookie: string | undefined = undefined
  private streamId: string = randomUUID()

  constructor(
    private readonly origin: string,
    private readonly log: (message: string) => void,
  ) {}

  setCookie(cookie: string | undefined): void {
    this.cookie = cookie
  }

  start(): void {
    this.closed = false
    this.connect()
  }

  stop(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.ws !== null) {
      try {
        this.ws.close()
      } catch {
        // already closed
      }
      this.ws = null
    }
    this.pending.clear()
    this.clientId = undefined
  }

  getPending(): PendingInteraction[] {
    return [...this.pending.values()]
  }

  getClientId(): string | undefined {
    return this.clientId
  }

  removePending(eventId: string): void {
    this.pending.delete(eventId)
  }

  // --------------------------------------------------------------- internals

  private connect(): void {
    if (this.closed) return
    if (this.cookie === undefined) {
      // Cookie not minted yet; retry shortly (ensureCookie will setCookie
      // which triggers the next connect via the 2s retry).
      this.scheduleReconnect(2000)
      return
    }
    const wsUrl = this.origin.replace(/^http/, "ws") + "/api/remote.mux"
    this.streamId = randomUUID()
    const headers: Record<string, string> = { Cookie: this.cookie }
    let ws: WsClient
    try {
      ws = new WsClient(wsUrl, { headers })
    } catch (error) {
      this.log(`remote.mux connect failed: ${errorMessage(error)}`)
      this.scheduleReconnect(2000)
      return
    }
    this.ws = ws
    ws.on("open", () => {
      this.log("remote.mux connected; sending $events open")
      ws.send(
        JSON.stringify({
          type: "open",
          streamId: this.streamId,
          endpoint: "$events",
          payload: { args: {} },
        }),
      )
    })
    ws.on("message", (data: Buffer) => {
      let msg: unknown
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      this.handleMessage(msg)
    })
    ws.on("close", () => {
      this.log("remote.mux closed; clearing pending + scheduling reconnect")
      this.pending.clear()
      this.clientId = undefined
      this.ws = null
      if (!this.closed) this.scheduleReconnect(2000)
    })
    ws.on("error", (err: Error) => {
      this.log(`remote.mux error: ${err.message}`)
    })
  }

  private handleMessage(msg: unknown): void {
    if (!isRecord(msg)) return
    if (msg["type"] !== "item") return
    const value = msg["value"]
    if (!isRecord(value)) return
    const itemType = value["type"]
    if (itemType === "ready") {
      const clientId = value["clientId"]
      if (typeof clientId === "string") {
        this.clientId = clientId
        this.log(`$events stream ready: clientId=${clientId.slice(0, 8)}`)
      }
      return
    }
    if (itemType === "waterfall") {
      const eventId = value["eventId"]
      const event = value["event"]
      if (typeof eventId === "string" && typeof event === "string") {
        this.pending.set(eventId, {
          eventId,
          event,
          request: value["request"],
        })
        this.log(`pending waterfall: event=${event} eventId=${eventId.slice(0, 8)}`)
      }
      return
    }
    if (itemType === "emit") {
      // Event resolved (answered from this client, another client, or timed
      // out). Remove from pending so the mobile UI stops showing it.
      const eventId = value["eventId"]
      if (typeof eventId === "string") {
        this.pending.delete(eventId)
      }
      return
    }
    if (itemType === "end") {
      this.log("$events stream ended; clearing pending + reconnecting")
      this.pending.clear()
      this.clientId = undefined
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs)
  }
}

export class DataPlane {
  private fs: FsCap | undefined = undefined
  private workspaceRegistry: WorkspaceRegistryCap | undefined = undefined
  private origin: string | undefined = undefined
  private launchToken: string | undefined = undefined
  /** Cached browser-session cookie (`dsh-auth-<hash>=v1.<body>.<sig>`), replayed
   *  as the `Cookie` header on every `/api` POST so requests pass browserAuth. */
  private cookie: string | undefined = undefined
  /** Persistent WS to dsh web's /api/remote.mux subscribed to $events stream.
   *  Stores pending user-questions/approval interactions so the mobile UI can
   *  render them and answer via /api/$events/result. Without this, DSH pauses
   *  asking the user a question and the task hangs forever (the session log
   *  only records audit events without the eventId needed to answer). */
  private eventsClient: RemoteEventsClient | undefined = undefined

  constructor(private readonly options: DataPlaneOptions) {}

  /** Set the fs cap (from ctx.get("fs") or ctx.inject(["fs"])). */
  setFs(fs: unknown): void {
    this.fs = typeof fs === "object" && fs !== null ? (fs as FsCap) : undefined
    console.warn(
      `[dsh-pocketrelay/data] setFs: ${this.fs === undefined ? "UNDEFINED" : describeFs(this.fs)}`,
    )
  }

  /** Set the workspace registry cap (from ctx.get("workspaceRegistry") or
   *  ctx.inject(["workspaceRegistry"])). Used by the `workspace-list` frame
   *  to return the durable workspace order + each workspace's path/title/
   *  sessionIds — the mobile UI groups sessions under their owning workspace. */
  setWorkspaceRegistry(reg: unknown): void {
    this.workspaceRegistry =
      typeof reg === "object" &&
      reg !== null &&
      typeof (reg as WorkspaceRegistryCap).list === "function"
        ? (reg as WorkspaceRegistryCap)
        : undefined
    console.warn(
      `[dsh-pocketrelay/data] setWorkspaceRegistry: ${this.workspaceRegistry === undefined ? "UNDEFINED" : "OK"}`,
    )
  }

  /** Set the dsh web origin for HTTP API calls (http://127.0.0.1:<webServer.port>). */
  setOrigin(origin: string): void {
    this.origin = origin
    console.warn(`[dsh-pocketrelay/data] setOrigin: ${origin}`)
    // Start the $events stream client: subscribes to /api/remote.mux for
    // pending user-questions/approval waterfall frames. The client retries
    // until the cookie is minted (ensureCookie passes it via setCookie).
    if (this.eventsClient === undefined) {
      this.eventsClient = new RemoteEventsClient(origin, (msg) => this.options.log(msg))
      this.eventsClient.setCookie(this.cookie)
      this.eventsClient.start()
    }
  }

  /** Stop the $events stream client (called on plugin dispose). */
  dispose(): void {
    this.eventsClient?.stop()
    this.eventsClient = undefined
  }

  /** Set the dsh web launch token (from ctx.get("connection").browserAuth.launchToken).
   *  The token mints the browser-session cookie via GET /?token=<launchToken>,
   *  which is then replayed on every /api POST (browserAuth.isAuthenticated needs
   *  the signed cookie; the token alone does NOT pass /api auth). */
  setLaunchToken(token: unknown): void {
    this.launchToken = typeof token === "string" && token.length > 0 ? token : undefined
    // Never log the token itself; only its length, to confirm we got one.
    console.warn(
      `[dsh-pocketrelay/data] setLaunchToken: ${this.launchToken === undefined ? "UNDEFINED" : `len=${this.launchToken.length}`}`,
    )
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
        case "conversation-create":
          await this.conversationCreate(frame)
          return
        case "conversation-pending":
          await this.conversationPending(frame)
          return
        case "conversation-respond":
          await this.conversationRespond(frame)
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
        case "workspace-list":
          await this.workspaceList(frame)
          return
        default:
          assertNever(frame.kind)
      }
    } catch (error) {
      this.respond(frame, false, undefined, errorMessage(error))
    }
  }

  /** Mint (or reuse) the dsh web browser-session cookie. The web app's `GET /`
   *  handler runs `connection.authorizeIndex`, which on a valid `?token=<launchToken>`
   *  responds 303 with `Set-Cookie: dsh-auth-<hash>=v1.<body>.<sig>; HttpOnly; ...`.
   *  We capture `name=value` (before the first `;`) and replay it on `/api` POSTs.
   *  `redirect: "manual"` keeps fetch from following the 303 to `/` (which would
   *  otherwise 401 because Node fetch does not auto-attach the just-set cookie). */
  private async ensureCookie(): Promise<void> {
    if (this.cookie !== undefined) return
    if (this.origin === undefined) throw new Error("webServer origin not set")
    if (this.launchToken === undefined) {
      throw new Error("launch token unavailable (connection.browserAuth.launchToken missing)")
    }
    const url = `${this.origin}/?token=${encodeURIComponent(this.launchToken)}`
    const res = await fetch(url, { method: "GET", redirect: "manual" })
    // Feature-detect getSetCookie (Node 22 / undici has it); fall back to the
    // raw combined header value. Cookie values are base64url (`[A-Za-z0-9_-]`
    // plus `.`), so no `, ` appears inside a single dsh-auth cookie line.
    const headers = res.headers as Headers & {
      getSetCookie?: () => string[]
    }
    const setCookieList: string[] =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie") !== null
          ? [headers.get("set-cookie") as string]
          : []
    const authCookie = setCookieList.find((c) => c.startsWith("dsh-auth-"))
    if (authCookie === undefined) {
      throw new Error(
        `cookie mint failed: status=${res.status} set-cookie=${
          setCookieList.length > 0 ? setCookieList.join(" | ") : "none"
        }`,
      )
    }
    this.cookie = (authCookie.split(";")[0] ?? "").trim()
    const cookieName = this.cookie.split("=")[0] ?? "?"
    console.warn(`[dsh-pocketrelay/data] cookie minted: status=${res.status} name=${cookieName}`)
    // Pass the freshly minted cookie to the $events stream client so it can
    // open its /api/remote.mux WS (browserAuth requires the cookie on the
    // upgrade request, same as /api HTTP POSTs).
    this.eventsClient?.setCookie(this.cookie)
  }

  /** POST to the dsh web /api/<namespace>/<method> with the client-request
   *  envelope; returns result.value on ok:true, throws on ok:false / HTTP error.
   *  The browser-session cookie is minted once via ensureCookie() and replayed
   *  as the `Cookie` header so the request passes browserAuth.isAuthenticated
   *  (the loopback Host already passes the trust fence). A 401 mid-call clears
   *  the cookie, re-mints, retries once — covers a stale/expired cookie without
   *  a per-request round-trip.
   *
   *  Wire envelope (per dsh-client-connection clientRequestSchema +
   *  dsh-api-gateway remoteRequest): `payload` MUST be `{ args: <plain-object>
   *  }` — the typert gateway refuses payloads with any other shape (its
   *  remoteRequest throws "Remote payload must contain exactly one plain-object
   *  args field" if `args` is absent or `payload` has extra keys). So the
   *  business params (cursor / address+throughSeq / requestId+sessionId+mode+
   *  content) go under `payload.args`, not at the payload top level. */
  private async apiCall(method: string, params: unknown): Promise<unknown> {
    if (this.origin === undefined) throw new Error("webServer origin not set")
    const rpcId = Math.random().toString(36).slice(2, 12)
    const body = JSON.stringify({
      type: "client-request",
      rpcId,
      method,
      payload: { args: params },
    })
    for (let attempt = 0; ; attempt += 1) {
      await this.ensureCookie()
      const headers: Record<string, string> = {
        "content-type": "application/json",
      }
      if (this.cookie !== undefined) headers["cookie"] = this.cookie
      const res = await fetch(`${this.origin}/api/${method}`, {
        method: "POST",
        headers,
        body,
      })
      if (res.status === 401 && attempt === 0) {
        console.warn(
          `[dsh-pocketrelay/data] api ${method} got 401; re-minting cookie and retrying once`,
        )
        this.cookie = undefined
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      const json = (await res.json()) as ApiResponse
      if (json?.result?.ok !== true) {
        throw new Error(json?.result?.error?.message ?? json?.result?.error?.code ?? "api error")
      }
      return json.result.value
    }
  }

  private async conversation(frame: DataReqFrame): Promise<void> {
    if (frame.sessionId !== undefined) {
      // session/page: read one message-aligned history page. The endpoint is
      // `namespace/method` (slash, not dot — dsh typert gateway's endpointOf
      // joins with `/`, see dsh-api-gateway/lib/index.js:990). `address.kind:
      // "session"` is the only branch this plugin addresses (no subagent
      // remoting). The parameter wire field is `request` (per typert.host.js:
      // 970-978), so business params go under args.request.
      //
      // throughSeq MUST be the session's last event seq (paginate uses
      // throughSeq+1 as the exclusive end index; -1 yields end=0 → empty
      // slice → "会话内容是空的"). We don't know the seq without reading, so
      // first call session/list to fetch projections.asOfSeq for this session
      // (typert.host.js:422 — projections.asOfSeq is the durable last seq).
      // Costs one extra session/list round-trip per history read; acceptable
      // for the mobile UI (list payload is session metadata, not messages).
      const listResult = (await this.apiCall("session/list", { _request: { cursor: "" } })) as
        | { items?: Array<{ sessionId?: string; projections?: { asOfSeq?: number } }> }
        | undefined
      const items = listResult?.items ?? []
      const item = items.find((it) => it?.sessionId === frame.sessionId)
      const asOfSeq = item?.projections?.asOfSeq
      if (typeof asOfSeq !== "number") {
        // Brand-new session (just created via conversation-create, no events
        // yet): projections.asOfSeq may be undefined or not yet computed.
        // Rather than 502-block the chat pane, return an empty page so the
        // mobile UI shows "暂无消息" and the user can type the first message.
        // Also covers the race where session/list was read before the new
        // session appeared (create → attachSession → list may lag by one tick).
        this.respondData(frame, { records: [], hasMore: false })
        return
      }
      const data = await this.apiCall("session/page", {
        request: {
          address: { kind: "session", sessionId: frame.sessionId },
          throughSeq: asOfSeq,
          // dsh's DEFAULT_MAX_MESSAGES is 50 (dsh-api-session-controller/lib/
          // index.js:1328). 50 messages + their tool results fit comfortably
          // under MAX_PAYLOAD_CHARS (4 MiB). Larger pages risk payload-too-
          // large; paginate via beforeSeq for older history instead.
          maxMessages: 50,
        },
      })
      this.respondData(frame, data)
      return
    }
    // session/list: returns { items: [...] }. The parameter wire field is
    // `_request` (typert.host.js:903-904 — list takes a reserved empty
    // request), so the cursor goes under args._request, not at args top
    // level. cursor is optional; "" is a valid empty-string cursor that
    // starts at the newest page (schema is z.string().optional()).
    const data = await this.apiCall("session/list", { _request: { cursor: "" } })
    this.respondData(frame, data)
  }

  private async conversationCreate(frame: DataReqFrame): Promise<void> {
    const workspaceId = frame.workspaceId
    if (workspaceId === undefined || workspaceId === "") {
      this.respond(frame, false, undefined, "workspaceId required")
      return
    }
    // session/create: binds a new session to a workspace. The parameter wire
    // field is `request` (dsh-api-session-controller/lib/typert.host.js:824-834
    // — single parameter named/wired `request`), so the business params go
    // under args.request. SessionCreateRequest = { workspaceId?, cwd?,
    // sessionId?, agentPreset? }; the host rejects workspaceId+cwd together
    // (index.js:572), so we only ever send workspaceId (matching
    // dsh-client-ui-workspace's connectWorkspace → sessions.create). The
    // workspaceId IS the Workspace.id the relay already exposes via the
    // workspace-list frame (data-plane.ts workspaceList); the host resolves it
    // to workspace.path via workspaceRegistry.get and attaches the new session
    // to that workspace (attachSession), so it immediately appears in the
    // workspace's sessionIds list.
    // Returns { sessionId, agentPreset? } — no projections. The mobile UI
    // opens the new session's chat directly from the returned sessionId; if
    // it needs projections.asOfSeq for a page read, it does a follow-up
    // session/list lookup (the existing conversation+sessionId branch).
    const data = await this.apiCall("session/create", {
      request: { workspaceId },
    })
    this.respondData(frame, data)
  }

  private async conversationPending(frame: DataReqFrame): Promise<void> {
    // Return all pending user-questions/approval interactions from the
    // $events stream. The mobile UI polls this alongside session/page to
    // detect when DSH has paused asking the user a question — without this,
    // the task hangs forever (the question is invisible in the session log).
    // We don't filter by sessionId because the $events waterfall frames don't
    // carry a sessionId field — they carry `agentId` and the request payload
    // ({questions:[...]} for user-questions/request, {toolName,callId?,reason?}
    // for approval/request). In practice there's usually one active session on
    // the phone, so showing all pending interactions is the right UX.
    const ec = this.eventsClient
    if (ec === undefined) {
      this.respond(frame, false, undefined, "events stream client not started")
      return
    }
    const pending = ec.getPending()
    // Project to a wire-safe shape: {eventId, event, request}[].
    const data = pending.map((p) => ({
      eventId: p.eventId,
      kind: p.event === "approval/request" ? "approval" : "question",
      request: p.request,
    }))
    this.respondData(frame, data)
  }

  private async conversationRespond(frame: DataReqFrame): Promise<void> {
    const eventId = frame.eventId
    const content = frame.content
    if (eventId === undefined || content === undefined) {
      this.respond(frame, false, undefined, "eventId and content required")
      return
    }
    const ec = this.eventsClient
    if (ec === undefined) {
      this.respond(frame, false, undefined, "events stream client not started")
      return
    }
    const clientId = ec.getClientId()
    if (clientId === undefined) {
      this.respond(frame, false, undefined, "$events stream not connected (no clientId)")
      return
    }
    // Parse the answer value from the content field (JSON-stringified by the
    // relay). For questions: {answers:[{id,selected,custom?}]}; for approvals:
    // the outcome string "allowed-once" | "rejected".
    let answerValue: unknown
    try {
      answerValue = JSON.parse(content)
    } catch {
      this.respond(frame, false, undefined, "invalid response JSON")
      return
    }
    // POST /api/$events/result with the typert envelope. The gateway's
    // dispatchRpc special-cases "$events/result": parseRemoteEventResultPayload
    // extracts the RemoteEventResult {clientId, eventId, outcome} from args,
    // then receiveRemoteEventResult looks up the pending interaction by
    // eventId and resolves it. The clientId MUST match an active $events
    // stream (index.js:569-570 throws "identifies no active event stream" if
    // not), which is why the RemoteEventsClient maintains a persistent WS.
    try {
      await this.apiCall("$events/result", {
        clientId,
        eventId,
        outcome: { kind: "result", value: answerValue },
      })
    } catch (error) {
      this.respond(frame, false, undefined, errorMessage(error))
      return
    }
    // Optimistically remove from pending (the emit frame will also arrive,
    // but we don't want the mobile UI to show a stale pending card while
    // waiting for the emit).
    ec.removePending(eventId)
    this.respond(frame, true)
  }

  private async sendMessage(frame: DataReqFrame): Promise<void> {
    const sessionId = frame.sessionId
    const content = frame.content
    if (sessionId === undefined || content === undefined) {
      this.respond(frame, false, undefined, "sessionId and content required")
      return
    }
    // session/prompt: requestId is a REQUIRED wire field (per the typert
    // schema in dsh-api-session-controller/lib/typert.host.js:573-590). It is
    // the host-side idempotency/correlation key for this prompt; generate a
    // short random id (same shape as apiCall's rpcId, scoped to prompts).
    // The parameter wire field is `request` (typert.host.js:996-997), so the
    // business params go under args.request.
    const data = await this.apiCall("session/prompt", {
      request: {
        requestId: Math.random().toString(36).slice(2, 12),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: content }],
      },
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
    // No path → resolve "." against WORKSPACE_CWD (the project workspace, not
    // dsh's process.cwd() which is the user home). resolve is async (dsh-fs-local
    // LocalFileSystem.resolve returns Promise<FsTarget>); await before listDir,
    // else target is a Promise and listDir reads target.displayPath → undefined
    // → "cannot list undefined".
    const target = await fs.resolve(frame.path ?? ".", { cwd: WORKSPACE_CWD })
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
    const target = await fs.resolve(frame.path, { cwd: WORKSPACE_CWD })
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
    const target = await fs.resolve(frame.path, { cwd: WORKSPACE_CWD })
    await fs.writeText(target, frame.content)
    this.respond(frame, true)
  }

  private async workspaceList(frame: DataReqFrame): Promise<void> {
    const reg = this.workspaceRegistry
    if (reg === undefined) {
      this.respond(frame, false, undefined, "workspaceRegistry service unavailable")
      return
    }
    // ctx.workspaceRegistry.list() is synchronous and returns ordered entities;
    // project each to a plain JSON-safe object (the entity's sessionIds getter
    // is already filtered by the registry's startup canonical-cwd index, so
    // only sessions whose header.cwd still resolves to this workspace's path
    // are listed — no orphan/stale ids leak to the mobile UI).
    const entities = reg.list()
    const data = entities.map((w) => ({
      id: w.id,
      path: w.path,
      title: w.title,
      sessionIds: [...w.sessionIds],
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    }))
    this.respondData(frame, data)
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
