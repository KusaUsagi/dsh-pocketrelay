# dsh-pocketrelay

DeepSeek Harness（DSH）桌面插件的手机远程连接方案：自托管中继 + 隧道桥接 + 移动适配。

运行在 `dsh --profile web` 内，出站注册到自托管 relay，把手机浏览器流量桥接到本地
`127.0.0.1:<webServer.port>`，并为隧道内流量注入移动适配层（满宽聊天、全屏设置面板、
侧栏抽屉、`interactive-widget=resizes-content` 视口）。

```
手机浏览器 ──HTTPS──> relay-server ──WS(JSON 帧)──> dsh-pocketrelay ──HTTP/WS──> 本地 dsh web
```

PC 出站 WS 主动注册，无需入站端口/公网 IP；`HOST_TOKEN` 是 relay 与 host 间唯一信任边界，
配对走 6 位码 + HMAC-SHA256 一次性挑战。完整协议见 [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md)。

## 安装

从 GitHub Release 拉取预构建 tgz（免 `allowBuilds`）：

```sh
dsh plugin --profile web add https://github.com/<owner>/dsh-pocketrelay/releases/download/v0.1.0/dsh-pocketrelay-0.1.0.tgz
dsh --profile web
```

本地构建：

```sh
pnpm build && pnpm build:client && pnpm pack:tgz
dsh plugin --profile web add ../dsh-pocketrelay-0.1.0.tgz
```

## 使用

启动后在 DSH **设置 → 手机连接**：

1. 填写中继地址（`https://<公网IP>:8443`）与 `HOST_TOKEN`；
2. 连接成功后页面显示 6 位配对码；
3. 手机访问 `<relay>/pair`（或直接打开配对页链接）输入配对码。

运行时配置持久化于 `<dshHome>/storages/dsh-pocketrelay/config.json`（原子写：`.tmp` 后
rename），覆盖 `cordis.patch.yml` 的默认值。设备标识 `identity.json`（32-hex）同目录持久化。

## 安全

- relay 必须置于 TLS 之后；`HOST_TOKEN` 是唯一信任边界，插件日志永不打印 token/配对码明文。
- 配对走一次性 HMAC 挑战；relay 落盘只存 `sha256`。
- 手机会话 cookie（授权凭据）由 `connection.browserAuth` 在进程内为 loopback authority 铸造，
  凭据不离开桌面进程；旧版 harness 无此服务时自动退化为透传。

## License

MIT