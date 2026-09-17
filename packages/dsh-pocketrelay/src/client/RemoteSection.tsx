/**
 * dsh-pocketrelay — RemoteSection: the "手机连接" page inside DSH Settings
 * (settings.section slot). Shows the live tunnel status and the pairing code,
 * and edits relay settings through the HTTP-backed config source. UI copy is
 * zh-CN.
 */

import type { ReactElement, ReactNode } from "react"
import { useEffect, useState, useSyncExternalStore } from "react"
import type { RemoteConfigSource } from "./config-source.js"
import { createRemoteConfigSource } from "./config-source.js"
import { buttonStyle, copyText, formatTime, labelOf, relayRoot } from "./helpers.js"

export interface RemoteSectionProps {
  remote?: RemoteConfigSource
  close?: () => void
}

function Row(props: { label: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
    >
      <span style={{ fontSize: 13 }}>{props.label}</span>
      {props.children}
    </div>
  )
}

export function RemoteSection(props: RemoteSectionProps): ReactElement {
  const [source] = useState<RemoteConfigSource>(() => props.remote ?? createRemoteConfigSource())
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)

  const settings = snapshot.status === "ready" ? snapshot.settings : undefined
  const remote = snapshot.status === "ready" ? snapshot.remote : undefined
  const state = remote?.state ?? "idle"
  const badge = labelOf(state)

  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [, setTick] = useState(0)
  const pairCode = remote?.pair?.code
  useEffect(() => {
    if (pairCode === undefined) return
    const timer = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(timer)
  }, [pairCode])
  const pairExpired =
    remote?.pair !== undefined && remote.pair !== null && remote.pair.expiresAt <= Date.now()
  const relay = relayRoot(settings?.relayUrl ?? "")
  const pairUrl = relay !== "" && remote?.pair ? `${relay}/pair?code=${remote.pair.code}` : ""

  const act = async (
    fn: () => Promise<boolean>,
    okText: string,
    failText = "操作失败，请检查网络或中继地址",
  ): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setNotice(null)
    const result = await fn()
    setRefreshing(false)
    setNotice(result ? { ok: true, text: okText } : { ok: false, text: failText })
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 0 24px" }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>手机连接</h2>
      <p style={{ margin: 0, fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
        通过自托管中继把手机浏览器接入桌面 DSH：手机打开配对页输码即可像桌面端一样使用。
      </p>

      <Row label="连接状态">
        <span style={{ fontSize: 13, fontWeight: 600, color: badge.color }}>{badge.text}</span>
      </Row>

      <Row label="设备编号">
        <span
          style={{
            fontSize: 12,
            fontFamily: "monospace",
            wordBreak: "break-all",
            maxWidth: 260,
            textAlign: "right",
          }}
        >
          {remote?.deviceId ?? "—"}
        </span>
      </Row>

      <Row label="中继地址">
        <input
          style={{
            width: 300,
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid var(--dsh-border, #3a3d45)",
            background: "transparent",
          }}
          placeholder="https://relay.example.com"
          disabled={busy}
          defaultValue={settings?.relayUrl ?? ""}
          key={`relay-${settings?.relayUrl ?? ""}`}
          onBlur={(e) => {
            setBusy(true)
            void source.set("relayUrl", e.target.value.trim()).finally(() => setBusy(false))
          }}
        />
      </Row>

      <Row label="中继令牌">
        <input
          type="password"
          style={{
            width: 300,
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid var(--dsh-border, #3a3d45)",
            background: "transparent",
          }}
          placeholder="部署 relay 时配置的 host token"
          disabled={busy}
          defaultValue={settings?.hostToken ?? ""}
          key={`token-${settings?.hostToken ?? ""}`}
          onBlur={(e) => {
            setBusy(true)
            void source.set("hostToken", e.target.value.trim()).finally(() => setBusy(false))
          }}
        />
      </Row>

      <Row label="启动时自动连接">
        <input
          type="checkbox"
          style={{
            width: 16,
            height: 16,
            accentColor: "var(--dsh-accent, #4c8dff)",
            cursor: "pointer",
          }}
          checked={settings?.autoConnect ?? true}
          onChange={(e) => {
            void source.set("autoConnect", e.target.checked)
          }}
        />
      </Row>

      {remote?.pair ? (
        <div
          style={{
            background: "var(--dsh-surface-2, rgba(255,255,255,0.04))",
            borderRadius: 10,
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.7 }}>配对码（10 分钟内有效）</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{ fontSize: 22, fontWeight: 700, letterSpacing: 3, fontFamily: "monospace" }}
            >
              {remote.pair.code}
            </span>
            <button
              type="button"
              style={buttonStyle(refreshing)}
              disabled={refreshing}
              onClick={() => {
                void act(
                  () => copyText(remote.pair?.code ?? ""),
                  "配对码已复制",
                  "复制失败，请手动选择复制",
                )
              }}
            >
              复制
            </button>
            <button
              type="button"
              style={buttonStyle(refreshing)}
              disabled={refreshing}
              onClick={() => {
                void act(() => source.refreshPair(), "配对码已刷新")
              }}
            >
              {refreshing ? "刷新中…" : pairExpired ? "刷新新码" : "刷新"}
            </button>
          </div>
          <div
            style={{
              fontSize: 11,
              opacity: pairExpired ? 1 : 0.5,
              color: pairExpired ? "#c94b4b" : undefined,
            }}
          >
            {pairExpired
              ? `配对码已于 ${formatTime(remote.pair.expiresAt)} 过期，手机输入此码无效——点击「刷新新码」后再用新码配对。`
              : `有效期至 ${formatTime(remote.pair.expiresAt)} · 手机访问 `}
            {!pairExpired && pairUrl !== "" && (
              <a
                style={{ color: "var(--dsh-accent, #4c8dff)" }}
                href={pairUrl}
                target="_blank"
                rel="noreferrer"
              >
                配对页
              </a>
            )}
          </div>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 12, opacity: 0.55 }}>
          {state === "error"
            ? (remote?.lastError ?? "连接失败，请检查地址与令牌。")
            : state === "connecting"
              ? "正在建立中继连接…"
              : "已连接中继后此处显示配对码。"}
        </p>
      )}

      <Row label="手机在线">
        <span style={{ fontSize: 13 }}>{remote?.peer?.online === true ? "是" : "否"}</span>
      </Row>

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button
          type="button"
          style={buttonStyle(refreshing)}
          disabled={refreshing}
          onClick={() => {
            void act(() => source.refresh(), "已刷新状态")
          }}
        >
          {refreshing ? "刷新中…" : "刷新状态"}
        </button>
      </div>

      {notice ? (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            opacity: 0.75,
            color: notice.ok ? "inherit" : "#c94b4b",
          }}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  )
}
