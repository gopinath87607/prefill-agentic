/**
 * The prefill tab's chip title: the injected-context glyph before the type's
 * label. Registered under `sidebar.right.pane.tab.title`; without it the chip
 * would show the bare label the registry captured when the tab opened.
 */
import type { ReactNode } from 'react'
import { IconContextInjectionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PrefillDashboard.module.css'

/** Props of the chip title: the tab information hook it reads. */
export interface PrefillTitleProps {
  /** The seat's tab information hook. */
  readonly useTabInfo: () => { readonly tab: { readonly title: string } }
}

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the injected-context glyph followed by the tab's title text.
 */
export function PrefillTitle({ useTabInfo }: PrefillTitleProps): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <IconContextInjectionOutlineRegular size={16} className={css.titleIcon} />
      {tab.title}
    </>
  )
}
