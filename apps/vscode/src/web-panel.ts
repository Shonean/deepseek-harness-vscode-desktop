import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  Uri, ViewColumn, ProgressLocation, ColorThemeKind,
  type ExtensionContext, type WebviewPanel, window,
} from 'vscode'
import { log, logError } from './log.ts'
import type { KernelBroker } from './kernel-broker.ts'
import { attachWebTunnel } from './tunnel.ts'
import {
  buildPanelHtml, inlinePluginScripts, panelCsp, panelProbeScript, pluginCachePath,
  pluginScriptPaths, rewriteIndexUrls, rewritePluginUrls, themeBridgeScript,
  type ThemeBridgeMessage, type VscodeThemeKind,
} from './webview-index.ts'

/**
 * The full-UI chat panel: one editor-area WebviewPanel hosting the real web
 * SPA over the kernel tunnel. The kernel is shared through {@link KernelBroker};
 * the panel owns only the tunnel and its HTML. Closing the panel disposes the
 * tunnel but leaves the kernel running for the sidebar. A target session may be
 * seeded through localStorage so the SPA opens that session on boot.
 * @module web-panel
 */

/** Resolve the built frontend dist index through workspace node_modules. */
function resolveDistIndex(extensionRoot: string): string {
  const nodeRequire = createRequire(join(extensionRoot, 'package.json'))
  return nodeRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
}

/** localStorage key the SPA reads to restore its current session on boot. */
const SESSION_SELECTION_KEY = 'dsh.sessions.current'

/** Map the VSCode color-theme enum to the string kind the bridge script knows. */
function toThemeKind(kind: ColorThemeKind): VscodeThemeKind {
  switch (kind) {
    case ColorThemeKind.Light: return 'light'
    case ColorThemeKind.Dark: return 'dark'
    case ColorThemeKind.HighContrast: return 'hc-dark'
    case ColorThemeKind.HighContrastLight: return 'hc-light'
  }
}

/** Currently open panel, so repeated commands reveal instead of duplicating. */
let panel: WebChatPanel | undefined

/** One inbound webview message, loosely typed (the transport's diagnostic frames). */
interface PanelMessage {
  type?: string
  surface?: string
  message?: string
  stack?: string
  failedScriptSrcs?: string[]
  moduleQueueLength?: number
  queueAtDomContentLoaded?: number
  moduleLoaderType?: string
  registeredIds?: string[]
  phase?: string
  scripts?: Array<{ src: string; loaded: boolean }>
  rootChildren?: number
  rootText?: string
  frameCount?: number
  frameStyle?: string | null
  bodyBg?: string
  bodyColor?: string
  bodyH?: number
  bodyW?: number
  docH?: number
  rootH?: number
  center?: string
  cover?: string[]
  bg?: string
  color?: string
  font?: string
  rootRect?: string
  rootStyle?: string
  sheetsCount?: number
  sheets?: string[]
  errors?: string[]
  active?: string
  vis?: string
  viewport?: string
}

/**
 * In-flight open promise: kernel startup takes seconds, and a second command
 * in that window must join the same open instead of spawning a duplicate
 * panel (the singleton above is only assigned when the open settles).
 */
let opening: Promise<void> | undefined
/** Latest target requested while an open is in flight; navigated after it settles. */
let pendingTarget: string | undefined

/**
 * Open (or reveal) the full-UI chat panel, optionally seeded to one session.
 * Concurrent calls during an in-flight open share one {@link WebChatPanel}
 * creation; the most recent session target wins once it settles.
 * @param context - extension context providing the extension root.
 * @param broker - the shared web kernel broker.
 * @param sessionId - when set, seed the SPA's persisted selection.
 */
export async function openWebChatPanel(
  context: ExtensionContext,
  broker: KernelBroker,
  sessionId?: string,
): Promise<void> {
  if (panel !== undefined) {
    await panel.navigate(sessionId)
    panel.reveal()
    return
  }
  pendingTarget = sessionId
  opening ??= WebChatPanel.open(context, broker, pendingTarget)
    .then(() => {
      if (pendingTarget !== undefined) return panel?.navigate(pendingTarget)
      return undefined
    })
    .finally(() => { opening = undefined })
  await opening
}

/** Close the panel if open; its tunnel is disposed, the shared kernel stays. */
export function closeWebChatPanel(): void {
  panel?.dispose()
}

/**
 * Register the panel serializer VSCode consults when it restores webview
 * panels across a window reload. This panel is host-bound: its tunnel and
 * kernel broker live in the extension host, so a restored orphan panel has no
 * working transport. Disposing it keeps reloads from stacking a stale black
 * tab beside the fresh panel the next `dsh.openChat` creates.
 * @param context - extension context whose subscriptions own the registration.
 */
