import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ApiPreset } from './types.ts'

/** Field names in the ainovel `api_library.json` text preset `fields` object. */
const FIELD_API_KEY = 'ARK_API_KEY'
const FIELD_BASE_URL = 'ARK_BASE_URL'
const FIELD_MODEL = 'ARK_MODEL_PRO'

/**
 * Read/write the ainovel API preset library at
 * `~/.claude/ainovel-write/api_library.json`, reusing its text presets as the
 * VSCode extension's switchable API routes. The file stores real credentials in
 * plaintext under `text_presets[].fields` (`ARK_API_KEY`, `ARK_BASE_URL`,
 * `ARK_MODEL_PRO`); this is the single source of truth shared with ainovel.
 */
export class ApiPresetStore {
  private readonly path: string
  private readonly emitter = new EventEmitter()
  private presets: ApiPreset[] = []
  private activeId: string | undefined

  /**
   * @param libraryPath - override the file location (defaults to the ainovel path under the user home).
   */
  constructor(libraryPath: string = defaultLibraryPath()) {
    this.path = libraryPath
    this.reload()
    this.emitter.emit('change')
  }

  /** Subscribe to preset-library changes (add/update/remove/select/reload). */
  onDidChange(listener: () => void): { dispose(): void } {
    this.emitter.on('change', listener)
    return { dispose: () => this.emitter.off('change', listener) }
  }

  /** Absolute path to the backing `api_library.json`. */
  get file(): string {
    return this.path
  }

  /** Snapshot of every stored preset, including its credential fields. */
  list(): readonly ApiPreset[] {
    return this.presets
  }

  /** The active preset (the file's `current_text_id`, else the first), or `undefined`. */
  get active(): ApiPreset | undefined {
    if (this.activeId !== undefined) {
      const found = this.presets.find(preset => preset.id === this.activeId)
      if (found !== undefined) return found
    }
    return this.presets[0]
  }

  /** Reload presets from disk (e.g. after an external edit). */
  reload(): void {
    const data = readLibrary(this.path)
    this.presets = (data.text_presets ?? [])
      .filter(isTextPreset)
      .map(toApiPreset)
    const current = data.current_text_id
    this.activeId = typeof current === 'string' && current.length > 0 ? current : undefined
  }

  /** Add a preset, minting a short id when the caller omitted one. Returns the stored preset. */
  add(input: Omit<ApiPreset, 'id'> & { id?: string }): ApiPreset {
    const id = input.id && input.id.length > 0 ? input.id : randomUUID().replaceAll('-', '').slice(0, 8)
    const preset: ApiPreset = {
      id,
      name: input.name.trim() || '未命名预设',
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      model: input.model,
    }
    const data = readLibrary(this.path)
    const presets = [...(data.text_presets ?? []), toTextPreset(preset)]
    writeLibrary(this.path, { ...data, text_presets: presets, current_text_id: data.current_text_id ?? id })
    this.reload()
    this.emitter.emit('change')
    return preset
  }

  /** Replace an existing preset's fields by id. Returns false when not found. */
  update(id: string, patch: Partial<Omit<ApiPreset, 'id'>>): boolean {
    const data = readLibrary(this.path)
    const presets = data.text_presets ?? []
    const index = presets.findIndex(entry => isTextPreset(entry) && entry.id === id)
    if (index === -1) return false
    const existing = toApiPreset(presets[index] as TextPreset)
    const updated: ApiPreset = {
      id,
      name: patch.name !== undefined ? patch.name.trim() || existing.name : existing.name,
      apiKey: patch.apiKey !== undefined ? patch.apiKey : existing.apiKey,
      baseURL: patch.baseURL !== undefined ? patch.baseURL : existing.baseURL,
      model: patch.model !== undefined ? patch.model : existing.model,
    }
    presets[index] = toTextPreset(updated)
    writeLibrary(this.path, { ...data, text_presets: presets })
    this.reload()
    this.emitter.emit('change')
    return true
  }

  /** Remove a preset by id, clearing the active selection when it matched. */
  remove(id: string): void {
    const data = readLibrary(this.path)
    const presets = (data.text_presets ?? []).filter(entry => !isTextPreset(entry) || entry.id !== id)
    const current = data.current_text_id === id ? null : data.current_text_id
    writeLibrary(this.path, { ...data, text_presets: presets, current_text_id: current })
    this.reload()
    this.emitter.emit('change')
  }

  /** Select a preset by id; the selection persists to `current_text_id`. */
  setActive(id: string): void {
    if (!this.presets.some(preset => preset.id === id)) throw new Error(`unknown preset: ${id}`)
    const data = readLibrary(this.path)
    writeLibrary(this.path, { ...data, current_text_id: id })
    this.reload()
    this.emitter.emit('change')
  }
}

/** Default ainovel library path: `~/.claude/ainovel-write/api_library.json`. */
function defaultLibraryPath(): string {
  return join(homedir(), '.claude', 'ainovel-write', 'api_library.json')
}

interface TextPresetFields {
  ARK_API_KEY?: string
  ARK_BASE_URL?: string
  ARK_MODEL_PRO?: string
  [key: string]: unknown
}

interface TextPreset {
  id: string
  name?: string
  fields?: TextPresetFields
}

interface LibraryFile {
  text_presets?: unknown[]
  current_text_id?: unknown
  [key: string]: unknown
}

function readLibrary(path: string): LibraryFile {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeLibrary(path: string, data: LibraryFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function toApiPreset(entry: TextPreset): ApiPreset {
  const fields = isRecord(entry.fields) ? entry.fields : {}
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : '未命名预设',
    apiKey: stringField(fields[FIELD_API_KEY]),
    baseURL: stringField(fields[FIELD_BASE_URL]),
    model: stringField(fields[FIELD_MODEL]),
  }
}

function toTextPreset(preset: ApiPreset): TextPreset {
  const fields: TextPresetFields = {}
  if (preset.apiKey.length > 0) fields[FIELD_API_KEY] = preset.apiKey
  if (preset.baseURL.length > 0) fields[FIELD_BASE_URL] = preset.baseURL
  if (preset.model.length > 0) fields[FIELD_MODEL] = preset.model
  return { id: preset.id, name: preset.name, fields }
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isTextPreset(value: unknown): value is TextPreset {
  return isRecord(value) && typeof value.id === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
