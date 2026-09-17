import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import selfsigned from "selfsigned"
import { TLS_DIR } from "./const.js"

export interface TlsPem {
  cert: string
  key: string
}

/**
 * 加载或生成自签 TLS 证书。
 * 优先级：显式 cert/key > dataDir/tls 缓存 > selfsigned 生成并缓存。
 */
export async function loadOrCreateTls(
  dataDir: string,
  certPath?: string,
  keyPath?: string,
): Promise<TlsPem> {
  if (certPath !== undefined && keyPath !== undefined) {
    return { cert: await readFile(certPath, "utf8"), key: await readFile(keyPath, "utf8") }
  }
  const dir = join(dataDir, TLS_DIR)
  const certFile = join(dir, "cert.pem")
  const keyFile = join(dir, "key.pem")
  if (existsSync(certFile) && existsSync(keyFile)) {
    return { cert: await readFile(certFile, "utf8"), key: await readFile(keyFile, "utf8") }
  }
  const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    keySize: 2048,
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ],
  })
  await mkdir(dir, { recursive: true })
  await writeFile(certFile, pems.cert, "utf8")
  await writeFile(keyFile, pems.private, "utf8")
  return { cert: pems.cert, key: pems.private }
}
