/**
 * dsh-pocketrelay browser half: registers the "手机连接" settings section
 * (`settings.section` slot) and renders the RemoteSection React tab.
 */
import type { Context } from "@deepseek-ai/cordis"
import { RemoteSection } from "./RemoteSection.js"

/** Client services the fiber waits for before apply (`ctx.slots` requires inject). */
export const inject = ["slots"]

export function apply(ctx: Context): void {
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "pocketrelay",
        order: 300,
        label: "手机连接",
      },
      RemoteSection,
    ),
  )
}
