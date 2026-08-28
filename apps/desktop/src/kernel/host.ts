/**
 * The kernel host process: the entry the Electron main process forks through
 * `utilityProcess.fork`. It is a plain Node script (no renderer, no Electron
 * APIs) that supervises one `dsh --profile web --no-open --port 0` child,
 * parses the kernel's loopback base URL from its stdout, and reports it back
 * to the main process over the forked `MessagePort`. When the main process
 * disconnects (window closed, app quit) the host tears down the child process
 * tree so no dsh subprocess outlives the shell.
 *
 * The kernel itself is the full `dsh web` stack — gateway, runtime, session
 * persistence — exactly what `dsh web` serves; the main process relays SPA
 * fetches to its loopback port over the carrier, so the renderer never touches
 * the network. The later D2 refinement runs the Cordis tree in-process here
 * (no `dsh-host-webserver`, no loopback listener) once a programmatic boot
 * entry exists; see README.
 * @module kernel/host
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Minimal slice of a `MessagePort` (Node `worker_threads` or Electron
 * `process.parentPort`) the kernel host consumes. Keeping the class on a
 * narrow structural interface lets the supervisor logic stay testable without
 * forking a real utility process.
 */
export interface KernelControlPort {
  on(event: 'close', listener: () => void): unknown
  postMessage(message: unknown): void
  close(): void
}

/** Control message the host sends to the main process once the kernel listens. */
export interface KernelReadyMessage {
  type: 'dsh.kernel.ready'
  /** Loopback base URL, e.g. `http://127.0.0.1:54321` — no trailing slash. */
  baseUrl: string
}

/** Control message the host sends when the kernel child exits unexpectedly. */
export interface KernelExitMessage {
  type: 'dsh.kernel.exit'
  code: number | null
  /** Set when the host itself failed to start the kernel. */
  error?: string
}

/** Union of messages the host emits to the main process. */
export type KernelHostMessage = KernelReadyMessage | KernelExitMessage

/** The stdout URL line the web surface prints once its server is listening. */
const URL_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)\/?/m

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
 * Resolve the workspace `dsh` bin (the profile launcher) from this host's
 * install anchor, mirroring the VSCode extension's resolver.
 * @param anchor - a file URL inside the desktop app (typically `import.meta.url`).
 * @returns absolute path of the built `dsh` bin entry.
 */
export function resolveDshBin(anchor: string | URL): string {
  const nodeRequire = createRequire(anchor)
  const pkgJson = nodeRequire.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(pkgJson), 'lib', 'bin.js')
}

/**
 * Kill the whole child process tree. The kernel spawns its own subprocesses
 * (workers, sandbox helpers), so a bare `child.kill()` would orphan them.
 * @param child - the kernel child process.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
}

/** The options a {@link KernelHost} runs with; resolvable without Electron. */
export interface KernelHostOptions {
  /** Workspace folder the agent sessions run in. */
  cwd: string
  /** Absolute path of the `dsh` bin to spawn; defaults to {@link resolveDshBin}. */
  binPath?: string
  /** Anchor used to resolve the bin when `binPath` is omitted. */
  anchor?: string | URL
  /** Absolute path of the Node.js executable that runs the `dsh` bin. */
  nodePath?: string
  /** The control port handed to `parentPort` at fork time. */
  port: KernelControlPort
}

/**
 * Resolve the Node.js executable that can run the harness stack. Electron's
 * bundled Node (20 in Electron 33) is below the harness requirement
 * (`node ^22.19 || >=24`), so the kernel CLI must run on the system Node.
 * Preferred in order: an explicit `nodePath`, npm's own node (set when
 * launched through pnpm/npm), the `NODE` env var, and a PATH probe. A probe
 * spawns `node -e "process.stdout.write(process.execPath)"` and reads the
 * resolved path.
 * @param candidates - candidate paths in priority order (tests inject a fake list).
 * @param probe - the PATH probe; tests inject a fake.
 * @returns the node executable path, or `undefined` when none is usable.
 */
