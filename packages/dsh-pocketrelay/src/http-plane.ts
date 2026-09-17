/**
 * dsh-pocketrelay — HTTP reverse-proxy plane (PROTOCOL §5), host side.
 *
 * Relay frames (`http-req/http-body/http-body-end/http-abort`) become a real
 * request against the local dsh web server; the response streams back as
 * `http-head/http-body/http-body-end` (or `http-err`). One in-flight request
 * per relay id; chunk order is guaranteed by single-reader consumption, so SSE
 * and blob streams survive untouched.
 */
import {
  type Frame,
  HTTP_CHUNK_BYTES,
  type HttpAbortFrame,
  type HttpBodyEndFrame,
  type HttpBodyFrame,
  type HttpReqFrame,
  T,
} from "@dsh-pocketrelay/protocol"
import { injectMobileShim } from "./mobile-shim.js"
import { assertNever } from "./parse.js"
import type { UpstreamCookieAuth } from "./upstream-auth.js"

export type Send = (frame: Frame) => void

type HttpFrame = HttpReqFrame | HttpBodyFrame | HttpBodyEndFrame | HttpAbortFrame

const REQUEST_FORBIDDEN = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  // `host` is rebuilt from the local origin; content-length from the body.
  "host",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  // Browser-trust attestation must not leak to the local dsh server — its /api
  // fence requires Origin to equal Host, which can never hold for a phone page.
  // Strip the markers so the upstream request reads as the identical loopback
  // client it actually is.
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "referer",
])

const RESPONSE_FORBIDDEN = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  // fetch transparently decodes gzip/deflate/br; forwarding the original
  // content-encoding with already-decoded bytes would double-decode.
  "content-encoding",
])

interface Pending {
  id: number
  method: string
  path: string
  query: string
  headers: Record<string, string>
  chunks: Buffer[]
  started: boolean
  controller: AbortController | undefined
}

export interface HttpPlaneOptions {
  origin: () => string
  log: (message: string) => void
  send: Send
  auth?: UpstreamCookieAuth
}

export class HttpPlane {
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly options: HttpPlaneOptions) {}

  handle(frame: HttpFrame): void {
    const id = frame.id
    switch (frame.t) {
      case T.HTTP_REQ: {
        if (this.pending.has(id)) return
        const next: Pending = {
          id,
          method: frame.method,
          path: frame.path,
          query: frame.query,
          headers: frame.headers ?? {},
          chunks: [],
          started: false,
          controller: undefined,
        }
        if (frame.bodyBase64 !== null && frame.bodyBase64 !== "") {
          next.chunks.push(Buffer.from(frame.bodyBase64, "base64"))
        }
        this.pending.set(id, next)
        return
      }
      case T.HTTP_BODY: {
        const next = this.pending.get(id)
        if (next === undefined || next.started) return
        next.chunks.push(Buffer.from(frame.dataBase64, "base64"))
        return
      }
      case T.HTTP_END: {
        const next = this.pending.get(id)
        if (next === undefined || next.started) return
        next.started = true
        void this.run(next)
        return
      }
      case T.HTTP_ABORT: {
        const next = this.pending.get(id)
        if (next === undefined) return
        this.pending.delete(id)
        if (next.controller !== undefined) {
          try {
            next.controller.abort()
          } catch {
            // already aborted
          }
        }
        return
      }
      default:
        assertNever(frame)
    }
  }

  private async run(next: Pending): Promise<void> {
    try {
      await this.perform(next)
    } catch (error) {
      const aborted = next.controller?.signal.aborted === true
      this.pending.delete(next.id)
      if (aborted) return // phone is gone — nothing to answer
      this.options.log(`upstream request ${next.id} failed: ${(error as Error).message}`)
      this.options.send({
        t: T.HTTP_ERR,
        id: next.id,
        code: "UPSTREAM_DOWN",
        message: (error as Error).message,
      })
    }
  }

  private async fetchUpstream(next: Pending, signal: AbortSignal): Promise<Response> {
    const hasBody = next.method !== "GET" && next.method !== "HEAD"
    const body = hasBody
      ? next.chunks.length === 0
        ? undefined
        : Buffer.concat(next.chunks)
      : undefined

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(next.headers)) {
      const lower = key.toLowerCase()
      if (REQUEST_FORBIDDEN.has(lower)) continue
      headers[lower] = value
    }
    headers["accept-encoding"] = "identity"
    headers["x-dsh-pocketrelay"] = "host"
    if (this.options.auth !== undefined) {
      const cookie = this.options.auth.cookie()
      if (cookie !== undefined) headers["cookie"] = cookie
    }

    const init: RequestInit = {
      method: next.method,
      headers,
      signal,
      redirect: "manual",
    }
    if (body !== undefined) init.body = body
    return fetch(this.options.origin() + next.path + next.query, init)
  }

  private async perform(next: Pending): Promise<void> {
    const controller = new AbortController()
    next.controller = controller

    let response = await this.fetchUpstream(next, controller.signal)
    if (response.status === 401 && this.options.auth !== undefined) {
      this.options.auth.refresh()
      try {
        await response.body?.cancel()
      } catch {
        // stream already consumed
      }
      response = await this.fetchUpstream(next, controller.signal)
    }

    this.options.log("fetch id=" + next.id + " status=" + response.status + " ct=" + (response.headers.get("content-type") ?? ""))
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (RESPONSE_FORBIDDEN.has(lower)) return
      responseHeaders[lower] = value
    })
    this.options.send({
      t: T.HTTP_HEAD,
      id: next.id,
      status: response.status,
      headers: responseHeaders,
    })

    if (response.body === null) {
      this.pending.delete(next.id)
      this.options.send({ t: T.HTTP_END, id: next.id })
      return
    }

    if ((responseHeaders["content-type"] ?? "").includes("text/html")) {
      await this.streamHtml(next, response.body)
      return
    }

    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > 0) this.sendBuffered(next, Buffer.from(value))
    }
    this.pending.delete(next.id)
    this.options.send({ t: T.HTTP_END, id: next.id })
  }

  private sendBuffered(next: Pending, body: Buffer): void {
    for (let offset = 0; offset < body.byteLength; offset += HTTP_CHUNK_BYTES) {
      const piece = body.subarray(offset, offset + HTTP_CHUNK_BYTES)
      this.options.send({ t: T.HTTP_CHUNK, id: next.id, dataBase64: piece.toString("base64") })
    }
  }

  /**
   * Buffered send for the app shell: every text/html response is the SPA
   * index, small and static, so the whole body is read and the mobile shim
   * (viewport fix + responsive stylesheet) is injected before it streams out.
   * Only tunnel traffic crosses this plane, so the shim never touches desktop.
   */
  private async streamHtml(next: Pending, stream: ReadableStream<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > 0) chunks.push(value)
    }
    const html = injectMobileShim(Buffer.concat(chunks).toString("utf8"))
    this.sendBuffered(next, Buffer.from(html, "utf8"))
    this.pending.delete(next.id)
    this.options.send({ t: T.HTTP_END, id: next.id })
  }
}
