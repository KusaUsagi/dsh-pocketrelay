/**
 * dsh-pocketrelay — 手机远程连接插件（主机端）。
 *
 * 自托管中继的桌面端 agent（契约见 docs/PROTOCOL.md）：持有稳定的 deviceId
 * 注册到 relay，把手机浏览器经由 relay 转发的 HTTP 反向代理帧与 WebSocket
 * 透传帧桥接到本地 dsh web server（127.0.0.1:<webServer.port>），并注入隧道
 * 专属的移动适配层。运行时配置（设置 → 手机连接）持久化于
 * `<dshHome>/storages/dsh-pocketrelay/config.json`，覆盖 cordis.patch.yml 默认值。
 */
import { hostname } from "node:os"
import { join } from "node:path"
import type { Context } from "@deepseek-ai/cordis"
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths"
import { assertNever, T } from "@dsh-pocketrelay/protocol"
import { RelayAgent } from "./agent.js"
import { loadSettings, type RemoteSettings, RemoteSettingsSchema, saveSettings } from "./config.js"
import { HttpPlane } from "./http-plane.js"
import { loadIdentity } from "./identity.js"
import type { DataPlaneFrame } from "./parse.js"
import { registerRemoteRoutes } from "./routes.js"
import { createUpstreamCookieAuth, resolveBrowserAuthorizer } from "./upstream-auth.js"
import { WsPlane } from "./ws-plane.js"

/** Cordis plugin name. */
export const name = "dsh-pocketrelay"

/** Schemastery configuration (defaults mirror cordis.patch.yml). */
export const Config = RemoteSettingsSchema

/** Services the fiber waits for before apply. */
export const inject = ["webServer"]

export async function apply(ctx: Context, config: RemoteSettings): Promise<void> {
  const log = ctx.logger(name)
  const dir = join(resolveDshHome(), "storages", "dsh-pocketrelay")

  const identity = await loadIdentity(dir)
  const settings = await loadSettings(dir, {
    relayUrl: config.relayUrl,
    hostToken: config.hostToken,
    autoConnect: config.autoConnect,
  })

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      const origin = (): string => `http://127.0.0.1:${webCtx.webServer.port}`
      const logWarn = (message: string): void => log.warn(message)

      // Modern dsh guards its web API behind an authority-bound browser cookie
      // (see upstream-auth.ts). Bridge it so the tunneled requests authenticate
      // as the loopback client they are; on older harnesses the authorizer is
      // absent and traffic stays a pass-through.
      const auth = createUpstreamCookieAuth(origin, () =>
        resolveBrowserAuthorizer(webCtx.get("connection")),
      )

      const agent = new RelayAgent({
        deviceId: identity.deviceId,
        relayUrl: settings.relayUrl,
        hostToken: settings.hostToken,
        hostName: hostname(),
        log: (message) => log.info(message),
      })

      const httpPlane = new HttpPlane({
        origin,
        log: logWarn,
        send: (frame) => agent.sendFrame(frame),
        auth,
      })
      const wsPlane = new WsPlane({ origin, log: logWarn, send: (frame) => agent.sendFrame(frame) })

      // Route data-plane frames to the matching plane.
      agent.setFrameSink((frame: DataPlaneFrame) => {
        switch (frame.t) {
          case T.HTTP_REQ:
          case T.HTTP_BODY:
          case T.HTTP_BODY_END:
          case T.HTTP_ABORT:
            httpPlane.handle(frame)
            return
          case T.WS_OPEN:
          case T.WS_FRAME:
          case T.WS_CLOSE:
            wsPlane.handle(frame)
            return
          default:
            assertNever(frame)
        }
      })

      const disposeRoutes = registerRemoteRoutes(webCtx.webServer, {
        agent,
        settings,
        save: (next) => saveSettings(dir, next),
      })

      if (settings.autoConnect && settings.relayUrl.trim() !== "") agent.start()

      return () => {
        disposeRoutes()
        agent.dispose()
      }
    }, "dsh-pocketrelay: host agent")
  })
}
