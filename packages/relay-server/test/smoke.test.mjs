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
const DEVICE_ID = randomBytes(16).toString("hex")
const DATA_DIR = join(tmpdir(), `dsh-relay-test-${Date.now()}-${randomBytes(4).toString("hex")}`)

const relay = await createRelay({
  hostToken: HOST_TOKEN,
  port: 0,
  bind: "127.0.0.1",
  dataDir: DATA_DIR,
  adminPassword: "admin",
  log: () => {},
})
const BASE = `https://127.0.0.1:${relay.port}`

test("host 注册 → 手机配对 → /d/ HTTP 转发 + /d/events/ WS 隧道", async () => {
  // 1. host WS 注册，收 hello-ok{pair}
  const hostWs = new WebSocket(`${BASE}/ws?role=host`)
  const helloOk = await new Promise((resolve, reject) => {
    hostWs.addEventListener("error", reject)
    hostWs.addEventListener("open", () => {
      hostWs.send(
        JSON.stringify({
          t: "hello",
          v: 1,
          role: "host",
          deviceId: DEVICE_ID,
          hostToken: HOST_TOKEN,
          hostName: "smoke-host",
        }),
      )
    })
    hostWs.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data)
      if (frame.t === "hello-ok") resolve(frame)
      if (frame.t === "hello-deny") reject(new Error(`denied: ${frame.reason}`))
    })
  })
  assert.ok(helloOk.pair, "hello-ok 携带 pair")
  assert.equal(helloOk.pair.code.length, 6, "pair.code 为 6 位")

  // 2. 手机 POST /pair {code} → cookie
  const code = helloOk.pair.code
  const pairRes = await fetch(`${BASE}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
  const pairJson = await pairRes.json()
  assert.ok(pairJson.ok, "/pair ok")
  assert.equal(pairJson.deviceId, DEVICE_ID)
  const cookie = pairRes.headers.get("set-cookie").split(";")[0]

  // 3. host 作为响应端：http-req → head+chunk+end；ws-open → open-ok + frame
  hostWs.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data)
    if (frame.t === "http-req") {
      hostWs.send(
        JSON.stringify({
          t: "http-head",
          id: frame.id,
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      )
      hostWs.send(
        JSON.stringify({
          t: "http-chunk",
          id: frame.id,
          dataBase64: Buffer.from("hello from host").toString("base64"),
        }),
      )
      hostWs.send(JSON.stringify({ t: "http-end", id: frame.id }))
      return
    }
    if (frame.t === "ws-open") {
      hostWs.send(JSON.stringify({ t: "ws-open-ok", id: frame.id }))
      hostWs.send(
        JSON.stringify({
          t: "ws-frame",
          id: frame.id,
          opcode: 1,
          dataBase64: Buffer.from("ws-hello").toString("base64"),
        }),
      )
    }
  })

  // 4. 手机 GET /d/<deviceId>/api/hello（cookie）→ HTTP 转发
  const dRes = await fetch(`${BASE}/d/${DEVICE_ID}/api/hello`, { headers: { cookie } })
  assert.equal(dRes.status, 200)
  assert.equal(await dRes.text(), "hello from host")

  // 5. 手机 WS /d/<deviceId>/events/mux（cookie）→ WS 隧道：收 host 推来的 ws-frame
  const phoneWs = new WsClient(`${BASE}/d/${DEVICE_ID}/events/mux`, {
    headers: { cookie },
    rejectUnauthorized: false,
  })
  const received = await new Promise((resolve, reject) => {
    phoneWs.on("error", reject)
    phoneWs.on("message", (data) => resolve(data.toString()))
    setTimeout(() => reject(new Error("ws tunnel timeout")), 3000)
  })
  assert.equal(received, "ws-hello", "phone 收到 host 的 ws-frame")
  phoneWs.close()
})

test("teardown", async () => {
  await relay.close()
})
