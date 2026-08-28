/**
 * The Electron preload bridge: `contextIsolation` stays on and
 * `nodeIntegration` stays off, so the renderer page cannot reach Electron
 * directly. The only bridge this file exposes is a one-shot port forward: the
 * main process hands the renderer half of a `MessageChannelMain` over
 * `ipRenderer.on('dsh-port', ...)`, and the preload re-posts it to the page's
 * main world with the marker the injected transport IIFE listens for
 * (`src/carrier/renderer-transport.ts`). No other Electron surface is exposed.
 * @module preload
 */
import { ipcRenderer } from 'electron'

/** Channel the main process uses to deliver the carrier `MessagePort`. */
const PORT_CHANNEL = 'dsh-port'

/** Marker the main-world transport script matches on its `message` listener. */
const PORT_MESSAGE = 'dsh.renderer.port'

ipcRenderer.on(PORT_CHANNEL, (event) => {
  const port = event.ports[0]
  if (port === undefined) return
  // Re-posting with the same transfer list hands the port to the page's main
  // world where the injected transport script receives it. event.ports[0] is
  // the DOM MessagePort; targetOrigin is '*' because the page is a local
  // custom-scheme document with no remote origin.
  window.postMessage({ marker: PORT_MESSAGE }, '*', [port])
})
