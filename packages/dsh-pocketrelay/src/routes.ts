/**
 * dsh-pocketrelay — HTTP surface mounted on the dsh web server.
 *
 * Exposes live tunnel status and the relay settings to the browser settings
 * page. No auth is added here: the web server already binds loopback, so the
 * same trust boundary as every other dsh plugin route applies.
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import type { WebServer } from "@deepseek-ai/dsh-host-webserver"
import type { RelayAgent } from "./agent.js"
import type { RemoteSettings } from "./config.js"

export interface RouteContext {
  agent: RelayAgent
  settings: RemoteSettings
  save: (next: RemoteSettings) => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > 64 * 1024) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

/** Narrow a config POST body into the overridable settings keys, or `null`. */
function readConfigInput(body: unknown): Partial<RemoteSettings> | null {
  if (typeof body !== "object" || body === null) return null
  const record = body as Record<string, unknown>
  const value = record["value"]
  if (typeof value !== "object" || value === null) return null
  const input = value as Record<string, unknown>
  const patch: Partial<RemoteSettings> = {}
  if (typeof input["relayUrl"] === "string") patch.relayUrl = input["relayUrl"]
  if (typeof input["hostToken"] === "string") patch.hostToken = input["hostToken"]
  if (typeof input["autoConnect"] === "boolean") patch.autoConnect = input["autoConnect"]
  return patch
}

function register(
  server: WebServer,
  ctx: RouteContext,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<void>,
): () => void {
  return server.register({
    kind: "exact",
    path,
    handler: (req, res) => {
      void handler(req, res, ctx).catch((error: Error) => {
        sendJson(res, 500, { ok: false, error: error.message })
      })
    },
  })
}

export function registerRemoteRoutes(server: WebServer, ctx: RouteContext): () => void {
  const disposers = [
    register(server, ctx, "/_dsh/pocketrelay/status", async (_req, res, site) => {
      sendJson(res, 200, { ok: true, settings: site.settings, status: site.agent.getStatus() })
    }),

    register(server, ctx, "/_dsh/pocketrelay/pair-code", async (_req, res, site) => {
      const pair = await site.agent.refreshPair()
      sendJson(res, 200, { ok: pair !== null, status: site.agent.getStatus() })
    }),

    register(server, ctx, "/_dsh/pocketrelay/config", async (req, res, site) => {
      if (req.method !== "POST") {
        sendJson(res, 200, { ok: true, settings: site.settings, status: site.agent.getStatus() })
        return
      }
      const body = await readJsonBody(req)
      const patch = readConfigInput(body) ?? {}
      const next: RemoteSettings = {
        relayUrl: patch.relayUrl ?? site.settings.relayUrl,
        hostToken: patch.hostToken ?? site.settings.hostToken,
        autoConnect: patch.autoConnect ?? site.settings.autoConnect,
      }
      if (next.relayUrl.trim() === "" && next.autoConnect) {
        sendJson(res, 400, { ok: false, error: "relay URL 不能为空" })
        return
      }
      site.settings = next
      await site.save(next)
      site.agent.applySettings(next.relayUrl, next.hostToken, next.autoConnect)
      sendJson(res, 200, { ok: true, settings: next, status: site.agent.getStatus() })
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
