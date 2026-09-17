# dsh-pocketrelay 隧道协议 v1（契约）

> 两端共同遵守的隧道协议：桌面插件（host）与公网中继（relay-server）之间，手机浏览器经中继访问本地 dsh web。
> 任何字段变更必须先 bump `PROTOCOL_VERSION`（见 `packages/protocol/src/frames.ts`）。

## 1. 拓扑与角色

```
手机浏览器 ──HTTPS──> relay-server ──WS(JSON 帧)──> dsh-pocketrelay 插件 ──HTTP/WS──> 本地 dsh web (127.0.0.1:<dshWebPort>)
        │                 │  └────── 下行事件流透传（/events/*）──────┘
        ├── 上行：手机 → `https://<relay>/d/<deviceId>/<...rest>` 全量反代，帧序即流序（SSE / blob 不受影响）
        ├── 配对：6 位配对码 + 一次性挑战-响应（HMAC-SHA256），`HOST_TOKEN` 是信任边界
        └── 鉴权：手机用 HttpOnly 会话 cookie；relay 落盘只存 `sha256(token)` / `sha256(code)`
```

- **host**：桌面插件进程内的 WS 客户端，主动出站连 `wss://<relay>/ws?role=host`，注册后把手机流量桥接到 `127.0.0.1:<dshWebPort>`。
- **phone**：手机浏览器，先 `POST /pair` 拿 challenge，再开 `wss://<relay>/ws?role=phone` 完成 HMAC 挑战，成功后拿会话 cookie。
- **relay**：公网服务（TLS 之后），配对认证、HTTP 反向代理、WS 帧桥接、管理台。

## 2. 编码与帧

- 所有 WS 负载均为 UTF-8 JSON 文本帧，带 `t`（type）、`v`（协议版本）。
- 二进制（HTTP body / WS 帧）走 `dataBase64`（标准 Base64）。
- WS 单帧上限：`MAX_FRAME_BYTES = 64 KiB`；relay 把更大的 body 切成多个 `http-body` / `http-chunk`。
- 帧类型常量见 `packages/protocol/src/frames.ts` 的 `T`。完整 TS 类型见 `packages/protocol/src/index.ts` 的 `Frame` 联合。

## 3. Host 注册

URL：`wss://<relay>/ws?role=host`

```json
{ "t": "hello", "v": 1, "role": "host", "deviceId": "<32-hex>", "hostToken": "<relay 部署时配置的信任边界令牌>" }
```

| 方向 | 帧 | 说明 |
|---|---|---|
| relay → host | `{ "t": "hello-ok", "pair": { "code": "123456", "expiresAt": <ms> } \| null, "peer": { "online": true, "hostName": "..." } \| null }` | pair 为当前配对码（无则 null）；peer 指手机在线态 |
| relay → host | `{ "t": "hello-deny", "reason": "BAD_TOKEN" }` | hostToken 错，relay 关闭连接 |
| relay → host | `{ "t": "pair", "code": "...", "expiresAt": <ms> }` | 配对码刷新（旧码到期前下发新码） |
| relay → host | `{ "t": "pair-refresh" }` | 要求 host 重新轮询 `POST /pair` 取码 |
| relay → host | `{ "t": "revoke" }` → host 回 `{ "t": "revoked" }` | 撤销某设备；host 清本地 token |

`BAD_TOKEN`（hostToken 不符）与 `UNKNOWN_DEVICE`（relay 不认识该 deviceId）一律拒绝。

## 4. 手机配对（挑战-响应 + HMAC）

**Step 1 — 请求挑战（HTTP）：** 手机 `POST https://<relay>/pair`，body `{ "code": "123456" }`。relay 校验 code 命中未过期配对码，生成 `challenge = random-32-byte-hex`（TTL 60s），回：

```json
{ "ok": true, "deviceId": "<32-hex>", "challenge": "<hex>", "challengeTtlMs": 60000, "token": "<random-32-byte-hex>" }
```

