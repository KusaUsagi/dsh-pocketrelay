# dsh-pocketrelay

DeepSeek Harness（DSH）桌面插件的手机远程连接方案：自托管中继 + 结构化数据面。

运行在 `dsh --profile web` 内，出站注册到自托管 relay，应答 relay 发来的 data-req
数据帧：经 `ctx.inject(["apiProxy", "fs"])` 注入的能力处理会话与文件请求（apiProxy
管会话与宿主信息，fs 管工作目录文件），结果以 data-res 帧返回。SDK 形状未最终确认，
运行时探测，能力缺失即回 `ok:false`。webServer 注入保留，仅服务控制面的设置页。

```
手机浏览器 ──HTTPS──> relay-server ──WS(data-req/data-res)──> dsh-pocketrelay ──ctx.apiProxy / ctx.fs──> DSH 宿主能力
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
3. 手机访问 `<relay>/pair`（或直接打开配对页链接）输入配对码，配对成功即在 `<relay>/` 打开移动 UI。

运行时配置持久化于 `<dshHome>/storages/dsh-pocketrelay/config.json`（原子写：`.tmp` 后
rename），覆盖 `cordis.patch.yml` 的默认值。设备标识 `identity.json`（32-hex）同目录持久化。

## 安全

- relay 必须置于 TLS 之后；`HOST_TOKEN` 是唯一信任边界，插件日志永不打印 token/配对码明文。
- 配对走一次性 HMAC 挑战；relay 落盘只存 `sha256`。
- 手机会话 cookie 由 relay 签发（HttpOnly）；插件只认 `HOST_TOKEN` 那条 WS，
  不参与手机侧鉴权，只见 relay 翻译后的 data-req 帧。

## License

MIT