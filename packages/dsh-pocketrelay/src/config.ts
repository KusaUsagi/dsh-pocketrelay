/**
 * dsh-pocketrelay — runtime settings.
 *
 * The cordis patch supplies defaults (relayUrl/hostToken/autoConnect); the
 * settings page writes through to `<storageDir>/config.json`, which overrides
 * the defaults. Writes are atomic (tmp + rename) so a crash never truncates
 * the file.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import z from "@deepseek-ai/schemastery"

export interface RemoteSettings {
  relayUrl: string
  hostToken: string
  autoConnect: boolean
}

/** Schemastery schema mirrored by cordis.patch.yml. */
export const RemoteSettingsSchema = z.object({
  relayUrl: z.string().default(""),
  hostToken: z.string().default(""),
  autoConnect: z.boolean().default(true),
})

const CONFIG_FILE = "config.json"

/** Load persisted settings, falling back to the patch-provided defaults. */
export async function loadSettings(dir: string, defaults: RemoteSettings): Promise<RemoteSettings> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(dir, CONFIG_FILE), "utf8"))
  } catch {
    return defaults
  }
  if (typeof parsed !== "object" || parsed === null) return defaults
  const record = parsed as Record<string, unknown>
  return {
    relayUrl: typeof record["relayUrl"] === "string" ? record["relayUrl"] : defaults.relayUrl,
    hostToken: typeof record["hostToken"] === "string" ? record["hostToken"] : defaults.hostToken,
    autoConnect:
      typeof record["autoConnect"] === "boolean" ? record["autoConnect"] : defaults.autoConnect,
  }
}

/** Persist settings atomically (.tmp then rename). */
export async function saveSettings(dir: string, settings: RemoteSettings): Promise<void> {
  await mkdir(dir, { recursive: true })
  const target = join(dir, CONFIG_FILE)
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
  await rename(tmp, target)
}
