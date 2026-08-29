import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { log, logError } from './log.ts'
import { resolveDshBin } from './runtime-resolution.ts'

/**
 * Owns the web kernel child process: one `dsh --profile web` bound to
 * `127.0.0.1` on an OS-assigned port, browser handoff disabled. The kernel is
 * the full web host stack — gateway, runtime, session persistence — exactly
 * what `dsh web` serves; the panel tunnel relays webview requests to its
 * loopback port, so the webview itself never touches the network.
 * @module kernel
 */

/** The stdout URL line the web surface prints once its server is listening. */
const URL_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)\/?\s*$/m

/** A running kernel: its loopback base URL plus async disposal. */
export interface WebKernelHandle {
  /** Loopback base URL, e.g. `http://127.0.0.1:54321` — no trailing slash. */
  readonly baseUrl: string
  /** Terminate the child process tree and wait for exit. */
  dispose(): Promise<void>
}

/** Options for {@link startWebKernel}. */
export interface WebKernelOptions {
  /** Workspace folder the agent sessions run in. */
  cwd: string
  /** Extension root, used to resolve the `dsh` bin through workspace node_modules. */
  extensionRoot: string
  /** User override for the launch command; args are inserted before the profile flags. */
  runtimeCommand?: string
  runtimeArgs?: readonly string[]
  /** Invoked when the child exits without {@link WebKernelHandle.dispose}. */
  onUnexpectedExit?: (code: number | null) => void
}

/**
 * The CLI arguments that shape the kernel: loopback bind, OS-assigned port,
 * and no browser handoff. Pure so the contract stays testable.
 * @returns the arguments after the program name.
 */
export function kernelArgs(): string[] {
  return ['--profile', 'web', '--no-open', '--port', '0']
}

/**
 * Extract the loopback base URL from the kernel's startup output. Pure.
 * @param stdout - everything the child has printed so far.
 * @returns the base URL, or `undefined` while the line has not printed.
 */
export function baseUrlFrom(stdout: string): string | undefined {
  return URL_LINE.exec(stdout)?.[1]
}

/**
 * Derive the per-directory node executable candidates from a PATH string. Pure
 * so the search order stays testable.
 * @param pathEnv - raw PATH value.
 * @param platform - target platform selector.
 * @returns absolute candidate paths in search order.
 */
export function nodeSearchCandidates(pathEnv: string, platform: string = process.platform): string[] {
  const executable = platform === 'win32' ? 'node.exe' : 'node'
  const separator = platform === 'win32' ? ';' : ':'
  return pathEnv
    .split(separator)
    .filter(entry => entry.trim().length > 0)
    .map(entry => platform === 'win32' ? join(entry, executable) : `${entry}/${executable}`)
}

/**
 * Locate a Node executable to run the kernel CLI. The extension host's
 * process.execPath is Electron (Code.exe): even under ELECTRON_RUN_AS_NODE it
 * resolves bare workspace specifiers differently than plain node, so the
 * kernel must boot on a real node. `DSH_NODE_EXE` overrides; PATH order
 * decides otherwise; the host execPath is the last-resort fallback.
 * @returns absolute path of a usable node executable.
 */
export function resolveNodeExecutable(pathEnv: string = process.env.PATH ?? '', nodeExeOverride: string | undefined = process.env.DSH_NODE_EXE): string {
  if (nodeExeOverride !== undefined && nodeExeOverride.trim().length > 0) return nodeExeOverride.trim()
  const found = nodeSearchCandidates(pathEnv).find(candidate => existsSync(candidate))
  return found ?? process.execPath
}

/**
 * Kill the whole child process tree. The kernel spawns its own subprocesses
 * (workers, sandbox helpers), so a bare `child.kill()` would orphan them.
 * @param child - the kernel child process.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    }
    return
  }
  child.kill('SIGTERM')
}

/**
 * Start the web kernel and resolve once its loopback URL is known.
 * @param options - workspace cwd, extension root, optional overrides, exit hook.
 * @returns the running kernel handle.
 */
export function startWebKernel(options: WebKernelOptions): Promise<WebKernelHandle> {
  const { bin, root } = resolveDshBin(options.extensionRoot)
  const command = options.runtimeCommand !== undefined && options.runtimeCommand.trim().length > 0
    ? options.runtimeCommand.trim()
    : resolveNodeExecutable()
  const extra = options.runtimeArgs ?? []
  const args = options.runtimeCommand !== undefined && options.runtimeCommand.trim().length > 0
    ? [...extra, ...kernelArgs()]
    : [bin, ...extra, ...kernelArgs()]
  log(`kernel: spawn ${command} ${args.join(' ')}`)
  log(`kernel: cwd=${options.cwd} bin=${bin} resolvedFrom=${root}`)
  const child = spawn(command, args, {
    cwd: options.cwd,
    // The fallback launch (host execPath) runs Electron, which would boot
    // bin.js as a GUI app and exit 1; ELECTRON_RUN_AS_NODE forces the Node
    // runtime. Plain node ignores the flag, so it is set unconditionally.
    env: { ...process.env, DSH_CWD: options.cwd, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let exited = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    for (const line of chunk.split('\n')) if (line.trim().length > 0) log(`kernel|out| ${line.trimEnd()}`)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    for (const line of chunk.split('\n')) if (line.trim().length > 0) log(`kernel|err| ${line.trimEnd()}`)
  })
  const unexpectedExit = (code: number | null): void => {
    exited = true
    log(`kernel: exited code=${String(code)} stderrTail=${JSON.stringify(stderr.slice(-500))}`)
    options.onUnexpectedExit?.(code)
  }
  child.on('exit', unexpectedExit)
  child.on('error', (error: Error) => {
    exited = true
    logError('kernel: spawn failed', error)
    options.onUnexpectedExit?.(null)
  })

  return new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + 120_000
    const poll = (): void => {
      const baseUrl = baseUrlFrom(stdout)
      if (baseUrl !== undefined && !exited) {
        log(`kernel: listening at ${baseUrl}`)
        resolvePromise({
          baseUrl,
          dispose: () => new Promise((done) => {
            if (exited || child.exitCode !== null) { done(); return }
            child.once('exit', () => { done() })
            killTree(child)
          }),
        })
        return
      }
      if (exited) {
        rejectPromise(new Error(`web kernel exited before listening (code ${String(child.exitCode)}); stderr: ${stderr.slice(-2000)}`))
        return
      }
      if (Date.now() >= deadline) {
        killTree(child)
        rejectPromise(new Error(`web kernel did not print its URL within 120s; stderr: ${stderr.slice(-2000)}`))
        return
      }
      setTimeout(poll, 100)
    }
    poll()
  })
}

/** Resolve a user-supplied relative command against the workspace, or pass through absolute paths. */
export function resolveCommand(command: string, cwd: string): string {
  if (isAbsolute(command)) return command
  return resolve(cwd, command)
}
