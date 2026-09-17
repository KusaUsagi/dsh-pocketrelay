# @dsh-pocketrelay/relay-server

公网中继：手机浏览器经此访问桌面端 DeepSeek Harness。配对鉴权、HTTP/WS 反向代理、管理台。

```
手机浏览器 ──HTTPS──> relay-server ──WS(JSON 帧)──> dsh-pocketrelay 桌面插件 ──HTTP/WS──> 本地 dsh web
```

## 运行

```sh
# 构建（在项目根）
pnpm --filter @dsh-pocketrelay/protocol build
pnpm --filter @dsh-pocketrelay/relay-server build

# 启动（hostToken 必填；端口默认 8443；自签证书自动生成并缓存到 dataDir/tls）
DSH_POCKETRELAY_HOST_TOKEN=<你的强随机串> node packages/relay-server/dist/cli.js
```

常用参数：`--hostToken`(或 env `DSH_POCKETRELAY_HOST_TOKEN`)、`--port`、`--bind`、`--dataDir`、`--cert`/`--key`、`--adminPassword`（省略则随机生成并打印一次）。

## 部署（腾讯云，公网 IP + 自签）

```sh
sudo DSH_POCKETRELAY_HOST_TOKEN=<强随机串> \
     DSH_POCKETRELAY_ADMIN_PASSWORD=<管理口令> \
     bash packages/relay-server/deploy/install.sh
```

脚本：确认 Node ≥ 22、构建、openssl 预生成自签证书、装 systemd unit 并启动。手机需手动信任证书。

## 手机配对流程（v1 简化）

1. 桌面插件以 hostToken 注册 → relay 签发 6 位配对码（推给桌面展示）。
2. 手机访问 `<relay>/pair`，输入 6 位码 → relay 校验（code 作一次性密钥，60s 有效）→ 下发 HttpOnly 会话 cookie + 重定向到 `/d/<deviceId>/`。
3. 之后手机的 `/d/<deviceId>/*` 请求凭 cookie 反代到桌面端本地 dsh web（流式，支持 SSE）；`/d/<deviceId>/events/*` 的 WS upgrade 桥接到本地 dsh 事件流。

> v1 用 code 作一次性密钥（Set-Cookie 在 /pair HTTP 响应下发，浏览器原生支持）；
> 完整协议（`docs/PROTOCOL.md` §4 的 HMAC-SHA256 WS 挑战）为后续增强，当前实现与之等价安全语义。

## 安全

- relay 必须置于 TLS 之后；`HOST_TOKEN` 是 relay 与桌面 host 间唯一信任边界。
- 落盘（`<dataDir>/relay.jsonl`）只存 `sha256(code)` / `sha256(token)`，明文从不持久化。
- 手机会话 HttpOnly+Secure cookie（30 天）；管理台独立口令（scrypt）+ 独立会话。
- 日志永不打印 token / 配对码 / 挑战明文。

## License

MIT
