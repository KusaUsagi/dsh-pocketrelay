import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { WebSocket as WsClient } from "ws"
import { createRelay } from "../dist/index.js"

// 信任 relay 的自签证书（仅测试）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

const HOST_TOKEN = "test-host-token-abc"

/**
 * data 面请求兜底超时。data 面正常往返 <100ms；此值仅在「/api 路由尚未实现 → 旧反代路径挂死」时
 * 把测试从无限挂起转为明确的断言失败，而非 harness 错误。
 */
const REQ_TIMEOUT_MS = 2000

/**
 * 启动 relay + host 注册（/ws?role=host 送 hello → hello-ok{pair}）+ 手机 /pair 换会话 cookie。
 * fake host 收到 data-req 时记录帧并回显 data-res（id/kind 原样回显，不臆造 id）；
 * responder.reply 为 null 时保持静默（超时用例）。
 * 返回 { relay, base, deviceId, hostWs, received, responder, cookie }。
 */
async function spinUp(opts = {}) {
  const dataDir = join(tmpdir(), `dsh-relay-test-${Date.now()}-${randomBytes(4).toString("hex")}`)
  const relay = await createRelay({
    hostToken: HOST_TOKEN,
    port: 0,
    bind: "127.0.0.1",
    dataDir,
    adminPassword: "admin",
    log: () => {},
    ...(opts.relayOpts ?? {}),
  })
  const base = `https://127.0.0.1:${relay.port}`
  const deviceId = randomBytes(16).toString("hex")

  /** 收到 data-req 帧的顺序记录（用于断言 relay→host 的帧形状）。 */
  const received = []
  /** 可变 responder；reply(req) 返回 {ok,data,error} 或 null（null=静默）。 */
  const responder = { reply: opts.reply ?? null }

  const hostWs = new WsClient(`${base}/ws?role=host`, { rejectUnauthorized: false })
  const helloOk = await new Promise((resolve, reject) => {
    hostWs.on("error", reject)
    hostWs.on("open", () => {
      hostWs.send(
        JSON.stringify({
          t: "hello",
          v: 1,
          role: "host",
          deviceId,
          hostToken: HOST_TOKEN,
          hostName: "smoke-host",
        }),
      )
    })
    hostWs.on("message", (data) => {
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return
      }
      if (frame.t === "hello-ok") return resolve(frame)
      if (frame.t === "hello-deny") return reject(new Error(`hello denied: ${frame.reason}`))
      if (frame.t === "data-req") {
        received.push(frame)
        const resp = responder.reply ? responder.reply(frame) : null
        if (resp !== null && resp !== undefined) {
          // 回显 relay 铸造的 id/kind；id 从收到的 data-req 读取，不臆造。
          hostWs.send(JSON.stringify({ t: "data-res", id: frame.id, kind: frame.kind, ...resp }))
        }
      }
      // peer / ping 等其余帧忽略
    })
  })

  // 采集器断言：握手失败属 harness 问题，不归 data 面。
  assert.ok(helloOk.pair, "hello-ok 携带 pair")
  assert.equal(helloOk.pair.code.length, 6, "pair.code 为 6 位")

  const pairRes = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: helloOk.pair.code }),
  })
  const pairJson = await pairRes.json()
  assert.equal(pairRes.status, 200, "/pair 返回 200")
  assert.equal(pairJson.ok, true, "/pair ok")
  assert.equal(pairJson.deviceId, deviceId, "/pair 回显 deviceId")
  const cookie = pairRes.headers.get("set-cookie").split(";")[0]
  assert.ok(cookie.length > 0, "/pair 下发会话 cookie")

  return { relay, base, deviceId, hostWs, received, responder, cookie }
}

