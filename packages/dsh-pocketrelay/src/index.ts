/**
 * dsh-pocketrelay — 手机远程连接插件（主机端）。
 *
 * 自托管中继的桌面端 agent（契约见 docs/PROTOCOL.md）：持有稳定的 deviceId
 * 注册到 relay，把手机经 relay 发来的 data-req 结构化数据帧用注入的
 * apiProxy/fs 能力应答，回送 data-res。运行时配置（设置 → 手机连接）
 * 持久化于 `<dshHome>/storages/dsh-pocketrelay/config.json`，覆盖
 * cordis.patch.yml 默认值。SDK 服务形态未确认；缺失时数据面降级为
 * ok:false（见 data-plane.ts 的兜底守卫），控制面与设置 UI 不受影响。
 *
 * apiProxy 由本插件 cordis.patch.yml 插入的 api-gateway bundle 行加载
 * （@deepseek-ai/dsh-host-apiproxy；stock web-app bundle 应有但部分 dsh 版本
 * 缺失，故显式插入以确保 ctx.apiProxy 可用）。ctx.get 探测即时可用性，
 * ctx.inject(['apiProxy','fs']) 为 canonical 路径（两者都加载后触发）。
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
 * Services the plugin waits for before apply. `webServer` gates plugin load.
 * `apiProxy`/`fs` are requested inside apply via ctx.inject + probed via ctx.get
 * (immediate availability) — the data plane degrades per-kind when a cap is absent.
 */
export const inject = ["webServer"]

export async function apply(ctx: Context, config: RemoteSettings): Promise<void> {
  const log = ctx.logger(name)
  const dir = join(resolveDshHome(), "storages", "dsh-pocketrelay")
  console.warn("[dsh-pocketrelay] apply started; waiting on webServer + apiProxy/fs")

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

  // Probe immediate availability via ctx.get (the cordis bypass — no inject
  // needed). Direct ctx.<name> reads throw "cannot get without inject", so ctx.get.
  probeAndSet(ctx, dataPlane, "apply-top")

  // Canonical path: fires once both apiProxy + fs are available. apiProxy is
  // loaded by the api-gateway bundle row (inserted in cordis.patch.yml); fs by
  // the base bundle. If apiProxy fails to load (bundle row/pkg issue), this
  // never fires but probeAndSet still sets fs → file ops work, conv ops degrade.
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
 * Probe which DSH services are registered via `ctx.get(name)` (the cordis bypass
 * lookup — usable without declaring inject). Direct `ctx.<name>` reads throw
 * "cannot get property without inject", so we use ctx.get. If apiProxy + fs are
 * available, call setCaps immediately (covers the case where ctx.inject hasn't
 * fired yet but the services are already registered). Logs each typeof + keys so
 * the exact shapes are visible.
 */
function probeAndSet(ctx: Context, dataPlane: DataPlane, label: string): void {
  const names = ["apiProxy", "sessions", "host", "fs"] as const
  const parts: string[] = []
  let gAp: unknown
  let gFp: unknown
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
      if (n === "apiProxy") gAp = v
      else if (n === "fs") gFp = v
    } else {
      desc = typeof v
    }
    parts.push(`${n}=${desc}`)
  }
  console.warn(`[dsh-pocketrelay] probe(${label}): ${parts.join(" ")}`)
  if (gAp !== undefined || gFp !== undefined) {
    console.warn(
      `[dsh-pocketrelay] probe(${label}): setCaps apiProxy=${gAp !== undefined} fs=${gFp !== undefined}`,
    )
    dataPlane.setCaps(gAp, gFp)
  }
}
