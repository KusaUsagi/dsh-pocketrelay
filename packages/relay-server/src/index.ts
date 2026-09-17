import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import {
  generateToken,
  hashAdminPassword,
  mintSessionCookie,
  sha256Hex,
  verifyAdminPassword,
} from "./auth.js"
import { loadOrCreateTls } from "./cert.js"
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_MS,
  DEFAULT_BIND,
  DEFAULT_PORT,
  defaultDataDir,
} from "./const.js"
import { HttpProxy } from "./http-proxy.js"
import {
  type AdminDeviceView,
  adminDashboardHtml,
  adminLoginPage,
  landingPage,
  pairPage,
} from "./pages.js"
import { SessionRegistry } from "./sessions.js"
import { RelayStore } from "./store.js"
import { WsBridge } from "./ws-bridge.js"

export interface RelayOptions {
  hostToken: string
  port?: number
  bind?: string
  dataDir?: string
  certPath?: string
  keyPath?: string
  adminPassword?: string
  log?: (msg: string) => void
}

export interface RelayHandle {
  readonly port: number
  readonly url: string
  readonly adminPassword: string
  close: () => Promise<void>
}

/**
 * 创建并启动 dsh-pocketrelay 中继。返回监听句柄。
 */
export async function createRelay(opts: RelayOptions): Promise<RelayHandle> {
  const log = opts.log ?? (() => {})
  const dataDir = opts.dataDir ?? defaultDataDir()
  const store = new RelayStore(dataDir)
  await store.load()
  const sessions = new SessionRegistry()
  const adminPassword = opts.adminPassword ?? generateToken().slice(0, 16)
  const adminHash = hashAdminPassword(adminPassword)
  if (opts.adminPassword === undefined) log(`admin password generated (set --adminPassword to pin)`)

  let proxy: HttpProxy | undefined
  const wsBridge = new WsBridge({
    store,
    hostToken: opts.hostToken,
    log,
    onHostFrame: (deviceId, frame) => proxy?.dispatch(deviceId, frame),
    onHostOffline: (deviceId) => sessions.revokePhoneByDevice(deviceId),
  })
  proxy = new HttpProxy({
    store,
    sessions,
    sendToHost: (id, frame) => wsBridge.sendToHost(id, frame),
    log,
  })

  const tls = await loadOrCreateTls(dataDir, opts.certPath, opts.keyPath)
  const server: HttpsServer = createHttpsServer(
    { cert: tls.cert, key: tls.key },
    (req, res) => void handleRequest(req, res, store, sessions, wsBridge, proxy, adminHash),
  )

  server.on("upgrade", (req, socket, head) => {
    const parts = pathParts(req.url ?? "/")
    if (parts[0] === "ws") {
      wsBridge.handleUpgrade(req, socket, head)
      return
    }
    if (parts[0] === "d" && parts.length >= 2) {
      const deviceId = parts[1]
      if (deviceId === undefined) {
        socket.destroy()
        return
      }
      const rest = "/" + parts.slice(2).join("/")
      proxy?.handleEventsUpgrade(req, socket, head, deviceId, rest)
      return
    }
    socket.destroy()
  })

  const port = opts.port ?? DEFAULT_PORT
  const bind = opts.bind ?? DEFAULT_BIND
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject)
    server.listen(port, bind, () => resolve())
  })
  const addr = server.address() as AddressInfo

  return {
    port: addr.port,
    url: `${addr.address === "0.0.0.0" ? "0.0.0.0" : addr.address}:${addr.port}`,
    adminPassword,
    close: async () => {
      wsBridge.close()
      proxy?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// ----------------------------------------------------------------- routing

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: RelayStore,
  sessions: SessionRegistry,
  wsBridge: WsBridge,
  proxy: HttpProxy | undefined,
  adminHash: string,
): Promise<void> {
  const parts = pathParts(req.url ?? "/")
  if (parts.length === 0) return html(res, landingPage())
  switch (parts[0]) {
    case "pair":
      if (req.method === "GET") return html(res, pairPage())
      if (req.method === "POST") return handlePair(req, res, store, sessions, wsBridge)
      return methodNotAllowed(res)
    case "admin":
      return handleAdmin(req, res, parts, store, sessions, wsBridge, adminHash)
    case "manifest.webmanifest":
      res.setHeader("content-type", "application/manifest+json")
      res.end(MANIFEST)
      return
    case "d": {
      if (parts.length < 2) return notFound(res)
      if (proxy === undefined) return notFound(res)
      const deviceId = parts[1]
      if (deviceId === undefined) return notFound(res)
      return proxy.handleHttpRequest(req, res, deviceId, "/" + parts.slice(2).join("/"))
    }
    default:
      return notFound(res)
  }
}

async function handlePair(
  req: IncomingMessage,
  res: ServerResponse,
  store: RelayStore,
  sessions: SessionRegistry,
  wsBridge: WsBridge,
): Promise<void> {
  const body = await readJsonBody(req)
  const code = body?.["code"]
  if (typeof code !== "string" || code === "")
    return json(res, 400, { ok: false, error: "code required" })
  const pairing = store.getPairingByCodeSha(sha256Hex(code))
  if (pairing === null) return json(res, 404, { ok: false, error: "code invalid or expired" })
  const token = generateToken()
  await store.addToken(pairing.deviceId, sha256Hex(token))
  const sid = sessions.createPhone(pairing.deviceId, sha256Hex(token))
  await store.clearPairing(pairing.deviceId)
  wsBridge.notifyPeer(pairing.deviceId, true)
  res.setHeader("Set-Cookie", mintSessionCookie(sid))
  return json(res, 200, { ok: true, deviceId: pairing.deviceId })
}

async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  store: RelayStore,
  sessions: SessionRegistry,
  wsBridge: WsBridge,
  adminHash: string,
): Promise<void> {
  const sid = readCookie(req.headers.cookie, ADMIN_COOKIE)
  const authed = sid !== null && sessions.getAdmin(sid)
  if (parts.length === 1) {
    if (authed) {
      const views: AdminDeviceView[] = store.listDevices().map((d) => ({
        deviceId: d.deviceId,
        hostName: d.hostName,
        createdAt: d.createdAt,
        online: wsBridge.isHostOnline(d.deviceId),
      }))
      return html(res, adminDashboardHtml(views))
    }
    return html(res, adminLoginPage())
  }
  if (parts[1] === "login" && req.method === "POST") {
    const form = await readForm(req)
    const password = form.get("password")
    if (typeof password === "string" && verifyAdminPassword(password, adminHash)) {
      const adminSid = sessions.createAdmin()
      res.setHeader("Set-Cookie", cookieStr(ADMIN_COOKIE, adminSid, ADMIN_SESSION_TTL_MS))
      res.statusCode = 303
      res.setHeader("Location", "/admin")
      res.end()
      return
    }
    res.statusCode = 401
    return html(res, adminLoginPage())
  }
  if (parts[1] === "revoke" && req.method === "POST" && authed) {
    const form = await readForm(req)
    const deviceId = form.get("deviceId")
    if (typeof deviceId === "string" && deviceId !== "") await store.revokeDevice(deviceId)
    res.statusCode = 303
    res.setHeader("Location", "/admin")
    res.end()
    return
  }
  return notFound(res)
}

// ----------------------------------------------------------------- helpers

function pathParts(url: string): string[] {
  const pathname = new URL(url, "http://relay").pathname
  return pathname.split("/").filter((p) => p !== "")
}

function html(res: ServerResponse, body: string): void {
  res.setHeader("content-type", "text/html; charset=utf-8")
  res.end(body)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404
  res.end("not found")
}

function methodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405
  res.end("method not allowed")
}

function readCookie(cookie: string | undefined, name: string): string | null {
  if (cookie === undefined) return null
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

function cookieStr(name: string, value: string, ttlMs: number): string {
  const maxAge = Math.floor(ttlMs / 1000)
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readRaw(req)
  try {
    const value = JSON.parse(raw.toString())
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function readForm(req: IncomingMessage): Promise<Map<string, string>> {
  const raw = await readRaw(req)
  const params = new URLSearchParams(raw.toString())
  const out = new Map<string, string>()
  for (const [key, value] of params) out.set(key, value)
  return out
}

const MANIFEST = JSON.stringify({
  name: "dsh-pocketrelay",
  short_name: "dsh-relay",
  start_url: "/pair",
  display: "standalone",
  background_color: "#111111",
  theme_color: "#111111",
})
