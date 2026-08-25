import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { RuntimeLaunch, RuntimeResolver } from './types.ts'

/** Filename of the runtime composition shipped with the extension. */
const CONFIG_BASENAME = 'cordis.yml'

/** Package that provides the `dsh-jsonrpc-agent` bin. */
const RUNTIME_PACKAGE = '@deepseek-ai/dsh-sdk-jsonrpc-demo'

/**
 * Resolves how the runtime subprocess is launched: the bin entry from
 * `@deepseek-ai/dsh-sdk-jsonrpc-demo` run under the current Node executable,
 * followed by the absolute path to the extension's bundled `cordis.yml`.
 *
 * A user-provided `runtimeCommand` setting overrides the executable and the
 * optional `runtimeArgs` are inserted before the config path.
 */
export class NodeRuntimeResolver implements RuntimeResolver {
  private readonly nodeRequire: NodeJS.Require

  /**
   * @param extensionRoot - directory containing the built extension (its `runtime/cordis.yml` and node_modules).
   * @param runtimeCommand - optional override for the executable.
   * @param runtimeArgs - extra args inserted before the config path.
   */
  constructor(
    private readonly extensionRoot: string,
    private readonly runtimeCommand: string,
    private readonly runtimeArgs: readonly string[],
  ) {
    this.nodeRequire = createRequire(join(extensionRoot, 'package.json'))
  }

  resolve(cwd: string): RuntimeLaunch {
    const configPath = join(this.extensionRoot, 'runtime', CONFIG_BASENAME)
    if (!existsSync(configPath)) {
      throw new Error(`runtime config not found: ${configPath}`)
    }

    if (this.runtimeCommand.trim().length > 0) {
      return {
        command: this.runtimeCommand,
        args: [...this.runtimeArgs, configPath],
        cwd,
        env: { ...process.env },
      }
    }

    const binPath = this.resolveBinEntry()
    return {
      command: process.execPath,
      args: [binPath, ...this.runtimeArgs, configPath],
      cwd,
      env: { ...process.env },
    }
  }

  /**
   * Locate the runtime bin entry. The package's `exports["./bin"]` points at
   * `lib/bin.js`; resolving it yields an absolute filesystem path that the
   * current Node executable can run directly without relying on a `.bin` shim.
   */
  private resolveBinEntry(): string {
    try {
      const pkgJson = this.nodeRequire.resolve(`${RUNTIME_PACKAGE}/package.json`)
      const binPath = join(dirname(pkgJson), 'lib', 'bin.js')
      if (existsSync(binPath)) return binPath
      return this.nodeRequire.resolve(`${RUNTIME_PACKAGE}/bin`)
    } catch (error) {
      throw new Error([
        `could not resolve ${RUNTIME_PACKAGE} bin from ${this.extensionRoot}`,
        error instanceof Error ? error.message : String(error),
      ].join('\n'))
    }
  }
}