export function registerChatPanelSerializer(context: ExtensionContext): void {
  context.subscriptions.push(window.registerWebviewPanelSerializer('dsh.chatFull', {
    deserializeWebviewPanel(webviewPanel) {
      log('panel: restored by VSCode reload; disposing the orphan panel')
      webviewPanel.dispose()
      return Promise.resolve()
    },
  }))
}

/**
 * The editor-area panel hosting the real web SPA over the kernel tunnel.
 */
class WebChatPanel {
  private seedSessionId: string | undefined
  private disposeTunnel: () => void = () => undefined

  private constructor(
    private readonly broker: KernelBroker,
    private readonly webviewPanel: WebviewPanel,
    private readonly distRoot: string,
    private readonly pluginRoot: string,
    private readonly extensionPath: string,
    sessionId: string | undefined,
  ) {
    this.seedSessionId = sessionId
  }

  /** Bring the panel to the foreground. */
  reveal(): void {
    this.webviewPanel.reveal()
  }

  /**
   * Switch the panel to a session. The SPA has no runtime navigation seam, so
   * this re-seeds its persisted selection and reloads the document, which
   * restarts the client against the same kernel.
   * @param sessionId - target session, or undefined to leave selection as-is.
   */
  async navigate(sessionId: string | undefined): Promise<void> {
    this.broker.setActiveSession(sessionId)
    if (sessionId === undefined) {
      this.webviewPanel.reveal()
      return
    }
    this.seedSessionId = sessionId
    await this.renderHtml()
  }

  /** Release the panel's resources and clear the singleton. */
  dispose(): void {
    this.webviewPanel.dispose()
  }

