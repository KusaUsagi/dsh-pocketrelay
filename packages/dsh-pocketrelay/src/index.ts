/**
 * dsh-pocketrelay — 手机远程连接插件（主机端）。
 *
 * 自托管中继的桌面端 agent（契约见 docs/PROTOCOL.md）：持有稳定的 deviceId
 * 注册到 relay，把手机经 relay 发来的 data-req 结构化数据帧用注入的
 * apiProxy/fs 能力应答，回送 data-res。运行时配置（设置 → 手机连接）
 * 持久化于 `<dshHome>/storages/dsh-pocketrelay/config.json`，覆盖
 * cordis.patch.yml 默认值。apiProxy/fs 形态未确认；缺失时数据面降级为
 * ok:false（见 data-plane.ts 的兜底守卫），控制面与设置 UI 不受影响。
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

/**
 * Services the plugin waits for before apply. `webServer` gates plugin load
 * (control-plane settings UI + routes); `apiProxy`/`fs` are requested inside
 * apply via ctx.inject so the plugin survives their absence — the data plane
 * degrades to ok:false while the control plane + settings UI keep working.
 */
export const inject = ["webServer"]

export async function apply(ctx: Context, config: RemoteSettings): Promise<void> {
  const log = ctx.logger(name)
  const dir = join(resolveDshHome(), "storages", "dsh-pocketrelay")
  console.warn(
    "[dsh-pocketrelay] apply started; waiting on webServer (plugin inject) + ctx.inject(['apiProxy','fs'])",
  )

  const identity = await loadIdentity(dir)
  const settings = await loadSettings(dir, {
    relayUrl: config.relayUrl,
    hostToken: config.hostToken,
    autoConnect: config.autoConnect,
  })

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
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

      // Route inbound data-req frames (relay→host) to the data plane; the
      // plane answers via agent.sendFrame with a correlated data-res.
      agent.setFrameSink((frame) => dataPlane.handle(frame))

      // apiProxy/fs are UNCONFIRMED SDK capabilities; request them lazily so
      // the plugin survives their absence (caps stay undefined → every
      // data-req degrades to ok:false inside data-plane.ts).
      ctx.inject(["apiProxy", "fs"], (caps) => {
        console.warn("[dsh-pocketrelay] ctx.inject(['apiProxy','fs']) resolved — calling setCaps")
        dataPlane.setCaps(caps.get("apiProxy"), caps.get("fs"))
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
