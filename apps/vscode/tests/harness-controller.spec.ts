import { describe, expect, it } from 'vitest'
import type { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { HarnessController } from '../src/harness-controller.ts'
import type { ApiPreset, RuntimeLaunch, ToolCallView } from '../src/types.ts'

interface FakeSession {
  runCalls: Array<{ input: unknown }>
  notificationListeners: Array<(notification: unknown) => void>
  resolveRun: (value: unknown) => void
  rejectRun: (error: Error) => void
  settle: () => void
  settled: Promise<void>
}

class FakeHarness {
  static instances: FakeHarness[] = []
  started = false
  closed = false
  startCalls = 0
  sessions = new Map<string, FakeSession>()

  constructor(public launch: RuntimeLaunch, public preset: ApiPreset, public maxTokens: number | undefined) {
    FakeHarness.instances.push(this)
  }

  get client() {
    return {
      subscribe: () => {
        let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined
        let closed = false
        return {
          next: () => {
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise<IteratorResult<unknown>>((resolve) => { resolveNext = resolve })
          },
          tryNext: () => undefined,
          [Symbol.asyncIterator]() { return this },
          close: () => {
            closed = true
            resolveNext?.({ value: undefined, done: true })
          },
        }
      },
    }
  }

  async start() {
    this.startCalls += 1
    this.started = true
  }

  session(id: string) {
    let session = this.sessions.get(id)
    if (session === undefined) {
      const listeners: Array<(notification: unknown) => void> = []
      let resolveSettled: () => void = () => {}
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
      session = {
        runCalls: [],
        notificationListeners: listeners,
        resolveRun: () => {},
        rejectRun: () => {},
        settle: resolveSettled,
        settled,
      }
      this.sessions.set(id, session)
      void session.settled.then(() => {
        for (const listener of listeners) {
          listener({ method: 'session.event', params: { sessionId: id, event: { type: 'agent/inbox/spliced', data: { inserted: [{ id: `user-${id}` }] } } } })
          listener({ method: 'session.status', params: { sessionId: id, status: 'running' } })
        }
      })
    }
    const captured = session
    return {
      run: async (input: unknown, options: { onNotification?: (n: unknown) => void }) => {
        captured.runCalls.push({ input })
        if (options.onNotification) captured.notificationListeners.push(options.onNotification)
        captured.settle()
        return await new Promise((resolve, reject) => {
          captured.resolveRun = resolve
          captured.rejectRun = reject
        })
      },
    }
  }

  emit(notification: unknown) {
    for (const session of this.sessions.values()) {
      for (const listener of session.notificationListeners) listener(notification)
    }
  }

  finishSession(id: string, result?: unknown) {
    this.emit({ method: 'session.status', params: { sessionId: id, status: 'idle' } })
    this.sessions.get(id)?.resolveRun(result ?? { finalResponse: '' })
  }

  async close() {
    this.closed = true
    this.started = false
    for (const session of this.sessions.values()) {
      session.rejectRun(new Error('runtime closed'))
    }
  }
}

function factory(launch: RuntimeLaunch, preset: ApiPreset, maxTokens: number | undefined): DeepSeekHarness {
  return new FakeHarness(launch, preset, maxTokens) as unknown as DeepSeekHarness
}

const deepseek: ApiPreset = {
  id: 'p1',
  name: 'DeepSeek',
  apiKey: '',
  baseURL: '',
  model: 'deepseek-chat',
}

const openai: ApiPreset = {
  id: 'p2',
  name: 'OpenAI',
  apiKey: '',
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-4o',
}

function controller() {
  FakeHarness.instances = []
  return new HarnessController(
    '/workspace',
    { resolve: () => ({ command: 'node', args: ['bin.js', 'cordis.yml'], cwd: '/workspace', env: {} }) },
    undefined,
    factory,
  )
}

const flush = (count = 10): Promise<void> => Array.from({ length: count })
  .reduce<Promise<void>>(async (p) => { await p; await Promise.resolve() }, Promise.resolve())

describe('HarnessController', () => {
  it('creates sessions and starts the runtime lazily on first prompt', async () => {
    const c = controller()
    await c.setActivePreset(deepseek)
    const id = c.createSession()
    const chunks: string[] = []
    const tools: ToolCallView[] = []
    const promptPromise = c.prompt(id, 'hello', {
      onAssistantText: text => chunks.push(text),
      onAssistantMessage: () => {},
      onToolCall: call => tools.push(call),
      onToolResult: () => {},
      onSubagent: () => {},
    })
    await flush()
    const harness = FakeHarness.instances[0]!
    expect(harness.preset).toEqual(deepseek)
    expect(harness.startCalls).toBe(1)

    harness.emit({ method: 'session.event', params: { sessionId: id, event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hi' } } } } })
    harness.emit({ method: 'session.event', params: { sessionId: id, event: { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } } } })
    harness.finishSession(id, { finalResponse: 'hi' })
    await promptPromise

    expect(chunks).toEqual(['hi'])
    expect(tools).toMatchObject([{ name: 'bash', callId: 'c1' }])
    expect(c.isRunning(id)).toBe(false)
  })

  it('rejects a prompt without an active preset', async () => {
    const c = controller()
    const id = c.createSession()
    await expect(c.prompt(id, 'hi', {
      onAssistantText: () => {}, onAssistantMessage: () => {}, onToolCall: () => {}, onToolResult: () => {}, onSubagent: () => {},
    })).rejects.toThrow(/preset/)
  })

  it('restarts the runtime when provider/model changes', async () => {
    const c = controller()
    await c.setActivePreset(deepseek)
    const id = c.createSession()
    const promptPromise = c.prompt(id, 'hi', {
      onAssistantText: () => {}, onAssistantMessage: () => {}, onToolCall: () => {}, onToolResult: () => {}, onSubagent: () => {},
    })
    await flush()
    const first = FakeHarness.instances[0]!
    first.finishSession(id)
    await promptPromise

    await c.setActivePreset(openai)
    expect(first.closed).toBe(true)

    const id2 = c.createSession()
    const prompt2 = c.prompt(id2, 'hi', {
      onAssistantText: () => {}, onAssistantMessage: () => {}, onToolCall: () => {}, onToolResult: () => {}, onSubagent: () => {},
    })
    await flush()
    expect(FakeHarness.instances).toHaveLength(2)
    expect(FakeHarness.instances[1]!.preset).toEqual(openai)
    FakeHarness.instances[1]!.finishSession(id2)
    await prompt2
  })

  it('stops a running turn by terminating the runtime', async () => {
    const c = controller()
    await c.setActivePreset(deepseek)
    const id = c.createSession()
    const promptPromise = c.prompt(id, 'hi', {
      onAssistantText: () => {}, onAssistantMessage: () => {}, onToolCall: () => {}, onToolResult: () => {}, onSubagent: () => {},
    })
    await flush()
    const harness = FakeHarness.instances[0]!
    await c.stop(id)
    await expect(promptPromise).rejects.toThrow()
    expect(harness.closed).toBe(true)
    expect(c.isRunning(id)).toBe(false)
  })
})