export function resolveSystemNode(
  candidates: readonly (string | undefined)[] = [
    process.env.npm_node_execpath,
    process.env.NODE,
  ],
  probe: () => string | undefined = probeNodePath,
): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0) {
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // fall through to the next candidate
      }
    }
  }
  return probe()
}

/** Probe PATH for a `node` that reports a real executable path. */
function probeNodePath(): string | undefined {
  try {
    const result = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return result.length > 0 ? result : undefined
  } catch {
    return undefined
  }
}

/**
 * Owns one kernel child and one control port. Construction does not spawn;
 * {@link start} does. {@link dispose} is idempotent and reaps the tree.
 */
export class KernelHost {
  private child: ChildProcess | undefined
  private stdout = ''
  private stderr = ''
  private ready = false
  private disposed = false

  constructor(private readonly options: KernelHostOptions) {}

  /**
   * Spawn the kernel and resolve once the loopback URL is known and posted to
   * the main process. Rejects if the child exits before printing the URL or
   * the startup deadline passes.
   * @returns the running kernel's loopback base URL.
   */
  async start(): Promise<string> {
    const bin = this.options.binPath
      ?? resolveDshBin(this.options.anchor ?? pathToFileURL(__filename))
    const nodePath = this.options.nodePath ?? resolveSystemNode()
    if (nodePath === undefined) {
      throw new Error(
        'system Node.js not found: the dsh kernel requires node ^22.19 || >=24, '
        + 'but Electron bundles an older Node; install Node.js and ensure it is on PATH',
      )
    }
    const child = spawn(nodePath, [bin, ...kernelArgs()], {
      cwd: this.options.cwd,
      env: { ...process.env, DSH_CWD: this.options.cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.stdout += chunk
      if (!this.ready) {
        const baseUrl = baseUrlFrom(this.stdout)
        if (baseUrl !== undefined) {
          this.ready = true
          this.post({ type: 'dsh.kernel.ready', baseUrl })
        }
      }
    })
    child.stderr.on('data', (chunk: string) => { this.stderr += chunk })
    child.on('exit', (code) => {
      if (this.disposed) return
      this.post({ type: 'dsh.kernel.exit', code })
      this.options.port.close()
    })

    return await new Promise<string>((resolvePromise, rejectPromise) => {
      const deadline = Date.now() + 120_000
      const poll = (): void => {
        const baseUrl = baseUrlFrom(this.stdout)
        if (baseUrl !== undefined) {
          resolvePromise(baseUrl)
          return
        }
        if (child.exitCode !== null) {
          rejectPromise(new Error(
            `desktop kernel exited before listening (code ${String(child.exitCode)}); stderr: ${this.stderr.slice(-2000)}`,
          ))
          return
        }
        if (Date.now() >= deadline) {
          this.dispose()
          rejectPromise(new Error(
            `desktop kernel did not print its URL within 120s; stderr: ${this.stderr.slice(-2000)}`,
          ))
          return
        }
        setTimeout(poll, 100)
      }
      poll()
    })
  }

  /** Terminate the kernel child tree and close the control port. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.child !== undefined) killTree(this.child)
    this.options.port.close()
  }

  private post(message: KernelHostMessage): void {
    if (this.disposed) return
    this.options.port.postMessage(message)
  }
}

/**
 * The utilityProcess entry. Reads its cwd from the fork's first argument,
 * wires the parent port, and starts the kernel. The main process is expected
 * to pass the workspace cwd as `args[0]`; when absent the kernel runs in the
 * current process cwd.
 */
export async function main(parentPort: KernelControlPort, args: readonly string[]): Promise<void> {
  const cwd = args[0] ?? process.cwd()
  const host = new KernelHost({ port: parentPort, cwd, anchor: import.meta.url })
  parentPort.on('close', () => { host.dispose() })
  try {
    await host.start()
  } catch (error) {
    parentPort.postMessage({
      type: 'dsh.kernel.exit',
      code: 1,
      error: error instanceof Error ? error.message : String(error),
    })
    parentPort.close()
    process.exit(1)
  }
}