**Step 2 — 握手（WebSocket）：** 手机开 `wss://<relay>/ws?role=phone`：

```json
{ "t": "hello", "v": 1, "role": "phone", "deviceId": "<...>", "challenge": "<...>", "response": "<...>", "token": "<...>" }
```

- `response = HMAC_SHA256(key = SHA256(code), msg = challenge)` 的 hex。
- relay 侧校验：challenge 未过期、response 比对成功 → 落盘 `token`（存 `sha256(token)`）→ 回 `hello-ok` 并下发 `peer`（host 在线态）。
- 失败：`{ "t": "hello-deny", "reason": "BAD_TOKEN" | "UNKNOWN_DEVICE" }` 后关闭 socket。
- 挑战一次性：成功后失效，禁止重放。
- 成功后 relay 设置 HttpOnly cookie `dsh-pocketrelay=<sessionId>`（30 天），后续 `/d/<deviceId>/*` 与 `/ws?role=phone` 凭 cookie 鉴权。

## 5. HTTP 平面（手机 → 本地 dsh web）

手机请求 `https://<relay>/d/<deviceId>/<...rest>`（含 query），relay 以 host 的 WS 反代：

| 方向 | 帧 | 说明 |
|---|---|---|
| relay → host | `{ "t": "http-req", "id": <int>, "method": "POST", "path": "/api/chat", "query": "?a=1", "headers": {...} \| null, "bodyBase64": "<...>" \| null }` | 一次性小 body 直接带；headers 只保留 plain（非 hop-by-hop） |
| host → relay | `{ "t": "http-head", "id": <int>, "status": 200, "headers": {...} }` | 起始响应；hop-by-hop 头由 host 剥离 |
| host → relay | `{ "t": "http-body", "id": <int>, "dataBase64": "<...>" }` | body 分块，≤ `HTTP_CHUNK_BYTES` |
| host → relay | `{ "t": "http-body-end", "id": <int> }` | body 结束 |
| host → relay | `{ "t": "http-abort", "id": <int> }` | 手机侧中止 |
| relay → host | `{ "t": "http-abort", "id": <int> }` | 手机端断开，通知 host 中止上游 |
| host → relay | `{ "t": "http-err", "id": <int>, "code": "UPSTREAM_DOWN", "message": "..." }` | host 无法连本地 dsh web（502/504） |

**流式正确性**：relay 必须用 `writeHead` 写首部后持续 `write` body chunk、`end()` 收尾，保持帧序即流序，**不缓冲整段响应**——dsh 的 `text/event-stream`（SE）与 `blob` 不得被破坏。`http-body` / `http-chunk` 逐帧 flush，MVP 下不做合并优化。

host 上游目标固定 `http://127.0.0.1:<dshWebPort>`，可带 `X-Forwarded-*`（host 加 `X-Dsh-Pocketrelay: host` 标识）。relay 侧响应头里注入 `X-Dsh-Pocketrelay-Status` 调试位（可选）。

## 6. WebSocket 平面（手机 → 本地 dsh events）

手机对 `https://<relay>/d/<deviceId>/events/*` 发起 WS upgrade → relay 转 `ws-open` → host 在本地对 `ws://127.0.0.1:<dshWebPort><path>` 开 WS（透传 `sec-websocket-protocol` 与查询 token）：

| 方向 | 帧 | 说明 |
|---|---|---|
| relay → host | `{ "t": "ws-open", "id": <int>, "path": "/events/mux", "headers": {...} }` | |
| host → relay | `{ "t": "ws-open-ok", "id": <int> }` | 本地 WS 已建立 |
| host → relay | `{ "t": "ws-open-err", "id": <int>, "reason": "..." }` | 本地拒绝；relay 回 phone 1006 |
| 双向 | `{ "t": "ws-frame", "id": <int>, "opcode": 1 \| 2, "dataBase64": "<...>" }` | `1`=text、`2`=binary；逐帧透传 |
| host/relay → 对端 | `{ "t": "ws-close", "id": <int>, "code": 1000, "reason": "..." }` | 任一侧关闭，relay 转给对端 |