  /**
   * Create the panel: ensure the kernel is running, render the SPA index, and
   * attach the tunnel. Startup failures surface as an error with no panel.
   */
  static async open(context: ExtensionContext, broker: KernelBroker, sessionId: string | undefined): Promise<WebChatPanel> {
    const distIndex = resolveDistIndex(context.extensionPath)
    const distRoot = dirname(distIndex)
    const pluginRoot = join(context.globalStorageUri.fsPath, 'kernel-plugins')

    await window.withProgress({
      location: ProgressLocation.Notification,
      title: 'Starting DeepSeek Harness web kernel…',
    }, () => broker.start())

    const webviewPanel = window.createWebviewPanel(
      'dsh.chatFull',
      'DeepSeek Harness',
      { viewColumn: ViewColumn.One, preserveFocus: false },
      {
        enableScripts: true,
        localResourceRoots: [Uri.file(distRoot), Uri.file(context.extensionPath), Uri.file(pluginRoot)],
      },
    )
    webviewPanel.iconPath = {
      light: Uri.file(join(context.extensionPath, 'media', 'logo-pink-light.png')),
      dark: Uri.file(join(context.extensionPath, 'media', 'logo-pink-dark.png')),
    }

    const instance = new WebChatPanel(broker, webviewPanel, distRoot, pluginRoot, context.extensionPath, sessionId)
    broker.setActiveSession(sessionId)

    // The message listener must exist before the page loads: an early script
    // execution error (e.g. the first line of a preload bundle) posts before
    // a listener attached after renderHtml would ever see it.
    const errorSubscription = webviewPanel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = raw as PanelMessage
      if (message.type === 'dsh.webviewError') {
        logError(`webview error (${message.surface ?? 'unknown'})`, message.stack !== undefined ? new Error(`${message.message ?? 'no message'}\n${message.stack}`) : message.message ?? 'no message')
      }
      if (message.type === 'dsh.webviewProbe') {
        const unloaded = (message.scripts ?? []).filter(script => !script.loaded)
        if (message.phase === 'full') {
          log(`panel probe[full]: root=${String(message.rootChildren)}, text=${JSON.stringify(message.rootText ?? '')}, frame=${String(message.frameStyle)}, bg=${String(message.bg)}, color=${String(message.color)}, font=${String(message.font)}, bodyH=${String(message.bodyH)}, docH=${String(message.docH)}, rootH=${String(message.rootH)}, rootRect=${String(message.rootRect)}, rootStyle=${String(message.rootStyle)}, center=${JSON.stringify(message.center ?? '')}, cover=${JSON.stringify(message.cover ?? [])}, sheets=${String(message.sheetsCount)}:${JSON.stringify(message.sheets ?? [])}, errors=${JSON.stringify(message.errors ?? [])}, active=${String(message.active)}, vis=${String(message.vis)}, viewport=${String(message.viewport)}`)
          return
        }
        if (message.phase === 'overlay') {
          log(`panel probe[overlay]: center=${JSON.stringify(message.center ?? '')}, cover=${JSON.stringify(message.cover ?? [])}`)
          return
        }
        if (message.phase === 'dom') {
          log(`panel probe[dom]: rootChildren=${String(message.rootChildren)}, frameCount=${String(message.frameCount)}, frameStyle=${String(message.frameStyle)}, bg=${String(message.bodyBg)}, color=${String(message.bodyColor)}, text=${JSON.stringify(message.rootText ?? '')}, bodyH=${String(message.bodyH)}, bodyW=${String(message.bodyW)}, docH=${String(message.docH)}, rootH=${String(message.rootH)}`)
          return
        }
        log(`panel probe[${message.phase ?? 'settled'}]: moduleLoader=${String(message.moduleLoaderType)}, queue@DCL=${String(message.queueAtDomContentLoaded)}, registered=${JSON.stringify(message.registeredIds ?? null)}, moduleQueue=${String(message.moduleQueueLength)}, scripts=${String((message.scripts ?? []).length)}, failed=${JSON.stringify(message.failedScriptSrcs ?? [])}, unloaded=${JSON.stringify(unloaded.slice(0, 8))}`)
      }
    })
    const tunnel = attachWebTunnel(webviewPanel.webview, broker.baseUrl)
    instance.disposeTunnel = () => { tunnel.dispose() }

    await instance.renderHtml()

    const themeSubscription = window.onDidChangeActiveColorTheme((theme) => {
      const frame: ThemeBridgeMessage = { type: 'dsh.vscodeTheme', kind: toThemeKind(theme.kind) }
      void webviewPanel.webview.postMessage(frame)
    })

    webviewPanel.onDidDispose(() => {
      themeSubscription.dispose()
      errorSubscription.dispose()
      instance.disposeTunnel()
      if (panel === instance) panel = undefined
    })
    return instance
  }

  /** Fetch the rendered index, inline preload scripts, materialize dynamic bundle routes, and set the panel HTML. */
  private async renderHtml(): Promise<void> {
    try {
      const response = await fetch(`${this.broker.baseUrl}/`)
      if (!response.ok) throw new Error(`index fetch returned HTTP ${String(response.status)}`)
      const rendered = await response.text()
      // Preload registrations must execute synchronously in document order,
      // so their bodies travel inline; the dynamic bundle routes the manifest
      // hands to runtime imports are materialized as files instead.
      const inlined = await inlinePluginScripts(rendered, async (path) => {
        const pluginResponse = await fetch(`${this.broker.baseUrl}${path}`)
        if (!pluginResponse.ok) throw new Error(`plugin script ${path} returned HTTP ${String(pluginResponse.status)}`)
        return pluginResponse.text()
      })
      const materialized = await this.materializePluginRoutes(inlined)
      const webview = this.webviewPanel.webview
      const toWebviewUri = (root: string, path: string): string => {
        return webview.asWebviewUri(Uri.file(join(root, path))).toString()
      }
      const rewritten = rewritePluginUrls(
        rewriteIndexUrls(materialized, path => toWebviewUri(this.distRoot, path)),
        path => toWebviewUri(this.pluginRoot, pluginCachePath(path)),
      )
      const transportUri = toWebviewUri(this.extensionPath, 'dist/webview-transport.js')
      const seedScript = this.seedSessionId === undefined
        ? ''
        : `<script>localStorage.setItem(${JSON.stringify(SESSION_SELECTION_KEY)}, `
          + `${JSON.stringify(JSON.stringify({ sessionId: this.seedSessionId }))});</script>`
      const headScript = themeBridgeScript(toThemeKind(window.activeColorTheme.kind)) + seedScript
      const html = buildPanelHtml(rewritten, panelCsp(webview.cspSource), transportUri, headScript)
      const withProbe = html.replace('</head>', `${panelProbeScript()}</head>`)
      webview.html = withProbe
      log(`panel: rendered SPA index (${String(rendered.length)} bytes, seed=${this.seedSessionId ?? 'none'})`)
    } catch (error) {
      logError('panel: failed to render the SPA index', error)
      throw error
    }
  }

  /**
   * Download every kernel plugin route the document references — preload
   * scripts and the boot manifest's bundle URLs alike — into the plugin cache
   * root, preserving the `/plugins/...` layout so one rewrite covers both.
   */
  private async materializePluginRoutes(html: string): Promise<string> {
    const paths = pluginScriptPaths(html)
    for (const path of paths) {
      const pluginResponse = await fetch(`${this.broker.baseUrl}${path}`)
      if (!pluginResponse.ok) throw new Error(`plugin route ${path} returned HTTP ${String(pluginResponse.status)}`)
      const target = join(this.pluginRoot, pluginCachePath(path))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(await pluginResponse.arrayBuffer()))
    }
    if (paths.length > 0) log(`panel: materialized ${String(paths.length)} kernel plugin route(s)`)
    return html
  }
}
