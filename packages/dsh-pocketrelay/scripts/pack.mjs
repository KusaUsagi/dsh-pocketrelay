/**
 * Pack the bundle without dev tooling: consumers only need the built `lib/`
 * (server entry + wrapped client bundle) plus the patch and docs. Adapted from
 * JochenYang/dsh-remote.
 */
import { execSync } from "node:child_process"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const staging = join(pkgDir, ".pack-staging")

execSync("pnpm run build", { cwd: pkgDir, stdio: "inherit" })
execSync("pnpm run build:client", { cwd: pkgDir, stdio: "inherit" })

const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"))

// Bundled workspace deps (e.g. @dsh-pocketrelay/protocol) are inlined into
// lib/ by esbuild, so they must not become runtime dependencies of the packed
// plugin — a `workspace:` spec would fail `dsh plugin add` outside a workspace.
const dependencies = Object.fromEntries(
  Object.entries(pkg.dependencies ?? {}).filter(
    ([, spec]) => !String(spec).startsWith("workspace:"),
  ),
)

const shipped = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: pkg.type,
  main: pkg.main,
  files: pkg.files,
  exports: pkg.exports,
  license: pkg.license,
  engines: pkg.engines ?? {},
  dependencies,
  peerDependencies: pkg.peerDependencies ?? {},
  peerDependenciesMeta: pkg.peerDependenciesMeta ?? {},
  dsh: pkg.dsh,
}

await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
await writeFile(join(staging, "package.json"), `${JSON.stringify(shipped, null, 2)}\n`)
await cp(join(pkgDir, "lib"), join(staging, "lib"), { recursive: true })
await cp(join(pkgDir, "cordis.patch.yml"), join(staging, "cordis.patch.yml"))
await cp(join(pkgDir, "README.md"), join(staging, "README.md"))
await cp(join(pkgDir, "LICENSE"), join(staging, "LICENSE"))
execSync("pnpm pack --pack-destination ..", { cwd: staging, stdio: "inherit" })
await rm(staging, { recursive: true, force: true })
