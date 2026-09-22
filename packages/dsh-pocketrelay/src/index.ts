/**
 * dsh-pocketrelay — 手机远程连接插件（主机端）。
 *
 * 自托管中继的桌面端 agent（契约见 docs/PROTOCOL.md）：持有稳定的 deviceId
 * 注册到 relay，把手机经 relay 发来的 data-req 结构化数据帧应答，回送
 * data-res。运行时配置（设置 → 手机连接）持久化于
 * `<dshHome>/storages/dsh-pocketrelay/config.json`，覆盖 cordis.patch.yml 默认值。
 *
 * 数据面（data-plane.ts）：
 *  - 会话操作（list/history/prompt）：fetch 本地 dsh web 的 HTTP API
 *    （POST http://127.0.0.1:<webServer.port>/api/session.*）。dsh web 的 /api/*
 *    handler（connection 插件）在其作用域内有 ctx.apiProxy，loopback Host 通过
 *    信任边界，故本插件无需在自己作用域注入 apiProxy 即可调用高层会话网关。
 *    但 browserAuth.isAuthenticated 会拒绝无 cookie 的请求（0.2.8 的 401），
 *    故本插件从 ctx.get("connection").browserAuth.launchToken 取进程级启动令牌，
 *    GET /?token=<token> 铸造签名 cookie（303 Set-Cookie），之后 /api POST 带
 *    cookie 头通过 browserAuth。见 data-plane.ts 的 ensureCookie() + apiCall()。
 *  - 文件操作（list/read/write）：直接调用 ctx.fs（resolve/listDir/readText/
 *    writeText，method-call 保留 this）。
 *
 * apiProxy 在本插件作用域不可见（0.1.5-rc.2 的 web-app bundle 未注册它，
 * 且 @deepseek-ai/dsh-host-apiproxy 包未安装，故不能经 cordis.patch.yml 插入），
 * 故走 HTTP API 路径。fs 由 base bundle 提供，ctx.get 可得。
 */
import { hostname } from "node:os"
import { join } from "node:path"
import type { Context } from "@deepseek-ai/cordis"
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths"
import { RelayAgent } from "./agent.js"
import { loadSettings, type RemoteSettings, RemoteSettingsSchema, saveSettings } from "./config.js"
import { DataPlane } from "./data-plane.js"
import { loadIdentity } from "./identity.js"
import { registerRemoteRoutes } from "./routes.js"

/** Cordis plugin name. */
export const name = "dsh-pocketrelay"

/** Schemastery configuration (defaults mirror cordis.patch.yml). */
export const Config = RemoteSettingsSchema

/** Services the plugin waits for before apply. `webServer` gates plugin load
 *  (control-plane settings UI + routes + the HTTP API origin for conversations).
 *  `fs` is requested inside apply via ctx.inject + probed via ctx.get. */
export const inject = ["webServer"]

