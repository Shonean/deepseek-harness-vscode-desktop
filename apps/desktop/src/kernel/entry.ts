/**
 * Entry script the Electron main process forks through
 * `utilityProcess.fork`. Electron exposes `process.parentPort` only inside the
 * forked utility process; the class lives in `host.ts` so the kernel
 * supervisor logic stays testable without Electron.
 * @module kernel/entry
 */
import type { KernelControlPort } from './host.ts'
import { main } from './host.ts'

/** Minimal shape of the Electron utility-process global the entry consumes. */
interface UtilityProcessGlobal {
  parentPort: KernelControlPort
  argv: string[]
  cwd(): string
  exit(code?: number): never
  platform: string
  env: Record<string, string | undefined>
}

const processRef = globalThis.process as unknown as UtilityProcessGlobal
const parentPort = processRef.parentPort
const args = processRef.argv.slice(2)
void main(parentPort, args)
