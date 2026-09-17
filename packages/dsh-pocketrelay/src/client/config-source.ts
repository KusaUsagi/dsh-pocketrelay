/**
 * dsh-pocketrelay client config source: an HTTP-backed reactive store over
 * /_dsh/pocketrelay/status (+ config writes), so the settings page stays
 * identical to the host's snapshot.
 */
const STATUS_ROUTE = "/_dsh/pocketrelay/status"
const CONFIG_ROUTE = "/_dsh/pocketrelay/config"
const PAIR_CODE_ROUTE = "/_dsh/pocketrelay/pair-code"

export interface RemoteSettingsClient {
  relayUrl: string
  hostToken: string
  autoConnect: boolean
}

export interface RemoteStatusClient {
  state: "idle" | "connecting" | "online" | "error"
  deviceId: string
  relayUrl: string
  hostName: string
  pair: { code: string; expiresAt: number } | null
  peer: { online: boolean; ua?: string } | null
  lastError: string | null
  connectedAt: number | null
  retryInMs: number | null
}

export interface RemoteSnapshot {
  status: "loading" | "ready" | "error"
  settings: RemoteSettingsClient | undefined
  remote: RemoteStatusClient | undefined
}

export interface RemoteConfigSource {
  getSnapshot(): RemoteSnapshot
  subscribe(fn: () => void): () => void
  set<K extends keyof RemoteSettingsClient>(field: K, value: RemoteSettingsClient[K]): Promise<void>
  refreshPair(): Promise<boolean>
  refresh(): Promise<boolean>
}

function defaultSettings(): RemoteSettingsClient {
  return { relayUrl: "", hostToken: "", autoConnect: true }
}

function readSettings(value: unknown): RemoteSettingsClient | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const relayUrl = typeof record["relayUrl"] === "string" ? record["relayUrl"] : ""
  const hostToken = typeof record["hostToken"] === "string" ? record["hostToken"] : ""
  const autoConnect = typeof record["autoConnect"] === "boolean" ? record["autoConnect"] : true
  return { relayUrl, hostToken, autoConnect }
}

function readStatus(value: unknown): RemoteStatusClient | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const state = typeof record["state"] === "string" ? record["state"] : "idle"
  if (state !== "idle" && state !== "connecting" && state !== "online" && state !== "error")
    return undefined
  const pair = isRecord(record["pair"]) ? readPair(record["pair"]) : null
  const peer = isRecord(record["peer"]) ? readPeer(record["peer"]) : null
  return {
    state,
    deviceId: typeof record["deviceId"] === "string" ? record["deviceId"] : "",
    relayUrl: typeof record["relayUrl"] === "string" ? record["relayUrl"] : "",
    hostName: typeof record["hostName"] === "string" ? record["hostName"] : "",
    pair,
    peer,
    lastError: typeof record["lastError"] === "string" ? record["lastError"] : null,
    connectedAt: typeof record["connectedAt"] === "number" ? record["connectedAt"] : null,
    retryInMs: typeof record["retryInMs"] === "number" ? record["retryInMs"] : null,
  }
}

function readPair(value: Record<string, unknown>): { code: string; expiresAt: number } | null {
  const code = typeof value["code"] === "string" ? value["code"] : ""
  const expiresAt = typeof value["expiresAt"] === "number" ? value["expiresAt"] : 0
  return code === "" ? null : { code, expiresAt }
}

function readPeer(value: Record<string, unknown>): { online: boolean; ua?: string } | null {
  const online = value["online"] === true
  const ua = typeof value["ua"] === "string" ? value["ua"] : undefined
  return ua === undefined ? { online } : { online, ua }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function createRemoteConfigSource(): RemoteConfigSource {
  let snapshot: RemoteSnapshot = { status: "loading", settings: undefined, remote: undefined }
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch {
        // contain subscriber failures
      }
    }
  }

  const publish = (next: RemoteSnapshot): void => {
    if (next === snapshot) return
    snapshot = next
    emit()
  }

  const fail = (): boolean => {
    publish({ status: "error", settings: undefined, remote: undefined })
    return false
  }

  async function refresh(): Promise<boolean> {
    try {
      const response = await fetch(STATUS_ROUTE, { credentials: "same-origin" })
      const body: unknown = await response.json()
      if (!response.ok || typeof body !== "object" || body === null) return fail()
      const record = body as Record<string, unknown>
      if (record["ok"] !== true) return fail()
      publish({
        status: "ready",
        settings: readSettings(record["settings"]) ?? defaultSettings(),
        remote: readStatus(record["status"]),
      })
      return true
    } catch {
      return fail()
    }
  }

  async function write(next: RemoteSettingsClient): Promise<void> {
    publish({ status: "ready", settings: next, remote: snapshot.remote })
    try {
      const response = await fetch(CONFIG_ROUTE, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: next }),
      })
      const body: unknown = await response.json()
      if (
        response.ok &&
        typeof body === "object" &&
        body !== null &&
        (body as Record<string, unknown>)["ok"] === true
      ) {
        const record = body as Record<string, unknown>
        publish({
          status: "ready",
          settings: readSettings(record["settings"]) ?? next,
          remote: readStatus(record["status"]) ?? snapshot.remote,
        })
      } else {
        void refresh()
      }
    } catch {
      // Network failure: keep the optimistic value; a later refresh reconciles.
    }
  }

  async function postPairCode(): Promise<boolean> {
    try {
      const response = await fetch(PAIR_CODE_ROUTE, { method: "POST", credentials: "same-origin" })
      if (!response.ok) return false
      const body: unknown = await response.json()
      if (
        typeof body === "object" &&
        body !== null &&
        (body as Record<string, unknown>)["ok"] === false
      )
        return false
      return await refresh()
    } catch {
      return false
    }
  }

  void refresh()

  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    async set(field, value) {
      const base = snapshot.settings ?? defaultSettings()
      const next: RemoteSettingsClient = { ...base, [field]: value }
      await write(next)
    },
    refreshPair: () => postPairCode(),
    refresh: () => refresh(),
  }
}
