/**
 * The Electron main process: native window, privileged custom-scheme asset
 * protocol, kernel `utilityProcess` supervision with automatic restart, and
 * the renderer-facing MessagePort carrier. The renderer loads the built web
 * SPA over `dsh-assets://root/` (never `file://`, never a remote URL), so a
 * packaged app serves a strict CSP with no network reachability; the SPA's API
 * traffic rides the MessagePort carrier into the main process, which relays it
 * to the kernel child's loopback URL.
 *
 * D2 native chrome lives here: application menu, tray, `dsh://` deep links,
 * and turn-end notifications. The kernel is supervised: an unexpected exit
 * respawns it, rewires the carrier, and reloads the window so the SPA
 * reconnects over the same generation/reconnect machine.
 * @module main
 */
// The kernel's web profile serves a CSP with 'unsafe-eval' (the SPA needs it);
// Electron's renderer_init logs an Insecure-Content-Security-Policy warning
// for that in dev. Set before any window is created so every renderer process
// inherits it; packaged builds do not print the warning regardless.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app, BrowserWindow, Menu, MessageChannelMain, Notification, Tray,
  protocol, utilityProcess, type UtilityProcess,
} from 'electron'
import { attachMessagePortTunnel } from './carrier/tunnel.ts'
import { buildRendererHtml, rendererCsp, sessionSeedScript } from './renderer/index.ts'
import {
  ASSET_HOST,
  ASSET_ORIGIN,
  ASSET_SCHEME,
  TRANSPORT_PATH,
  isIndexUrl,
  mimeTypeFor,
  resolveAssetPathname,
} from './renderer/protocol.ts'
import { buildAppMenuTemplate } from './native/menu.ts'
import { parseDeepLink } from './native/deeplink.ts'
import { watchTurnEnd } from './native/notifications.ts'

/** Options controlling one desktop window. */
export interface DesktopWindowOptions {
  /** Workspace folder the kernel runs in; defaults to the user's home directory. */
  cwd?: string
  /** Optional session id to seed the SPA's persisted selection with on first load. */
  sessionId?: string
}

/** Resolve the built frontend `dist/index.html` through the workspace `node_modules`. */
function resolveDistIndex(): string {
  const nodeRequire = createRequire(import.meta.url)
  return nodeRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
}

/**
 * Register the privileged custom scheme before app ready. Privileged schemes
 * are treated like `https`: service workers, fetch, CORS, and the CSP `'self'`
 * source all work; without this the SPA's module graph cannot load.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  }])
}

/**
 * Map a custom-scheme request path to a filesystem path under the frontend
 * dist root, or to the renderer-transport IIFE in this app's build directory.
 * Re-exported for callers that only need the path resolver without Electron.
 */
export { resolveAssetPathname } from './renderer/protocol.ts'

/**
 * Build the document the custom-scheme root serves: the dist index with the
 * renderer CSP and the transport IIFE injected directly after `<head>`. Root-
 * relative asset URLs resolve naturally under the same origin, so they need no
 * rewriting.
 * @param distIndex - absolute path of the frontend `dist/index.html`.
 * @param sessionId - optional session id to seed the SPA selection.
 * @returns the final renderer HTML.
 */
export async function buildIndexDocument(
  distIndex: string,
  sessionId?: string,
): Promise<string> {
  const source = await readFile(distIndex, 'utf8')
  const seed = sessionId === undefined ? '' : sessionSeedScript(sessionId)
  return buildRendererHtml(source, rendererCsp(ASSET_ORIGIN), TRANSPORT_PATH, seed)
}

/**
 * Install the `dsh-assets://` protocol handler. One handler serves the SPA
 * document (with CSP + transport injection) at `/` and `/index.html`, the
 * renderer-transport IIFE at its reserved path, and every other static asset
 * straight from the frontend dist.
 * @param distRoot - absolute path of the built frontend dist.
 * @param distIndex - absolute path of the frontend `dist/index.html`.
 * @param appBuildDir - absolute path of this app's `dist` build output.
 * @param sessionId - optional session id seeded into the document.
 */
