/**
 * dsh-pocketrelay — device identity.
 *
 * A stable 32-hex deviceId persisted under the plugin's storage dir. The relay
 * registers hosts by this id; losing it strands every paired phone, so a fresh
 * id is only written after the read confirmed nothing usable exists.
 */
import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const IDENTITY_FILE = "identity.json"
const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/

export interface Identity {
  deviceId: string
}

/** Load the persisted identity, or generate and persist a fresh one. */
export async function loadIdentity(dir: string): Promise<Identity> {
  const file = join(dir, IDENTITY_FILE)
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    if (typeof parsed === "object" && parsed !== null) {
      const deviceId = (parsed as Record<string, unknown>)["deviceId"]
      if (typeof deviceId === "string" && DEVICE_ID_PATTERN.test(deviceId)) return { deviceId }
    }
  } catch {
    // absent or unreadable — fall through to generate below
  }

  const identity: Identity = { deviceId: randomBytes(16).toString("hex") }
  await mkdir(dir, { recursive: true })
  await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, "utf8")
  return identity
}