/** data 面请求：带兜底超时，超时即明确断言失败，避免旧反代路径挂死。 */
async function apiFetch(base, method, path, opts = {}) {
  const { cookie, json, timeoutMs = REQ_TIMEOUT_MS } = opts
  const signal = AbortSignal.timeout(timeoutMs)
  const headers = {}
  if (cookie !== undefined) headers.cookie = cookie
  if (json !== undefined) headers["content-type"] = "application/json"
  try {
    return await fetch(`${base}${path}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal,
    })
  } catch (err) {
    assert.fail(`${method} ${path} 未在 ${timeoutMs}ms 内完成（/api 路由未实现？）：${String(err)}`)
  }
}

/** 解析 JSON 响应体；非 JSON 返回 null。 */
async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 三套采集器

// 主体：host 在线，多数用例用；responder.reply 按用例临时改写。
const main = await spinUp()
// 离线用例：注册 → 配对 → 断开 host，让「手机已配对但 host 不在线」。
const offline = await spinUp()
const offlineClosed = new Promise((resolve) => offline.hostWs.once("close", resolve))
offline.hostWs.close()
await offlineClosed
// 超时用例：dataTimeoutMs=500，host 已注册但保持静默（不回 data-res）。
const timing = await spinUp({ relayOpts: { dataTimeoutMs: 500 } })

// ------------------------------------------------------------------ 9 个用例

test("1. 未配对 GET / → 200 落地页，不含 dsh-mobile-app 标记", async () => {
  const res = await apiFetch(main.base, "GET", "/")
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.equal(body.includes('id="dsh-mobile-app"'), false)
})

test("2. 已配对 GET /（带 cookie）→ 200 移动端页面，含 dsh-mobile-app 标记", async () => {
  const res = await apiFetch(main.base, "GET", "/", { cookie: main.cookie })
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.equal(body.includes('id="dsh-mobile-app"'), true)
})

test("3. GET /api/sessions → data-req{kind:'conversation'} 无 sessionId → 200 {ok:true,data}", async () => {
  main.received.length = 0
  main.responder.reply = () => ({ ok: true, data: { items: [] } })
  const res = await apiFetch(main.base, "GET", "/api/sessions", { cookie: main.cookie })
  assert.equal(res.status, 200)
  assert.deepEqual(await readJson(res), { ok: true, data: { items: [] } })
  assert.equal(main.received.length, 1, "host 收到 1 条 data-req")
  const req = main.received[0]
  assert.equal(req.t, "data-req")
  assert.equal(req.kind, "conversation")
  assert.equal("sessionId" in req, false, "conversation 不带 sessionId 字段")
})

test("4. POST /api/message → data-req{kind:'send-message',sessionId,content} → 200 {ok:true}", async () => {
  main.received.length = 0
  main.responder.reply = () => ({ ok: true })
  const res = await apiFetch(main.base, "POST", "/api/message", {
    cookie: main.cookie,
    json: { sessionId: "s1", text: "hi" },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await readJson(res), { ok: true })
  assert.equal(main.received.length, 1, "host 收到 1 条 data-req")
  const req = main.received[0]
  assert.equal(req.t, "data-req")
  assert.equal(req.kind, "send-message")
  assert.equal(req.sessionId, "s1")
  assert.equal(req.content, "hi")
})

test("4b. POST /api/session/create → data-req{kind:'conversation-create',workspaceId} → 200 {ok:true,data:{sessionId}}", async () => {
  main.received.length = 0
  main.responder.reply = () => ({ ok: true, data: { sessionId: "s-new", agentPreset: "p1" } })
  const res = await apiFetch(main.base, "POST", "/api/session/create", {
    cookie: main.cookie,
    json: { workspaceId: "ws1" },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await readJson(res), {
    ok: true,
    data: { sessionId: "s-new", agentPreset: "p1" },
  })
  assert.equal(main.received.length, 1, "host 收到 1 条 data-req")
  const req = main.received[0]
  assert.equal(req.t, "data-req")
  assert.equal(req.kind, "conversation-create")
  assert.equal(req.workspaceId, "ws1")
  // conversation-create 不应携带 sessionId / path / content 字段
  assert.equal("sessionId" in req, false, "conversation-create 不带 sessionId 字段")
  assert.equal("path" in req, false, "conversation-create 不带 path 字段")
  assert.equal("content" in req, false, "conversation-create 不带 content 字段")
})

test("4c. POST /api/session/create 无 workspaceId → 400", async () => {
  main.received.length = 0
  main.responder.reply = () => ({ ok: true })
  const res = await apiFetch(main.base, "POST", "/api/session/create", {
    cookie: main.cookie,
    json: {},
  })
  assert.equal(res.status, 400)
  const body = await readJson(res)
  assert.equal(body.ok, false)
  assert.equal(main.received.length, 0, "host 不应收到 data-req（参数校验在 relay 侧）")
})

test("4d. POST /api/session/create host 离线 → 503", async () => {
  const res = await apiFetch(offline.base, "POST", "/api/session/create", {
    cookie: offline.cookie,
    json: { workspaceId: "ws1" },
  })
  assert.equal(res.status, 503)
  const body = await readJson(res)
  assert.equal(body.ok, false)
  assert.ok(body.error.length > 0, "503 携带非空 error")
})

test("4e. GET /api/session/pending?sessionId=s1 → data-req{kind:'conversation-pending',sessionId} → 200 {ok:true,data:[]}", async () => {
  main.received.length = 0
  main.responder.reply = () => ({ ok: true, data: [] })
  const res = await apiFetch(main.base, "GET", "/api/session/pending?sessionId=s1", {
    cookie: main.cookie,
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await readJson(res), { ok: true, data: [] })
  assert.equal(main.received.length, 1, "host 收到 1 条 data-req")
  const req = main.received[0]
  assert.equal(req.t, "data-req")
  assert.equal(req.kind, "conversation-pending")
  assert.equal(req.sessionId, "s1")
})

test("4f. POST /api/session/respond {eventId,response} → data-req{kind:'conversation-respond',eventId,content} → 200 {ok:true}", async () => {
  main.received.length = 0
  main.responder.reply = () => ({ ok: true })
  const res = await apiFetch(main.base, "POST", "/api/session/respond", {
    cookie: main.cookie,
    json: { eventId: "evt1", response: "allowed-once" },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await readJson(res), { ok: true })
  assert.equal(main.received.length, 1, "host 收到 1 条 data-req")
  const req = main.received[0]
  assert.equal(req.t, "data-req")
  assert.equal(req.kind, "conversation-respond")
  assert.equal(req.eventId, "evt1")
  // response is JSON-stringified by the relay into content
  assert.equal(req.content, '"allowed-once"')
})

test("4g. POST /api/session/respond 无 eventId → 400", async () => {
  main.received.length = 0
  const res = await apiFetch(main.base, "POST", "/api/session/respond", {
    cookie: main.cookie,
    json: { response: "allowed-once" },
  })
  assert.equal(res.status, 400)
  assert.equal(main.received.length, 0, "host 不应收到 data-req")
})

test("5. GET /api/file?path=/a/b → data-req{kind:'file-read',path} → 200 {ok:true,data:'file body'}", async () => {
  main.received.length = 0
  main.responder.reply = () => ({ ok: true, data: "file body" })
  const res = await apiFetch(main.base, "GET", "/api/file?path=/a/b", { cookie: main.cookie })
  assert.equal(res.status, 200)
  assert.deepEqual(await readJson(res), { ok: true, data: "file body" })
  assert.equal(main.received.length, 1, "host 收到 1 条 data-req")
  const req = main.received[0]
  assert.equal(req.t, "data-req")
  assert.equal(req.kind, "file-read")
  assert.equal(req.path, "/a/b")
})

test("6. host 回 data-res{ok:false,error} → 502 {ok:false,error}", async () => {
  main.received.length = 0
  main.responder.reply = () => ({ ok: false, error: "boom" })
  const res = await apiFetch(main.base, "GET", "/api/sessions", { cookie: main.cookie })
  assert.equal(res.status, 502)
  const body = await readJson(res)
  assert.equal(body.ok, false)
  assert.equal(body.error, "boom")
})

test("7. 未携带 cookie GET /api/sessions → 401", async () => {
  const res = await apiFetch(main.base, "GET", "/api/sessions")
  assert.equal(res.status, 401)
})

test("8. host 离线 GET /api/sessions → 503", async () => {
  const res = await apiFetch(offline.base, "GET", "/api/sessions", { cookie: offline.cookie })
  assert.equal(res.status, 503)
  const body = await readJson(res)
  assert.equal(body.ok, false)
  assert.equal(typeof body.error, "string")
  assert.ok(body.error.length > 0, "503 携带非空 error")
})

test("9. host 收到 data-req 但静默 → 504 超时", async () => {
  // timing.responder.reply 保持 null：收到 data-req 不回 data-res。
  const res = await apiFetch(timing.base, "GET", "/api/sessions", {
    cookie: timing.cookie,
    timeoutMs: 3000,
  })
  assert.equal(res.status, 504)
  const body = await readJson(res)
  assert.equal(body.ok, false)
  assert.equal(typeof body.error, "string")
  assert.ok(body.error.length > 0, "504 携带非空 error")
  assert.equal(timing.received.length, 1, "host 收到 1 条 data-req 且未回")
  assert.equal(timing.received[0].kind, "conversation")
})

test("teardown", async () => {
  await main.relay.close()
  await offline.relay.close()
  await timing.relay.close()
})
