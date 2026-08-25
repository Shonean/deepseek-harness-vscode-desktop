import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiPresetStore } from '../src/preset-store.ts'

describe('ApiPresetStore (ainovel api_library.json)', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-vscode-presets-'))
    file = join(dir, 'api_library.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns empty when the file is absent', () => {
    const store = new ApiPresetStore(file)
    expect(store.list()).toEqual([])
    expect(store.active).toBeUndefined()
  })

  it('reads ainovel text_presets with ARK_* fields', () => {
    writeFileSync(file, JSON.stringify({
      text_presets: [{
        id: 'p01doubao',
        name: 'doubao-seed-evolving',
        fields: {
          ARK_API_KEY: 'ark-secret',
          ARK_BASE_URL: 'https://ark.example/v3',
          ARK_MODEL_PRO: 'doubao-seed-evolving',
        },
      }],
      current_text_id: 'p01doubao',
    }, null, 2), 'utf8')
    const store = new ApiPresetStore(file)
    expect(store.list()).toHaveLength(1)
    expect(store.active).toMatchObject({
      id: 'p01doubao',
      name: 'doubao-seed-evolving',
      apiKey: 'ark-secret',
      baseURL: 'https://ark.example/v3',
      model: 'doubao-seed-evolving',
    })
  })

  it('adds a preset and writes it back as an ainovel text_preset', () => {
    const store = new ApiPresetStore(file)
    store.add({ id: 'p1', name: 'doubao', apiKey: 'k', baseURL: 'https://ark/v3', model: 'doubao-x' })
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
      text_presets: Array<{ id: string; fields: Record<string, string> }>
      current_text_id: string
    }
    expect(onDisk.current_text_id).toBe('p1')
    expect(onDisk.text_presets[0]?.fields).toEqual({
      ARK_API_KEY: 'k',
      ARK_BASE_URL: 'https://ark/v3',
      ARK_MODEL_PRO: 'doubao-x',
    })
  })

  it('falls back to the first preset when current_text_id is missing', () => {
    writeFileSync(file, JSON.stringify({
      text_presets: [
        { id: 'a', name: 'A', fields: { ARK_MODEL_PRO: 'm-a' } },
        { id: 'b', name: 'B', fields: { ARK_MODEL_PRO: 'm-b' } },
      ],
    }), 'utf8')
    const store = new ApiPresetStore(file)
    expect(store.active?.id).toBe('a')
  })

  it('removes a preset and clears the active selection when it matches', () => {
    writeFileSync(file, JSON.stringify({
      text_presets: [{ id: 'a', name: 'A', fields: {} }],
      current_text_id: 'a',
    }), 'utf8')
    const store = new ApiPresetStore(file)
    store.remove('a')
    expect(store.list()).toEqual([])
    expect(store.active).toBeUndefined()
  })

  it('emits a change event on writes', () => {
    const store = new ApiPresetStore(file)
    let calls = 0
    store.onDidChange(() => { calls += 1 })
    store.add({ name: 'x', apiKey: '', baseURL: '', model: 'm' })
    expect(calls).toBe(1)
  })
})
