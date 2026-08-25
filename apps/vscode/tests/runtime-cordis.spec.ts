import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const binScript = resolve(here, '../../../packages/examples/jsonrpc-demo/src/bin.ts')
const configPath = resolve(here, '../runtime/cordis.yml')
const repoRoot = resolve(here, '../../..')

function waitForLine(
  lines: string[],
  predicate: (value: Record<string, unknown>) => boolean,
  stderr: () => string,
): Promise<Record<string, unknown>> {
  return new Promise((win, lose) => {
    const deadline = Date.now() + 30_000
    const poll = (): void => {
      while (lines.length > 0) {
        const line = lines.shift()!
        if (!line.trim()) continue
        try {
          const value = JSON.parse(line) as Record<string, unknown>
          if (predicate(value)) { win(value); return }
        } catch {
          lose(new Error(`non-JSON stdout from VSCode runtime: ${line}`))
          return
        }
      }
      if (Date.now() >= deadline) {
        lose(new Error(`timed out waiting for JSON-RPC response; stderr=${stderr()}`))
        return
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe('vscode runtime cordis smoke', () => {
  it('boots the VSCode composition, initializes, and exposes subagent tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-vscode-runtime-'))
    const capturedBodies: string[] = []
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        capturedBodies.push(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(win => modelServer.listen(0, '127.0.0.1', win))
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('model server did not bind')

    const child = execa(process.execPath, ['--import', 'tsx', binScript, configPath], {
      cwd: repoRoot,
      env: {
        DEEPSEEK_API_KEY: 'keyless-smoke',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DSH_CWD: root,
        DSH_SESSION_ROOT: join(root, '.sessions'),
      },
      timeout: 35_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    const lines: string[] = []
    let stdoutBuffer = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const parts = stdoutBuffer.split('\n')
      stdoutBuffer = parts.pop() ?? ''
      lines.push(...parts)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { cwd: root, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })}\n`)
      const initialized = await waitForLine(lines, value => value.id === 1, () => stderr)
      expect(initialized).toMatchObject({
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } },
      })

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'hello' }] },
      })}\n`)
      await waitForLine(lines, value => value.id === 2, () => stderr)
      await waitForLine(lines, (value) => {
        if (value.method !== 'session.event') return false
        const params = value.params as { sessionId?: string; event?: { type?: string } }
        return params.sessionId === 'main' && params.event?.type === 'turn/end'
      }, () => stderr)

      const requestBodies = capturedBodies
        .filter(entry => entry.length > 0)
        .map(entry => JSON.parse(entry) as { tools?: Array<{ function?: { name?: string } }> })
      const toolNames = requestBodies
        .flatMap(parsed => (parsed.tools ?? []).map(tool => tool.function?.name ?? ''))
        .filter(name => name.length > 0)
      expect(toolNames).toEqual(expect.arrayContaining(['subagent_claude_code', 'subagent_opencode']))

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' })}\n`)
      const shutdown = await waitForLine(lines, value => value.id === 3, () => stderr)
      expect(shutdown).toMatchObject({ result: {} })
      const exit = await child
      expect(exit.exitCode, `signal=${String(exit.signal)}; stderr=${stderr}`).toBe(0)
    } finally {
      child.kill('SIGKILL')
      await child
      await new Promise<void>((win) => {
        modelServer.close(() => { win() })
      })
      await rm(root, { recursive: true, force: true })
    }
  }, 45_000)
})
