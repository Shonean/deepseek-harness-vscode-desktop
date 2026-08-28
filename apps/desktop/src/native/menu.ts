/**
 * Pure application-menu template for the desktop shell. Kept free of Electron
 * imports so the menu contract is unit-testable; `main.ts` builds a `Menu`
 * from it at startup.
 * @module native/menu
 */
import type { MenuItemConstructorOptions } from 'electron'

/**
 * The menu template: standard role menus in the platform-expected order. The
 * macOS app menu carries the app name and standard About/Quit; every other
 * platform leads with File. App-specific actions (new session, open chat)
 * layer on later — D2 ships the native-chrome baseline.
 * @param platform - overridable for tests; defaults to the current platform.
 * @returns the template passed to `Menu.buildFromTemplate`.
 */
export function buildAppMenuTemplate(
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const first: MenuItemConstructorOptions = platform === 'darwin'
    ? { role: 'appMenu' }
    : { role: 'fileMenu' }
  return [
    first,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ role: 'about' }] },
  ]
}
