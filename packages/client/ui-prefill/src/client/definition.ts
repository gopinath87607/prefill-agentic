/**
 * Stage one of this package's registration: what the `prefill` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page offers
 * it as an entry box, and the dashboard body reads the Session's projections.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { IconContextInjectionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tab kind this package owns. */
export const PREFILL_KIND = 'prefill'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const PREFILL_ID = '@deepseek-ai/dsh-client-ui-prefill'

/**
 * The prefill type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function prefillDefinition(t: TranslateNS<'prefill'>): SidebarRightTabDefinition {
  return {
    id: PREFILL_ID,
    kind: PREFILL_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'prefill',
      order: 100,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: IconContextInjectionOutlineRegular,
    }],
  }
}