export async function apply(ctx: Context, config: RemoteSettings): Promise<void> {
  const log = ctx.logger(name)
  const dir = join(resolveDshHome(), "storages", "dsh-pocketrelay")
  console.warn("[dsh-pocketrelay] apply started; waiting on webServer + fs")

  const identity = await loadIdentity(dir)
  const settings = await loadSettings(dir, {
    relayUrl: config.relayUrl,
    hostToken: config.hostToken,
    autoConnect: config.autoConnect,
  })

  const agent = new RelayAgent({
    deviceId: identity.deviceId,
    relayUrl: settings.relayUrl,
    hostToken: settings.hostToken,
    hostName: hostname(),
    log: (message) => log.info(message),
  })

  const dataPlane = new DataPlane({
    log: (message) => log.warn(message),
    send: (frame) => agent.sendFrame(frame),
  })
  agent.setFrameSink((frame) => dataPlane.handle(frame))

  // Probe immediate fs availability via ctx.get (the cordis bypass). Direct
  // ctx.<name> reads throw "cannot get without inject", so ctx.get.
  probeFs(ctx, dataPlane, "apply-top")

  // Canonical fs inject (fires when fs materializes; fs is in the base bundle).
  ctx.inject(["fs"], (caps) => {
    console.warn("[dsh-pocketrelay] ctx.inject(['fs']) resolved")
    dataPlane.setFs(caps.get("fs"))
  })

  // Workspace registry (dsh-workspace's WorkspaceRegistry Service). Registered
  // by the base bundle; exposes the durable workspace order + each workspace's
  // path/title/sessionIds. Used by the `workspace-list` data frame so the
  // mobile UI can render workspace → session grouping instead of a flat list.
  ctx.inject(["workspaceRegistry"], (wCtx) => {
    const reg = (wCtx as Context & { workspaceRegistry?: unknown }).workspaceRegistry
    console.warn(
      `[dsh-pocketrelay] ctx.inject(['workspaceRegistry']) resolved: ${typeof reg === "object" && reg !== null ? "OK" : typeof reg}`,
    )
    dataPlane.setWorkspaceRegistry(reg)
  })

  // The dsh-client-connection service (HostConnectionService) is registered in a
  // SIBLING plugin's scope, so ctx.get("connection") returns undefined (the
  // bypass only sees ancestor-scope services; that was the 0.2.9 failure). Use
  // ctx.inject(["connection"], cb) — same pattern dsh-web-app (lib/index.js:194)
  // and dsh-api-gateway (lib/index.js:454) use to reach the sibling service.
  // Inside the cb, connCtx.connection is the HostConnectionService; its public
  // browserAuth.launchToken mints the browser-session cookie that authorizes
  // /api POSTs (browserAuth.isAuthenticated rejects cookieless 0.2.8 requests
  // with 401; the token itself does NOT pass /api auth).
  ctx.inject(["connection"], (connCtx) => {
    const conn = (connCtx as Context & { connection?: unknown }).connection
    const auth =
      typeof conn === "object" && conn !== null
        ? (conn as Record<string, unknown>)["browserAuth"]
        : undefined
    const token =
      typeof auth === "object" && auth !== null
        ? (auth as Record<string, unknown>)["launchToken"]
        : undefined
    dataPlane.setLaunchToken(token)
    console.warn(
      `[dsh-pocketrelay] ctx.inject(['connection']) resolved: browserAuth=${typeof auth} token=${typeof token === "string" ? `len=${token.length}` : typeof token}`,
    )
  })

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      // The dsh web origin for the conversation HTTP API (loopback).
      dataPlane.setOrigin(`http://127.0.0.1:${webCtx.webServer.port}`)
      probeFs(webCtx, dataPlane, "webServer-effect")
      const disposeRoutes = registerRemoteRoutes(webCtx.webServer, {
        agent,
        settings,
        save: (next) => saveSettings(dir, next),
      })
      if (settings.autoConnect && settings.relayUrl.trim() !== "") agent.start()
      return () => {
        disposeRoutes()
        dataPlane.dispose()
        agent.dispose()
      }
    }, "dsh-pocketrelay: host agent")
  })
}

/** Probe which DSH services are registered via ctx.get (bypass — no inject
 *  needed). Sets fs on the data plane if available. Logs each service's typeof
 *  + keys so the exact shapes are visible (apiProxy/sessions/host are logged
 *  for diagnosis even though conversations now go via the HTTP API). */
function probeFs(ctx: Context, dataPlane: DataPlane, label: string): void {
  const names = ["apiProxy", "sessions", "host", "fs"] as const
  const parts: string[] = []
  for (const n of names) {
    let v: unknown
    try {
      v = ctx.get(n)
    } catch {
      // ctx.get may throw for unregistered names on some DI containers
    }
    let desc: string
    if (typeof v === "object" && v !== null) {
      desc = `object{${Object.keys(v).slice(0, 12).join(",")}}`
      if (n === "fs") dataPlane.setFs(v)
    } else {
      desc = typeof v
    }
    parts.push(`${n}=${desc}`)
  }
  console.warn(`[dsh-pocketrelay] probe(${label}): ${parts.join(" ")}`)
}
