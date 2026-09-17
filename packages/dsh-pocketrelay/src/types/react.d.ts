/**
 * Minimal ambient declarations for React and its automatic JSX runtime.
 *
 * `react` and `@types/react` are not on this package's node_modules
 * resolution path (the harness client shell provides them at runtime, but the
 * plugin's own typecheck cannot see them). This file declares only the hooks,
 * element types, and intrinsic-element surface the client settings tab uses.
 * The declared shapes are a structural subset of React 18's public types.
 */
declare namespace React {
  type ReactNode = unknown

  interface ReactElement {
    readonly type: unknown
    readonly props: unknown
    readonly key: unknown
  }
}

declare module "react" {
  export type ReactNode = React.ReactNode
  export interface ReactElement extends React.ReactElement {}
  export type ComponentType<P = unknown> = (props: P) => ReactElement | null
  export type SetStateAction<S> = S | ((prevState: S) => S)
  export type Dispatch<A> = (value: A) => void

  export function useState<S>(
    initialState: S | (() => S),
  ): readonly [S, Dispatch<SetStateAction<S>>]
  export function useEffect(effect: () => undefined | (() => void), deps?: readonly unknown[]): void
  export function useRef<T>(initialValue: T): { current: T }
  export function useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
  ): T
}

declare module "react/jsx-runtime" {
  export function jsx(type: unknown, props: unknown, key?: unknown): React.ReactElement
  export function jsxs(type: unknown, props: unknown, key?: unknown): React.ReactElement
  export const Fragment: (props: { readonly children?: unknown }) => React.ReactElement
}

/** DOM input event shape needed by the settings form's text/checkbox handlers. */
interface InputEventLike {
  readonly target: { readonly value: string; readonly checked: boolean }
}

/** Permissive props for every intrinsic element (enough for the settings form). */
interface IntrinsicElementProps {
  readonly children?: unknown
  readonly style?: Readonly<Record<string, string | number | undefined>>
  readonly onBlur?: (event: InputEventLike) => void
  readonly onChange?: (event: InputEventLike) => void
  readonly onClick?: (event: unknown) => void
  readonly [attribute: string]: unknown
}

declare namespace JSX {
  type Element = React.ReactElement
  interface IntrinsicElements {
    [element: string]: IntrinsicElementProps
  }
}
