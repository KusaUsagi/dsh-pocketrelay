/**
 * dsh-pocketrelay — 手机远程连接插件（主机端）。
 *
 * 自托管中继的桌面端 agent（契约见 docs/PROTOCOL.md）：持有稳定的 deviceId
 * 注册到 relay，把手机经 relay 发来的 data-req 结构化数据帧用注入的
 * sessions/host/fs 能力应答，回送 data-res。运行时配置（设置 → 手机连接）
 * 持久化于 `<dshHome>/storages/dsh-pocketrelay/config.json`，覆盖
 * cordis.patch.yml 默认值。SDK 服务形态未确认；缺失时数据面降级为
 * ok:false（见 data-plane.ts 的兜底守卫），控制面与设置 UI 不受影响。
 *
 * NOTE: apiProxy（包装 sessions/host）在 stock web profile 未注册，故直接
 * 访问底层 sessions/host/fs 服务（它们已注册）。每个服务独立 inject（避免
 * all-or-nothing 的 ["apiProxy","fs"] 组合），并辅以 ctx.get 探测即时可用性。
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
 * Services the plugin waits for before apply. Only `webServer` gates plugin load
 * (control-plane settings UI + routes). `sessions`/`host`/`fs` are requested
 * inside apply via ctx.inject (each independently, so one missing doesn't block
 * the others) + probed via ctx.get (immediate availability) — the data plane
 * degrades per-kind when a service is absent.
 */
export const inject = ["webServer"]

export async function apply(ctx: Context, config: RemoteSettings): Promise<void> {
  const log = ctx.logger(name)
  const dir = join(resolveDshHome(), "storages", "dsh-pocketrelay")
  console.warn(
    "[dsh-pocketrelay] apply started; waiting on webServer (plugin inject) + sessions/host/fs",
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

  // Probe immediate availability via ctx.get (the cordis bypass — no inject
  // needed; dsh-remote uses webCtx.get('connection') the same way). Direct
  // ctx.<name> reads THROW "cannot get property without inject", so use ctx.get.
  probeAndSet(ctx, dataPlane, "apply-top")

  // Per-service injects (each fires independently when its service materializes
  // — avoids the all-or-nothing ["apiProxy","fs"] group that never resolved
  // because apiProxy isn't registered in the web profile).
  ctx.inject(["sessions"], (caps) => {
    console.warn("[dsh-pocketrelay] ctx.inject(['sessions']) resolved")
    dataPlane.setSessions(caps.get("sessions"))
  })
  ctx.inject(["host"], (caps) => {
    console.warn("[dsh-pocketrelay] ctx.inject(['host']) resolved")
    dataPlane.setHost(caps.get("host"))
  })
  ctx.inject(["fs"], (caps) => {
    console.warn("[dsh-pocketrelay] ctx.inject(['fs']) resolved")
    dataPlane.setFs(caps.get("fs"))
  })

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      // probe again after webServer materializes (services may appear by then)
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
 * Probe which DSH services are registered in this profile via `ctx.get(name)`
 * (the cordis bypass lookup — usable without declaring inject). Direct
 * `ctx.<name>` reads throw "cannot get property without inject", so we use
 * ctx.get exclusively. For each object returned, call the matching setter on the
 * data plane; log the typeof + Object.keys of each so the exact shapes are
 * visible (the data plane's probing interfaces may need adjustment based on the
 * real method names).
 */
function probeAndSet(ctx: Context, dataPlane: DataPlane, label: string): void {
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
      if (n === "sessions") dataPlane.setSessions(v)
      else if (n === "host") dataPlane.setHost(v)
      else if (n === "fs") dataPlane.setFs(v)
    } else {
      desc = typeof v
    }
    parts.push(`${n}=${desc}`)
  }
  console.warn(`[dsh-pocketrelay] probe(${label}): ${parts.join(" ")}`)
}
