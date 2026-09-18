/**
 * Ambient declarations for the `@deepseek-ai/*` modules the plugin imports.
 *
 * The harness ships these as bundled ESM without per-package `.d.ts` reachable
 * from this package (the CLI peer `@deepseek-ai/dsh` exposes no `types`), so
 * the plugin's strict `tsc --noEmit` needs this minimal contract. Everything
 * here mirrors the real runtime surface the plugin drives; the plugin keeps
 * its own typed views of untyped services (e.g. `ctx.get("connection")`) and
 * narrows those at the boundary instead of widening these stubs.
 */
declare module "@deepseek-ai/cordis" {
  export interface Logger {
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
    debug(message: string, ...args: unknown[]): void
  }

  /** Owner props handed to a settings-section component by the shell. */
  export interface SettingsSectionOwnerProps {
    readonly close: () => void
  }

  /** A settings-section render component. */
  export type SlotComponent = (props: SettingsSectionOwnerProps) => unknown

  export interface SlotRegistration {
    readonly name: string
    readonly id: string
    readonly order?: number
    readonly label?: string
  }

  export interface SlotRegistry {
    inject(key: string, callback: () => undefined | (() => void)): () => void
    register(registration: SlotRegistration, component: SlotComponent): () => void
  }

  export interface Context {
    logger(name: string): Logger
    get(name: string): unknown
    inject(deps: readonly string[], callback: (ctx: Context) => void): unknown
    effect(body: () => undefined | (() => void), label?: string): () => void
    webServer: import("@deepseek-ai/dsh-host-webserver").WebServer
    slots: SlotRegistry
    /**
     * DIAGNOSTIC (0.2.2): dsh may expose these as direct ctx properties rather than
     * injectable services. Probed at runtime in apply(); narrowed in data-plane.ts.
     */
    apiProxy?: unknown
    fs?: unknown
  }
}

declare module "@deepseek-ai/schemastery" {
  /** Schemastery schema node (value surface used by the plugin config). */
  export interface Schema<S = unknown> {
    default(value: S): Schema<S>
    required(): Schema<S>
    optional(): Schema<S>
  }

  /** Schema factory shape: the subset of `z` used to build the plugin Config. */
  export interface SchemaFactory {
    string(): Schema<string>
    boolean(): Schema<boolean>
    object<S extends Record<string, Schema>>(shape: S): Schema<S>
  }

  const z: SchemaFactory
  // biome-ignore lint/style/noDefaultExport: mirrors schemastery's real ESM default export so `import z from` resolves identically at runtime
  export default z
}

declare module "@deepseek-ai/dsh-home-paths" {
  export function resolveDshHome(
    configured?: string,
    env?: Record<string, string | undefined>,
  ): string
}

declare module "@deepseek-ai/dsh-host-webserver" {
  import type { IncomingMessage, ServerResponse } from "node:http"

  export type WebRouteKind = "exact" | "prefix"

  export interface WebRoute {
    readonly kind: WebRouteKind
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void
  }

  export interface WebServer {
    readonly port: number
    readonly host: "127.0.0.1" | "0.0.0.0"
    register(route: WebRoute): () => void
  }
}
