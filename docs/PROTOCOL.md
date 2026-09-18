# dsh-pocketrelay 隧道协议 v1（契约）

> 两端共同遵守的隧道协议：桌面插件（host）与公网中继（relay-server）之间，手机浏览器使用 relay 自有的移动 UI，经 /api 数据面读写桌面端能力。
> 任何字段变更必须先 bump `PROTOCOL_VERSION`（见 `packages/protocol/src/frames.ts`）。

## 1. 拓扑与角色

```
手机浏览器 ──HTTPS──> relay-server ──WS(JSON 帧)──> dsh-pocketrelay 插件 ──注入 apiProxy/fs──> DSH 宿主能力
        │                 │  └────── 数据面：data-req / data-res 帧（relay 问，host 答）──────┘
        ├── 数据面：已配对手机 → relay 移动 UI（`/`）+ `/api/*`，relay 把请求翻译为 data-req 帧
        ├── 配对：6 位配对码 + 一次性挑战-响应（HMAC-SHA256），`HOST_TOKEN` 是信任边界
        └── 鉴权：手机用 HttpOnly 会话 cookie；relay 落盘只存 `sha256(token)` / `sha256(code)`
```

- **host**：桌面插件进程内的 WS 客户端，主动出站连 `wss://<relay>/ws?role=host`，用注入的 apiProxy/fs 能力应答 relay 的 data-req 帧。
- **phone**：手机浏览器，先 `POST /pair` 拿 challenge，再开 `wss://<relay>/ws?role=phone` 完成 HMAC 挑战，成功后拿会话 cookie。
- **relay**：公网服务（TLS 之后），配对认证、移动 UI 与 /api 数据面、WS 帧桥接、管理台。

## 2. 编码与帧

- 所有 WS 负载均为 UTF-8 JSON 文本帧，带 `t`（type）、`v`（协议版本）。
- 二进制（HTTP body / WS 帧）走 `dataBase64`（标准 Base64）。
- WS 单帧上限：`MAX_FRAME_BYTES = 64 KiB`；data-res 序列化载荷另限 1 MiB（见 §6）。
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
- 成功后 relay 设置 HttpOnly cookie `dsh-pocketrelay=<sessionId>`（30 天），后续 `/`、`/api/*` 与 `/ws?role=phone` 凭 cookie 鉴权。

## 5. 数据平面（手机 → relay：移动 UI 与 /api）

relay 不再反代桌面端 SPA，而是自供一套移动 UI（同源静态页，只调 relay 的 `/api/*`）：

- `/` 路由：凭会话 cookie 已配对 → 移动 UI；未配对 → landing/配对引导页；`/admin` 管理台不变。
- 移动 UI 的每个 `/api/*` 请求被 relay 翻译成一个 data-req 帧（§6）发给 host，relay 等到 data-res 后回 HTTP 响应。

| 手机请求 | data-req kind | 说明 |
|---|---|---|
| `GET /api/sessions` | `conversation`（不带 sessionId） | 会话列表 |
| `GET /api/history?sessionId=` | `conversation`（带 sessionId） | 会话历史 |
| `POST /api/message` `{sessionId,text}` | `send-message` | 发送消息 |
| `GET /api/files?path=` | `file-list` | 列目录 |
| `GET /api/file?path=` | `file-read` | 读文件 |
| `PUT /api/file` `{path,content}` | `file-write` | 写文件 |

HTTP 状态码映射：未认证 `401`；host 离线 `503`；host 回 `ok:false`（含载荷超限）`502`；默认 30s 超时 `504`。鉴权完全复用 §4 的会话 cookie，host 不参与手机侧鉴权。

## 6. 数据平面（relay → host：data-req / data-res）

relay 向 host 发结构化请求，host 用注入的 apiProxy/fs 能力应答：

```json
{ "t": "data-req", "id": <int>, "kind": "conversation" | "file-list" | "file-read" | "file-write" | "send-message", "path": "..."?, "content": "..."?, "sessionId": "..."? }
{ "t": "data-res", "id": <int>, "kind": "<同请求>", "ok": true, "data": <...>? }
{ "t": "data-res", "id": <int>, "kind": "<同请求>", "ok": false, "error": "..." }
```

- `id` 由 relay 铸造，host 原样回显；每个 data-req 恰好得到一个 data-res。
- host 经 `ctx.inject(["apiProxy", "fs"])` 取能力：apiProxy 管会话与宿主信息，fs 管工作目录文件。SDK 形状未最终确认，host 运行时探测，能力缺失或调用失败一律回 `ok:false`，不抛异常。
- data-res 序列化载荷上限 1 MiB，超限回 `ok:false`。
- `http-*` / `ws-*` 反向代理帧常量保留在 `T` 中（冻结），但不再是现役数据平面。

## 7. 心跳与重连

- host 每 `PING_INTERVAL_MS = 30s` 发 `{ "t": "ping" }`，relay 回 `{ "t": "pong" }`；`PING_TIMEOUT_MS = 90s` 无 pong 视为死链，relay 撤销该 host 的设备并通知已配对手机 peer offline。
- host 断线指数退避重连：`RECONNECT_BASE_MS = 1s` → `RECONNECT_MAX_MS = 60s`（1s → 2s → 4s → … 封顶 60s）。
- 手机侧：relay 在 host 离线时对 `/api/*` 返回 `503`，移动 UI 展示离线遮罩。

## 8. Relay 端点总览

| 路径 | 用途 |
|---|---|
| `/` | 已配对（会话 cookie）→ relay 自有移动 UI；未配对 → landing/配对引导页 |
| `/pair` | 配对入口：GET 展示配对说明页；POST `{ code }` 发起挑战 |
| `/manifest.webmanifest` | PWA manifest（手机可“添加到主屏”） |
| `/api/*` | 数据面 REST，翻译为 data-req 帧到 host（凭会话 cookie），路由表见 §5 |
| `/admin` | 管理台（独立口令登录，独立会话） |
| `/ws?role=host` | host 注册 WS |
| `/ws?role=phone` | phone 注册 WS（配对挑战） |

> 手机端鉴权细节：`/`、`/api/*` 与 `/ws?role=phone` 凭 HttpOnly cookie `dsh-pocketrelay=<sessionId>`；首次配对成功后 relay 下发 cookie 并附加 `x-dsh-pocketrelay-token`（设备 token，4 位以上随机）。后续 upgrade / fetch 经 cookie 自动带；relay 校验 cookie.session → 解析 deviceId → 命中落盘 token。
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
`data-req` `data-res`
`ws-open` `ws-open-ok` `ws-open-err` `ws-frame` `ws-close`

> `data-req` / `data-res` 是现役数据平面（§5、§6）；`http-*` 与 `ws-*` 常量保留冻结，仅作历史兼容，不再承载手机流量。
