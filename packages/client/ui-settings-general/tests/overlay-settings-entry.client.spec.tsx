// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OverlaySettingsEntry } from '../src/client/OverlaySettingsEntry.tsx'
import type { SettingsRootComponentProps } from '../src/client/shell-contract.ts'

type OverlayEntryProps = Parameters<typeof OverlaySettingsEntry>[0]

afterEach(cleanup)

const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.close': 'Close',
}

function mount() {
  const renderSlot = vi.fn(
    ((key: string, _owner: unknown, opts?: { only?: string }) => {
      if (key === 'settings.section') return <div data-testid={`section-${opts?.only ?? 'all'}`} />
      return SEAT_CONTENT[key]
    }) as SettingsRootComponentProps['renderSlot'],
  )
  // Root-scope standard seats: no sessions/workspaces exist in the embedded
  // bench; the empty-session fact keeps the onboarding coordinator idle.
  const emptySessions = { phase: 'ready', current: 's1', byId: { s1: { blank: false } } }
  const props = {
    useSessions: ((select: (state: unknown) => unknown) => select(emptySessions)) as OverlayEntryProps['useSessions'],
    useWorkspaces: (() => []) as OverlayEntryProps['useWorkspaces'],
    useSections: (() => [{ id: 'general', order: 0, label: 'General' }]) as OverlayEntryProps['useSections'],
    useOnboardingSteps: (() => []) as OverlayEntryProps['useOnboardingSteps'],
    renderSlot,
  } as OverlayEntryProps
  return render(<OverlaySettingsEntry {...props} />)
}

describe('OverlaySettingsEntry (embedded carrier surface)', () => {
  it('mounts the trigger in rail mode and opens the fixed settings panel on click', () => {
    mount()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    // The sidebar owner share is absent on shell.overlay; the entry supplies
    // wide:false itself so the trigger seat renders the rail glyph.
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('closes the panel via the close button', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