export function installAssetProtocol(
  distRoot: string,
  distIndex: string,
  appBuildDir: string,
  sessionId?: string,
): void {
  let indexHtmlPromise: Promise<string> | undefined
  const indexHtml = (): Promise<string> => {
    if (indexHtmlPromise === undefined) indexHtmlPromise = buildIndexDocument(distIndex, sessionId)
    return indexHtmlPromise
  }
  protocol.handle(ASSET_SCHEME, async (request: { url: string }) => {
    if (isIndexUrl(request.url)) {
      const html = await indexHtml()
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (parsed.host !== ASSET_HOST) return new Response('not found', { status: 404 })
    const pathname = decodeURIComponent(parsed.pathname)
    const file = resolveAssetPathname(pathname, distRoot, appBuildDir)
    if (file === undefined) return new Response('not found', { status: 404 })
    try {
      const data = await readFile(file)
      return new Response(data, {
        status: 200,
        headers: { 'content-type': mimeTypeFor(file) },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

/** Locate this app's `dist` build directory from the compiled main entry. */
function resolveAppBuildDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** localStorage key the SPA reads to restore its current session on boot. */
const SESSION_SELECTION_KEY = 'dsh.sessions.current'

/**
 * Owns the kernel `utilityProcess` and restarts it on unexpected exit. Boot
 * failures (the host reports an error, or the process dies before the ready
 * message) surface through {@link onStartFailure} and stop; runtime crashes
 * respawn the kernel and re-report the new loopback URL through
 * {@link onReady} with a fresh generation number.
 */
class KernelSupervisor {
  private kernel: UtilityProcess | undefined
  private stopped = false
  private ready = false
  private generation = 0

  constructor(
    private readonly entryPath: string,
    private readonly cwd: string,
    private readonly onReady: (baseUrl: string, generation: number) => void,
    private readonly onStartFailure: (error: Error) => void,
  ) {}

  /** Fork the first kernel generation. */
  start(): void {
    this.spawn()
  }

  /** Kill the current kernel and stop all supervision. */
  stop(): void {
    this.stopped = true
    this.kernel?.kill()
    this.kernel = undefined
  }

  private spawn(): void {
    const kernel = utilityProcess.fork(this.entryPath, [this.cwd], {
      stdio: 'pipe',
      serviceName: 'dsh-desktop-kernel',
    })
    this.kernel = kernel
    this.ready = false
    const timer = setTimeout(() => {
      this.fail(new Error('desktop kernel did not report its URL within 120s'))
    }, 120_000)

    kernel.on('message', (message: unknown) => {
      const frame = message as { type?: unknown; baseUrl?: unknown; error?: unknown }
      if (frame.type === 'dsh.kernel.ready' && typeof frame.baseUrl === 'string') {
        clearTimeout(timer)
        this.ready = true
        this.onReady(frame.baseUrl, this.generation)
      } else if (frame.type === 'dsh.kernel.exit' && typeof frame.error === 'string') {
        clearTimeout(timer)
        this.fail(new Error(`desktop kernel failed to start: ${frame.error}`))
      } else if (frame.type === 'dsh.kernel.exit') {
        // The dsh kernel child exited at runtime; the host reported it. This is
        // a crash — restart the whole generation.
        clearTimeout(timer)
        this.restart()
      }
    })

    kernel.on('exit', () => {
      clearTimeout(timer)
      if (this.stopped || this.kernel !== kernel) return
      if (this.ready) this.restart()
      else this.fail(new Error('desktop kernel exited before reporting its URL'))
    })
  }

  private restart(): void {
    if (this.stopped) return
    this.kernel?.kill()
    this.kernel = undefined
    this.generation += 1
    this.spawn()
  }

  private fail(error: Error): void {
    if (this.stopped) return
    this.onStartFailure(error)
    this.kernel?.kill()
    this.kernel = undefined
  }
}

/** The shell's live surfaces, rewired per kernel generation. */
interface ShellState {
  window: BrowserWindow
  distRoot: string
  distIndex: string
  appBuildDir: string
  baseUrl: string | undefined
  generation: number
  pendingSessionId: string | undefined
  disposeTunnel: () => void
  stopNotifier: () => void
}

/**
 * Rewire the notification stream to a new kernel generation, then reload the
 * window so the SPA reconnects. A stale `onReady` (from a generation that has
 * since been superseded) is ignored.
 *
 * The renderer loads the kernel's web profile directly (`baseUrl + '/'`) rather
 * than the local SPA dist: the kernel's response already contains the boot
 * facade (`window.__ModuleLoader__`), the parser-blocking preloads, and the
 * `window.__DSH_BOOT__` manifest the SPA needs. The carrier/`dsh-port`
 * forwarding below is preserved as dormant infrastructure for the future
 * renderer-network-less architecture (a separate boot-injection pass on the
 * `dsh-assets://` served index).
 */
function rewire(shell: ShellState, baseUrl: string, generation: number): void {
  if (generation !== shell.generation) return
  shell.baseUrl = baseUrl
  shell.disposeTunnel()
  shell.stopNotifier()

  const channel = new MessageChannelMain()
  const tunnel = attachMessagePortTunnel(channel.port1, baseUrl)
  shell.disposeTunnel = () => { tunnel.dispose() }

  const seed = shell.pendingSessionId
  shell.pendingSessionId = undefined
  if (seed !== undefined) {
    void shell.window.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(SESSION_SELECTION_KEY)}, `
      + `${JSON.stringify(JSON.stringify({ sessionId: seed }))});`,
    )
  }

  shell.window.webContents.once('did-finish-load', () => {
    shell.window.webContents.postMessage('dsh-port', null, [channel.port2])
  })
  void shell.window.loadURL(`${baseUrl}/`)

  const controller = new AbortController()
  void watchTurnEnd(baseUrl, () => { notifyTurnEnd() }, controller.signal)
  shell.stopNotifier = () => { controller.abort() }
}

/** Show a turn-end notification, when the platform supports it. */
function notifyTurnEnd(): void {
  if (!Notification.isSupported()) return
  new Notification({ title: 'DeepSeek Harness', body: 'A turn finished.' }).show()
}

/**
 * Create one desktop window and the shell state around it. The window is
 * created immediately; the kernel is forked and the carrier rewired as soon as
 * the first generation reports its loopback URL.
 * @param options - optional cwd and target session.
 * @returns the window and an async disposer.
 */
export function createDesktopWindow(
  options: DesktopWindowOptions = {},
): { window: BrowserWindow; dispose(): void; getBaseUrl(): string | undefined } {
  const cwd = options.cwd ?? app.getPath('home')
  const distIndex = resolveDistIndex()
  const distRoot = dirname(distIndex)
  const appBuildDir = resolveAppBuildDir()
  installAssetProtocol(distRoot, distIndex, appBuildDir, options.sessionId)

  const browserWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: join(appBuildDir, '..', 'media', 'logo.ico'),
    show: false,
    webPreferences: {
      preload: join(appBuildDir, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  browserWindow.once('ready-to-show', () => { browserWindow.show() })
  // Dev convenience: open detached devtools only when explicitly requested.
  // Packaged builds never do; source launches open them on DSH_DESKTOP_DEVTOOLS=1.
  if (!app.isPackaged && process.env.DSH_DESKTOP_DEVTOOLS === '1') {
    browserWindow.webContents.once('did-finish-load', () => { browserWindow.webContents.openDevTools({ mode: 'detach' }) })
  }

  const shell: ShellState = {
    window: browserWindow,
    distRoot,
    distIndex,
    appBuildDir,
    baseUrl: undefined,
    generation: 0,
    pendingSessionId: options.sessionId,
    disposeTunnel: () => undefined,
    stopNotifier: () => undefined,
  }

  const supervisor = new KernelSupervisor(
    join(appBuildDir, 'kernel-entry.js'),
    cwd,
    (baseUrl, generation) => { rewire(shell, baseUrl, generation) },
    (error) => { console.error('desktop kernel failed to start:', error) },
  )
  supervisor.start()

  const dispose = (): void => {
    shell.disposeTunnel()
    shell.stopNotifier()
    supervisor.stop()
    if (!browserWindow.isDestroyed()) browserWindow.destroy()
  }

  browserWindow.on('closed', () => { dispose() })

  return { window: browserWindow, dispose, getBaseUrl: () => shell.baseUrl }
}

/** Focus the window, seeding a session when the deep link references one. */
function focusWithTarget(window: BrowserWindow, sessionId: string | undefined, baseUrl: string | undefined): void {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  if (sessionId !== undefined) {
    void window.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(SESSION_SELECTION_KEY)}, `
      + `${JSON.stringify(JSON.stringify({ sessionId }))});`,
    )
    if (baseUrl !== undefined) void window.loadURL(`${baseUrl}/`)
  }
}

/** Install the tray icon and its toggle/quit menu; best-effort. */
function installTray(iconPath: string, toggle: () => void, quit: () => void): Tray | undefined {
  try {
    const tray = new Tray(iconPath)
    tray.setToolTip('DeepSeek Harness')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show / Hide', click: toggle },
      { type: 'separator' },
      { label: 'Quit', click: quit },
    ]))
    return tray
  } catch {
    return undefined
  }
}

/** Application entry: register schemes, wait for `ready`, open the window. */
export async function main(): Promise<void> {
  registerPrivilegedSchemes()
  await app.whenReady()
  if (process.platform === 'win32') app.setAppUserModelId('ai.deepseek.harness.desktop')

  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate()))

  let desktop = createDesktopWindow()
  let quitting = false

  const quit = (): void => {
    quitting = true
    desktop.dispose()
    app.quit()
  }

  installTray(join(resolveAppBuildDir(), '..', 'media', 'tray.png'), () => {
    const window = desktop.window
    if (window.isVisible()) window.hide()
    else { window.show(); window.focus() }
  }, quit)

  const focusAndRoute = (url: string): void => {
    const target = parseDeepLink(url)
    if (target === undefined) return
    const window = desktop.window
    if (window.isDestroyed()) {
      desktop = createDesktopWindow()
      return
    }
    focusWithTarget(window, target.sessionId, desktop.getBaseUrl())
  }

  if (process.defaultApp && process.argv.length >= 2 && process.argv[1] !== undefined) {
    app.setAsDefaultProtocolClient('dsh', process.execPath, [process.argv[1]])
  } else {
    app.setAsDefaultProtocolClient('dsh')
  }
  app.on('open-url', (event, url) => {
    event.preventDefault()
    focusAndRoute(url)
  })
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(argument => argument.startsWith('dsh://'))
    if (url !== undefined) focusAndRoute(url)
    else if (!desktop.window.isDestroyed()) focusWithTarget(desktop.window, undefined, desktop.getBaseUrl())
  })
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) app.quit()

  app.on('window-all-closed', () => {
    if (quitting) return
    desktop.dispose()
    app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) desktop = createDesktopWindow()
  })
}

void main().catch((error: unknown) => {
  console.error('desktop main failed:', error)
  app.exit(1)
})
