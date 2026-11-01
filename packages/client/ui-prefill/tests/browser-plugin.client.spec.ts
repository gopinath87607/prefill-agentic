/**
 * ui-prefill browser half on a real SlotRegistry: the plugin registers the
 * `prefill` tab type, its dashboard body, and its chip title, and teardown
 * removes each contribution (HMR safety).
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { PREFILL_ID } from '../src/client/definition.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { PrefillDashboard } from '../src/client/PrefillDashboard.tsx'
import { PrefillTitle } from '../src/client/PrefillTitle.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const removeType = vi.fn()
  const registerType = vi.fn<(definition: SidebarRightTabDefinition) => () => void>(() => removeType)
  ctx.provide('sidebarRightTabs', { register: registerType })
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  return { ctx, registerType, removeType, locale }
}

describe('ui-prefill browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'sidebarRightTabs'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers the dictionaries, the tab type, and both keyed seats, then removes them', async () => {
    const b = await bench()
    const registerDicts = vi.spyOn(b.locale, 'register')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()

      const [namespace, dictionaries] = registerDicts.mock.calls[0]!
      expect(namespace).toBe('prefill')
      expect(dictionaries).toEqual({ zh, en, ja, es, fr, de, ru, pt })

      expect(b.registerType).toHaveBeenCalledOnce()
      const definition = b.registerType.mock.calls[0]![0]
      expect(definition.id).toBe(PREFILL_ID)
      expect(definition.kind).toBe('prefill')
      expect(definition.priority).toBe('builtin')
      expect(definition.patterns).toBeUndefined()
      expect(definition.title('')).toBe('Prefill')
      expect(definition.guide).toHaveLength(1)
      expect(definition.guide![0]!.title()).toBe('Prefill dashboard')
      expect(definition.guide![0]!.description?.()).toBe('Prefilled files, cache reuse, and time saved')
      expect(definition.guide![0]!.icon).toBeDefined()

      const body = b.ctx.slots.entries('sidebar.right.pane.tab')
      expect(body).toHaveLength(1)
      expect(body[0]!.component).toBe(PrefillDashboard)
      const title = b.ctx.slots.entries('sidebar.right.pane.tab.title')
      expect(title).toHaveLength(1)
      expect(title[0]!.component).toBe(PrefillTitle)
    } finally {
      await fiber.dispose()
    }
    expect(b.removeType).toHaveBeenCalledOnce()
    expect(b.ctx.slots.entries('sidebar.right.pane.tab')).toEqual([])
    expect(b.ctx.slots.entries('sidebar.right.pane.tab.title')).toEqual([])
  })

  it('waits until the right Sidebar declares its seats', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('sidebarRightTabs', { register: vi.fn(() => vi.fn()) })
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
    ctx.slots.register({
      name: 'root',
      children: {
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
        'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
      },
    } as never, () => null)
    await Promise.resolve()
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(1)
    expect(ctx.slots.entries('sidebar.right.pane.tab.title')).toHaveLength(1)
    await fiber.dispose()
  })
})
