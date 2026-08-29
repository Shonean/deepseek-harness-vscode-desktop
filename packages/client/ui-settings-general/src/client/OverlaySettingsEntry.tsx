/**
 * `shell.overlay` occupant for embedded carriers (VSCode panel, desktop
 * shell): the native host owns the session/navigation column, so the sidebar
 * foot never renders and the settings trigger would have no surface. This
 * entry anchors a floating rail gear at the frame's top-right and mounts the
 * same SettingsRoot — the modal panel and the API-key onboarding ride it as
 * fixed viewport layers, so their reachability survives the sidebar's
 * absence. The trigger seat receives `wide: false` (the rail glyph); browser
 * deployments keep the sidebar entry and never register this one.
 */
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsRootInjected } from './shell-contract.ts'
import { SettingsRoot } from './SettingsRoot.tsx'
import css from './SettingsRoot.module.css'

/**
 * Props of the overlay entry: the same four shares as SettingsRoot, but
 * PropsRuntime for `shell.overlay` (root scope, no sidebar `wide` owner prop).
 * The entry passes a fixed `wide: false` so the trigger seat paints the rail
 * glyph.
 */
type OverlaySettingsEntryProps =
  PropsRuntime<'shell.overlay'>
  & PropsRenderSlots<
    | 'settings.trigger'
    | 'settings.header'
    | 'settings.action'
    | 'settings.close'
    | 'settings.section'
    | 'settings.onboarding'
  >
  & InjectFace<SettingsRootInjected>

/**
 * Floating settings entry. The anchor styles only position the trigger —
 * the modal panel renders from the same tree as a fixed full-viewport layer.
 * @param props - root-scope runtime and render-slot shares of the shell.overlay entry.
 * @returns the anchor div containing SettingsRoot in rail-trigger mode.
 */
export function OverlaySettingsEntry(props: OverlaySettingsEntryProps) {
  return (
    <div className={css.overlayEntry}>
      <SettingsRoot {...props} wide={false} />
    </div>
  )
}
