# dsh-pocketrelay 重写交接（0.2.8 → 0.2.9+ 待续）

## 仓库状态
- 仓库: `D:\Desktop\myWorkspace\dsh-pocketrelay` (git, origin https://github.com/KusaUsagi/dsh-pocketrelay.git, main 分支)
- 本地 main 领先 origin 3 个 commit（GitHub 连接超时，push 失败；待网络恢复后 `git push origin main`）
- 最新 commit: `ad7d8e8` (0.2.8 — pivot conversations to HTTP API)
- 服务器 relay: 0.2.2 已部署运行（阿里云 /opt/dsh-pocketrelay, systemd dsh-pocketrelay, relay-dist-0.2.2.tar.gz + deploy/update.sh）
- 桌面 host: 0.2.8 tgz 已本地构建 (`packages/dsh-pocketrelay/dsh-pocketrelay-0.2.8.tgz`)，未推送到 GitHub

## 架构（已落地）
```
手机 ──HTTPS──> relay(移动 UI: 聊天+文件树+编辑器)
  relay ──WS data-req──> host 插件
    host: 会话→fetch http://127.0.0.1:<port>/api/session.* (dsh web HTTP API)
    host: 文件→ctx.fs (resolve/listDir/readText/writeText, method-call)
  host ──WS data-res──> relay ──> 手机
```
- 协议: data-req/data-res 帧（packages/protocol，冻结不动）
- relay: packages/relay-server (0.2.2) — 移动 UI + /api 路由翻译成 data-req + data-res 关联引擎
- host: packages/dsh-pocketrelay (0.2.8) — data-plane.ts 应答 data-req

## 当前阻塞问题（0.2.8 的 401）
0.2.8 的桌面日志:
```
[dsh-pocketrelay/data] data-res: kind=conversation id=16 ok=false error=HTTP 401 Unauthorized
```
- 对话操作（conversation）现在走 HTTP API: `POST http://127.0.0.1:<port>/api/session.list` 等
- 返回 401 → **dsh web 的信任边界（trust fence）未通过**
- librarian 研究结论: `isTrustedApiRequest` 检查 `Host` header (loopback 通过) + `Origin` (若存在须匹配) + `sec-fetch-site` (cross-site 拒绝)
- 但实际返回 401 → 可能:
  1. Node `fetch` 自动设置了 `Origin` header（与 Host 不匹配）→ 拒绝
  2. 或 0.1.5-rc.2 的信任逻辑与 librarian 研究的 master 版本不同
  3. 或需要额外的 header（如 token/cookie）

## 下一步（0.2.9）
1. **诊断 401**: 在 `data-plane.ts` 的 `apiCall` 里，fetch 时显式设置 headers（不设 Origin、设 `sec-fetch-site: same-origin`、或加 `Host: 127.0.0.1:<port>`），然后 log response 的 status + headers + body，看 401 的具体原因
2. **可能修复**:
   - 显式不设 Origin（Node fetch 默认不设，但某些版本会设）
   - 设 `sec-fetch-site: same-origin` 或 `sec-fetch-mode: cors`
   - 如果 dsh web 需要 token → 从 `webCtx.webServer` 或 `ctx.webStartup` 获取 token，加到 URL 或 header
   - 如果 401 持续 → 可能需要用 `InProcessApiClient`（但需要 apiProxy，不在本插件 scope）或直接调用 connection 插件的内部函数
3. **文件操作**: 0.2.8 的 fs 已确认有 resolve/listDir/readText/writeText（proto chain），method-call 语法保留 `this`。用户尚未报告文件是否 work（0.2.8 对话 401 后可能未测文件）。确认 file-list/file-read/file-write 的 ok 值
4. bump 0.2.9, rebuild host tgz, 用户本地安装测试

## 已确认的关键事实（调试 0.2.1-0.2.8 的发现）
- **dsh 版本**: 0.1.5-rc.2（`@deepseek-ai/dsh` npm）
- **apiProxy 不可用**: `ctx.get("apiProxy")` = undefined（不在本插件 scope；@deepseek-ai/dsh-host-apiproxy 包未安装，cordis.patch.yml 插入会崩溃 boot → 已移除）
- **sessions 服务**: `ctx.get("sessions")` = object{ctx,name,store,counter}, proto fns = {constructor,create,prepare,enter,detachEntered,announce,emitDisposed,flush,liveEntryFor,get,list,fork,_forkSeed,_resolveForkSource} — 是 session **lifecycle manager**（create/enter/fork），NOT conversation content。`sessions.list({})` 返回 >1MiB（full store，payload too large）。NO history/prompt methods。
- **fs 服务**: `ctx.get("fs")` = object{ctx,name,config,internals,locks,defaultMode}, proto fns = {constructor,writeText,editText,checkedTarget,withLock,resolve,processPath,processPathFromHostPath,fileUrl,contains,stat,lstat,readText,streamText,readBytes,readByteRange,listDir,versionAfterWrite} — 所有文件方法都在（inherited from LocalFileSystem）。method-call 必须（`fs.resolve(".")` 不能 detach，否则 `this.config` undefined → throw）
- **host 服务**: `ctx.get("host")` = undefined（也不在本插件 scope）
- **cordis inject 语义**: `ctx.inject(["x"], cb)` — cb 收到 Context（不是 caps 容器）。`ctx.get("x")` 是 bypass（不需要 inject 声明，不 throw）。`ctx.x`（直接属性读）**throw** "cannot get property without inject"
- **ctx.inject 嵌套在 webCtx.effect 内不触发**（0.2.1-0.2.2 发现）→ 必须 top-level
- **dsh web HTTP API**（librarian 研究 master 分支，可能与 0.1.5-rc.2 有差异）:
  - route: `POST /api/<namespace>.<method>`
  - envelope: `{type:'client-request', rpcId, method, payload}` → reply `{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}`
  - methods: `session.list`, `session.history`, `session.prompt`
  - trust: `isTrustedApiRequest` checks Host (loopback OK), Origin (if present must match), sec-fetch-site (cross-site refused)
  - **BUT**: handler does `if (apiProxy === undefined) return 404` — 所以 /api 只在 connection 插件 scope（有 apiProxy）下 work；本插件 fetch 应该通过 connection 的 scope 拿到 apiProxy
  - **401 说明 trust fence 未通过**（不是 404），所以 apiProxy 在 connection scope 是有的，只是 trust fence 拒了

## 关键文件
- `packages/dsh-pocketrelay/src/data-plane.ts` (0.2.8): apiCall() fetch /api/session.* + fs method-call
- `packages/dsh-pocketrelay/src/index.ts` (0.2.8): setOrigin + setFs + probe
- `packages/dsh-pocketrelay/cordis.patch.yml`: 只插 dsh-pocketrelay 行（api-gateway 行已移除，会 crash）
- `packages/relay-server/` (0.2.2): 不需改动，已部署
- `packages/protocol/`: 冻结不动

## 部署
- 服务器 relay: 已部署 0.2.2（`relay-dist-0.2.2.tar.gz` + `deploy/update.sh`），不需更新
- 桌面 host: 本地 `dsh plugin --profile web add packages/dsh-pocketrelay/dsh-pocketrelay-0.2.X.tgz` + `$env:NODE_TLS_REJECT_UNAUTHORIZED='0'` + `dsh --profile web`（前台终端，看 console.warn）
- 桌面 dsh 版本: 0.1.5-rc.2（`@deepseek-ai/dsh`）
- 桌面连 GitHub 超时 → push 失败（本地 commit ahead 3）→ 待网络恢复 push

## 调试历史（0.2.0→0.2.8 的 commit 链）
```
ad7d8e8 0.2.8 pivot conversations to HTTP API + files via ctx.fs
40476c7 0.2.7 insert api-gateway bundle row (CRASHED — package not installed) → REMOVED
ba3a16d 0.2.6 full proto-chain probe + fs.resolve multi-input + result-shape log
6746807 0.2.5 method-call syntax (preserve this) + fs.resolve('.')
3aac3b6 0.2.4 use sessions/host/fs directly (apiProxy absent) + per-kind caps
49eae23 0.2.3 probe via ctx.get only (direct ctx.apiProxy throws)
e511624 0.2.2 top-level ctx.inject + probe (CRASHED — "cannot get without inject")
8132693 0.2.1 observability logging
f9aaecb 0.2.0 structured data plane (initial rewrite)
```

## 给下一个会话的指示
1. 先 `git log --oneline -5` + `git status` 确认状态（ahead 3, 0.2.8）
2. 读 `packages/dsh-pocketrelay/src/data-plane.ts` 的 `apiCall()` (约 line 142-156)
3. 用户报告 0.2.8 conversation 401 → 诊断 trust fence
4. 修 0.2.9: 在 apiCall 的 fetch 里显式控制 headers (Origin/sec-fetch-site/Host)，log 401 的 response detail
5. 可能需要研究 0.1.5-rc.2 的 `isTrustedApiRequest` 源码（在 node_modules/@deepseek-ai/dsh-*/ 或 dsh-client-connection）
6. 确认文件操作（file-list/read/write）是否 ok=true（用户未报告）
7. bump 0.2.9, rebuild, 用户本地安装测试
