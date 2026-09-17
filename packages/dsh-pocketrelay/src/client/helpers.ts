/**
 * dsh-pocketrelay — RemoteSection UI helpers (pure, presentation-only).
 */
import type { RemoteStatusClient } from "./config-source.js"

export interface ConnBadge {
  text: string
  color: string
}

export function labelOf(state: RemoteStatusClient["state"]): ConnBadge {
  switch (state) {
    case "online":
      return { text: "已连接", color: "#2e9e5b" }
    case "connecting":
      return { text: "连接中…", color: "#d98e2b" }
    case "error":
      return { text: "连接异常", color: "#c94b4b" }
    default:
      return { text: "未连接", color: "#8a8f98" }
  }
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false })
}

export function copyText(text: string): Promise<boolean> {
  return navigator.clipboard
    .writeText(text)
    .then(() => true)
    .catch(async () => {
      try {
        const area = document.createElement("textarea")
        area.value = text
        area.setAttribute("readonly", "")
        area.style.position = "fixed"
        area.style.opacity = "0"
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand("copy")
        area.remove()
        return ok
      } catch {
        return false
      }
    })
}

export function relayRoot(relayUrl: string): string {
  const trimmed = relayUrl.trim()
  if (trimmed === "") return ""
  return trimmed.replace(/^wss?:\/\//, (match) =>
    match.startsWith("wss") ? "https://" : "http://",
  )
}

export function buttonStyle(disabled: boolean): Record<string, string | number> {
  return {
    padding: "3px 10px",
    fontSize: 12,
    borderRadius: 6,
    border: "1px solid var(--dsh-border, #3a3d45)",
    background: "var(--dsh-surface-2, rgba(255,255,255,0.06))",
    cursor: disabled ? "not-allowed" : "pointer",
    color: "inherit",
    opacity: 0.9,
    transition: "opacity .15s ease, background .15s ease",
  }
}
