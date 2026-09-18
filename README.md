# dsh-pocketrelay

手机浏览器经自托管中继远程使用 DeepSeek Harness(DSH)桌面端能力的隧道方案:relay 自有移动 UI + 结构化数据面。

- **relay-server**:部署在公网 VPS(腾讯云,公网 IP + 自签证书)上的 Node 服务。配对鉴权、移动 UI 与 /api 数据面、管理台。
- **dsh-pocketrelay**(DSH 插件):运行在 PC 的 `dsh --profile web` 内,启动后出站注册到 relay,经注入的 apiProxy/fs 能力应答 relay 的 data-req 数据帧。

```
手机浏览器 ──HTTPS──> relay-server(移动 UI + /api)──WS(data-req/data-res)──> dsh-pocketrelay 插件 ──apiProxy/fs──> DSH 宿主能力
```

PC 用出站 WS 主动注册,无需在 PC 开入站端口/公网 IP;`HOST_TOKEN` 是 relay 与 host 间唯一信任边界,配对走 6 位码 + HMAC-SHA256 一次性挑战。完整协议见 [`docs/PROTOCOL.md`](./docs/PROTOCOL.md)。

## 仓库结构

```
packages/
├── protocol/         # 共享帧类型 + 常量(@dsh-pocketrelay/protocol)
├── relay-server/     # 公网中继(@dsh-pocketrelay/relay-server)
└── dsh-pocketrelay/  # DSH 桌面插件(dsh-pocketrelay,可被 `dsh plugin add` 安装)
.github/workflows/    # ci.yml + release.yml(打 tag 自动出 Release tgz)
```

## 开发

需要 Node ≥ 22 + pnpm 9。

```sh
pnpm install
pnpm -r build        # 构建所有包
pnpm -r typecheck
pnpm exec biome check .
pnpm -r test         # relay-server 的 smoke test
```

## 部署 relay-server(腾讯云)

见 [`packages/relay-server/README.md`](./packages/relay-server/README.md)。默认自签证书(手机需手动信任)。一键脚本:

```sh
sudo bash packages/relay-server/deploy/install.sh
```

启动后记录 `HOST_TOKEN` 与监听地址(默认 `0.0.0.0:8443`)。

## 安装 DSH 插件(桌面端)

从 GitHub Release 拉取预构建 tgz(免 `allowBuilds`):

```sh
dsh plugin --profile web add https://github.com/KusaUsagi/dsh-pocketrelay/releases/download/v0.1.0/dsh-pocketrelay-0.1.0.tgz
dsh --profile web
```

> 若你把项目推到别的 owner/repo(例如现有的 `dsh-workspace` 仓库),把上面 URL 的 `KusaUsagi/dsh-pocketrelay` 换成你的 `<owner>/<repo>` 即可。

启动后在 DSH **设置 → 手机连接** 填 relay 地址(`https://<公网IP>:8443`)与 `HOST_TOKEN`,扫码或在 `<relay>/pair` 输入 6 位配对码,配对成功后手机打开 `<relay>/` 即是 relay 自有的移动 UI,可远程会话与管理桌面端工作目录文件。

## 安全

- relay 必须置于 TLS 之后;`HOST_TOKEN` 是唯一信任边界;落盘只存 `sha256`。
- 手机用 HttpOnly 会话 cookie;管理台独立口令。
- DSH 仍是 developer preview,版本请按需 pin。

## License

MIT
