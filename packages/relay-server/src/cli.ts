import { DEFAULT_BIND, DEFAULT_PORT, defaultDataDir } from "./const.js"
import { createRelay } from "./index.js"

interface CliArgs {
  hostToken?: string
  port?: number
  bind?: string
  dataDir?: string
  certPath?: string
  keyPath?: string
  adminPassword?: string
}

function parseArgs(argv: string[]): CliArgs {
  const opts: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith("--")) continue
    const key = arg.slice(2)
    const value = argv[i + 1]
    i += 1
    if (value === undefined) continue
    switch (key) {
      case "hostToken":
        opts.hostToken = value
        break
      case "port":
        opts.port = Number(value)
        break
      case "bind":
        opts.bind = value
        break
      case "dataDir":
        opts.dataDir = value
        break
      case "cert":
        opts.certPath = value
        break
      case "key":
        opts.keyPath = value
        break
      case "adminPassword":
        opts.adminPassword = value
        break
      default:
        break
    }
  }
  return opts
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const hostToken = args.hostToken ?? process.env["DSH_POCKETRELAY_HOST_TOKEN"]
  if (hostToken === undefined || hostToken === "") {
    console.error("required: --hostToken or env DSH_POCKETRELAY_HOST_TOKEN")
    process.exit(1)
  }
  const relay = await createRelay({
    hostToken,
    port: args.port ?? DEFAULT_PORT,
    bind: args.bind ?? DEFAULT_BIND,
    dataDir: args.dataDir ?? defaultDataDir(),
    ...(args.certPath !== undefined ? { certPath: args.certPath } : {}),
    ...(args.keyPath !== undefined ? { keyPath: args.keyPath } : {}),
    ...(args.adminPassword !== undefined ? { adminPassword: args.adminPassword } : {}),
    log: (message) => console.log(`[relay] ${message}`),
  })
  console.log(`dsh-pocketrelay relay listening on https://${relay.url}`)
  if (args.adminPassword === undefined)
    console.log(`admin password (generated): ${relay.adminPassword}`)

  let closing = false
  const stop = (): void => {
    if (closing) return
    closing = true
    void relay
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
