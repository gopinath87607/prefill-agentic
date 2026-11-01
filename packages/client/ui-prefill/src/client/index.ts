/**
 * Prefill dashboard, browser half: one right-Sidebar page type that reads the
 * Session's prefill, token-usage, and context-pressure projections.
 */
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the session standard props and the token/prefill projection reads.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the client slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-prefill-context/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { PREFILL_ID, prefillDefinition } from './definition.ts'
import { PrefillDashboard } from './PrefillDashboard.tsx'
import { PrefillTitle } from './PrefillTitle.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { PrefillKey } from './locales.ts'

/** This package's copy namespace. */
const NS = 'prefill'

/** Required browser services: copy, slot registration, and the tab-type registry. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body: register the dictionaries, the `prefill` tab type, its
 * body, and its chip title.
 * @param ctx - client root context carrying the locale and sidebar services.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-prefill: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(prefillDefinition(t)), 'ui-prefill: prefill type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: PREFILL_ID, locale: NS,
  }, PrefillDashboard)), 'ui-prefill: dashboard body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: PREFILL_ID,
  }, PrefillTitle)), 'ui-prefill: dashboard title')
}