host 用 Node 22 原生 `WebSocket`（globalThis）连本地 dsh；relay 用 `ws` 库管手机侧 socket。

## 7. 心跳与重连

- host 每 `PING_INTERVAL_MS = 30s` 发 `{ "t": "ping" }`，relay 回 `{ "t": "pong" }`；`PING_TIMEOUT_MS = 90s` 无 pong 视为死链，relay 撤销该 host 的设备并通知已配对手机 peer offline。
- host 断线指数退避重连：`RECONNECT_BASE_MS = 1s` → `RECONNECT_MAX_MS = 60s`（1s → 2s → 4s → … 封顶 60s）。
- 手机侧：relay 在 host 离线时对 `/d/<deviceId>/*` 返回 `503 X-Dsh-Pocketrelay: host-offline`。

## 8. Relay 端点总览

| 路径 | 用途 |
|---|---|
| `/` | 管理台（独立口令登录，独立会话） |
| `/pair` | 配对入口：GET 展示配对说明页；POST `{ code }` 发起挑战 |
| `/manifest.webmanifest` | PWA manifest（手机可“添加到主屏”） |
| `/d/<deviceId>/*` | 反代到 host 的本地 dsh web（凭会话 cookie + 设备 token） |
| `/ws?role=host` | host 注册 WS |
| `/ws?role=phone` | phone 注册 WS（配对挑战） |

> 手机端鉴权细节：`/d/<deviceId>/*` 与 `/ws?role=phone` 凭 HttpOnly cookie `dsh-pocketrelay=<sessionId>`；首次配对成功后 relay 下发 cookie 并附加 `x-dsh-pocketrelay-token`（设备 token，4 位以上随机）。后续 upgrade / fetch 经 cookie 自动带；relay 校验 cookie.session → 解析 deviceId → 命中落盘 token。
> **host 不参与鉴权**：host 仅与 relay 维持一条 `HOST_TOKEN` 鉴权的 WS；手机 token 与 host 无关，host 只看 relay 转发的帧。

## 9. Relay 持久化（JSONL）

`<dataDir>/relay.jsonl`（默认 `~/.dsh-pocketrelay/relay.jsonl`）：

```json
{ "type": "device", "deviceId": "...", "hostName": "...", "createdAt": <ms> }
{ "type": "pairing", "deviceId": "...", "codeSha": "sha256(code) hex", "expiresAt": <ms> }
{ "type": "token", "deviceId": "...", "tokenSha": "sha256(token) hex", "createdAt": <ms>, "revokedAt": null }
```

host 关闭仅清当前配对码；设备记录与 token 记录保留（除非显式 revoke）。

## 10. 安全边界

- relay 必须置于 TLS 之后；默认自签证书（手机需手动信任），亦支持 Caddy / Cloudflare。
- `HOST_TOKEN` 是 relay 与 host 间唯一信任边界；配对走一次性 HMAC 挑战，防重放。
- relay 落盘只存 `sha256`；日志**永不**打印 token / 配对码 / challenge / response。
- 手机会话 HttpOnly cookie；管理台独立口令与会话。
- 不信任 relay 转发头的鉴权语义：host 仅以 `HOST_TOKEN` 与 relay 建立信任，转发的 `x-dsh-pocketrelay-token` 等只作调试，不参与 host 侧鉴权。

## 11. 帧类型一览（与 `frames.ts` 的 `T` 严格对齐）

`hello` `hello-ok` `hello-deny` `peer` `revoke` `revoked` `pair-refresh` `pair` `ping` `pong`
`http-req` `http-body` `http-body-end` `http-abort` `http-head` `http-chunk` `http-end` `http-err`
`ws-open` `ws-open-ok` `ws-open-err` `ws-frame` `ws-close`
