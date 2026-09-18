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

  // DIAGNOSTIC + direct-set: dsh may expose apiProxy/fs as direct ctx properties
  // (not injectable services). Probe + setCaps immediately if either path yields
  // objects — covers both the direct-property case and the service-but-inject-
  // not-firing case. Probed again inside the webServer effect (caps may
  // materialize after webServer comes up).
  probeAndSet(ctx, dataPlane, "apply-top")

  // TOP-LEVEL inject (was nested in webCtx.effect — cordis may not fire injects
  // registered inside an effect callback; moved to top level so the dependency
  // registers at context activation, same as the working webServer inject).
  ctx.inject(["apiProxy", "fs"], (caps) => {
    console.warn("[dsh-pocketrelay] ctx.inject(['apiProxy','fs']) resolved — calling setCaps")
    dataPlane.setCaps(caps.get("apiProxy"), caps.get("fs"))
  })

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      probeAndSet(webCtx, dataPlane, "webServer-effect")
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

/**
 * Probe how dsh exposes apiProxy/fs — direct ctx property (`ctx.apiProxy`) vs
 * injectable service (`ctx.get("apiProxy")`) — and call setCaps immediately if
 * either path yields both caps as objects. Logs the probe result for diagnosis.
 */
function probeAndSet(ctx: Context, dataPlane: DataPlane, label: string): void {
  const apProp = ctx.apiProxy
  const fpProp = ctx.fs
  let gAp: unknown
  let gFp: unknown
  try {
    gAp = ctx.get("apiProxy")
  } catch {
    // ctx.get may throw for unregistered names on some DI containers
  }
  try {
    gFp = ctx.get("fs")
  } catch {
    // ignore
  }
  console.warn(
    `[dsh-pocketrelay] probe(${label}): ctx.apiProxy=${typeof apProp} ctx.fs=${typeof fpProp} get('apiProxy')=${gAp === undefined ? "undefined" : typeof gAp} get('fs')=${gFp === undefined ? "undefined" : typeof gFp}`,
  )
  const capAp =
    typeof apProp === "object" && apProp !== null
      ? apProp
      : typeof gAp === "object" && gAp !== null
        ? gAp
        : undefined
  const capFp =
    typeof fpProp === "object" && fpProp !== null
      ? fpProp
      : typeof gFp === "object" && gFp !== null
        ? gFp
        : undefined
  if (capAp !== undefined && capFp !== undefined) {
    console.warn(`[dsh-pocketrelay] probe(${label}): caps available — calling setCaps`)
    dataPlane.setCaps(capAp, capFp)
  }
}
