/**
 * Minimal ambient declarations for the Node built-ins the host plugin uses.
 *
 * The harness's own type tree lives in the pnpm virtual store (not on this
 * package's `node_modules` resolution path), so `tsc --noEmit` cannot see
 * `@types/node`. This file declares only the exact surface the plugin code
 * touches; every typed shape matches Node 22's own API so the same code runs
 * unmodified under the real runtime.
 */

/** Node `Buffer` — the subset used by the http/ws planes and route body reads. */
declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer
  static from(data: Uint8Array): Buffer
  static from(data: ArrayBuffer): Buffer
  static from(data: ArrayBufferView): Buffer
  static concat(chunks: readonly Uint8Array[], totalLength?: number): Buffer
  static isBuffer(value: unknown): value is Buffer
  static byteLength(value: string, encoding?: string): number
  subarray(begin?: number, end?: number): Buffer
  toString(encoding?: string): string
}

declare module "node:crypto" {
  export function randomBytes(size: number): Buffer
}

declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Promise<string | undefined>
  export function readFile(path: string, encoding: "utf8"): Promise<string>
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>
  export function rename(oldPath: string, newPath: string): Promise<void>
}

declare module "node:http" {
  export interface IncomingMessage {
    readonly method?: string
    readonly url?: string
    readonly headers: Record<string, string | string[] | undefined>
    on(event: "data", listener: (chunk: Buffer) => void): this
    on(event: "end", listener: () => void): this
    on(event: "error", listener: (error: Error) => void): this
    destroy(error?: Error): this
  }

  export interface ServerResponse {
    writeHead(
      statusCode: number,
      headers?: Record<string, string | number | readonly string[]>,
    ): this
    setHeader(name: string, value: string | number | readonly string[]): this
    end(data?: string | Uint8Array): this
  }
}

declare module "node:os" {
  export function hostname(): string
}

declare module "node:path" {
  export function join(...segments: string[]): string
}
