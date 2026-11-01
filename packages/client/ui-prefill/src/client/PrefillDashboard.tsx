/**
 * The prefill dashboard tab body: what the prefill snapshot carries, what the
 * provider's cache reports reused, and what the latest request cost.
 *
 * Every reading is a host-computed projection value; the body only formats and
 * lays them out. The two prefill keys (`prefillContext`, `prefillLedger`) are
 * merged by `@deepseek-ai/dsh-prefill-context/client`; `tokenUsage` and
 * `contextPressure` by `@deepseek-ai/dsh-token-meter/client`.
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { PrefillLedgerView, PrefillSavingsView } from '@deepseek-ai/dsh-prefill-context/client'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import {
  billedInput,
  formatBytes,
  formatCacheHit,
  formatCount,
  formatDuration,
  formatPercent,
  type PrefillTranslate,
} from './format.ts'
import css from './PrefillDashboard.module.css'

/**
 * The projection reads this body makes, as the standard kit's `useProjection`
 * satisfies them.
 */
export interface PrefillProjectionReader {
  /** @param key - a projection key this body reads. @returns the served value, or undefined while absent. */
  (key: 'prefillContext'): PrefillSavingsView | undefined
  /** @param key - a projection key this body reads. @returns the served value, or undefined while absent. */
  (key: 'prefillLedger'): PrefillLedgerView | undefined
  /** @param key - a projection key this body reads. @returns the served value, or undefined while absent. */
  (key: 'tokenUsage'): TokenUsageProjection | undefined
  /** @param key - a projection key this body reads. @returns the served value, or undefined while absent. */
  (key: 'contextPressure'): ContextPressureProjection | undefined
}

/** Props of the dashboard body: projection reads and localized copy. */
export interface PrefillDashboardProps {
  /** Standard projection read seat. */
  readonly useProjection: PrefillProjectionReader
  /** The `prefill` namespace's translate seat. */
  readonly t: TranslateNS<'prefill'>
}

/** One label/value reading in the summary grid. */
function Tile({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className={css.tile}>
      <span className={css.tileLabel}>{label}</span>
      <span className={css.tileValue}>{value}</span>
    </div>
  )
}

/** One row of the cache and token table. */
function UsageRow({ label, total, last }: {
  readonly label: string
  readonly total: string
  readonly last: string
}): ReactNode {
  return (
    <tr>
      <th scope="row" className={css.rowLabel}>{label}</th>
      <td>{total}</td>
      <td>{last}</td>
    </tr>
  )
}

/** The prefill savings readings, including the file count when the ledger is served. */
function SavingsReadings({ savings, fileCount, t }: {
  readonly savings: PrefillSavingsView
  readonly fileCount: number | undefined
  readonly t: PrefillTranslate
}): ReactNode {
  return (
    <>
      <div className={css.tiles}>
        <Tile label={t('savings.files')} value={fileCount === undefined ? t('value.none') : formatCount(fileCount)} />
        <Tile label={t('savings.visible')} value={formatCount(savings.visibleTokens)} />
        <Tile label={t('savings.injected')} value={formatCount(savings.injectedTokens)} />
        <Tile label={t('savings.reused')} value={formatCount(savings.reusedTokens)} />
        <Tile label={t('savings.saved')} value={formatCount(savings.savedTokens)} />
        <Tile label={t('savings.time')} value={formatDuration(savings.savedMs, t)} />
      </div>
      <p className={css.note}>{t('savings.note', { rate: formatCount(savings.tokensPerSecond) })}</p>
      {savings.savedTokens === 0 ? <p className={css.note}>{t('savings.pending')}</p> : null}
    </>
  )
}

/** The files the visible prefill snapshot carries, with the scan that produced them. */
function FilesSection({ ledger, t }: {
  readonly ledger: PrefillLedgerView | undefined
  readonly t: PrefillTranslate
}): ReactNode {
  if (ledger === undefined || ledger.root === null) {
    return <p className={css.note}>{t('savings.noSnapshot')}</p>
  }
  return (
    <div className={css.subsection}>
      <h3 className={css.subheading}>{t('savings.filesTitle', { count: ledger.files.length })}</h3>
      <dl className={css.meta}>
        <div className={css.metaRow}>
          <dt>{t('savings.root')}</dt>
          <dd className={css.path}>{ledger.root}</dd>
        </div>
        <div className={css.metaRow}>
          <dt>{t('savings.lastScan')}</dt>
          <dd>{ledger.lastScanTurn === null ? t('value.none') : t('savings.turn', { turn: ledger.lastScanTurn })}</dd>
        </div>
      </dl>
      {ledger.files.length === 0
        ? <p className={css.note}>{t('savings.noFiles')}</p>
        : (
          <ul className={css.files}>
            {ledger.files.map(file => (
              <li key={file.path} className={css.file}>
                <span className={css.filePath}>{file.path}</span>
                <span className={css.fileBytes}>{formatBytes(file.bytes, t)}</span>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

/** The session total and newest request, side by side in four disjoint buckets. */
function TokensSection({ usage, t }: {
  readonly usage: TokenUsageProjection | undefined
  readonly t: PrefillTranslate
}): ReactNode {
  if (usage === undefined || usage.last === undefined) {
    return <p className={css.note}>{t('tokens.unavailable')}</p>
  }
  const last = usage.last
  const totalPrompt = billedInput(usage)
  const lastPrompt = billedInput(last)
  const none = t('value.none')
  return (
    <>
      <table className={css.table}>
        <thead>
          <tr>
            <th scope="col" className={css.rowLabel}>{t('tokens.metric')}</th>
            <th scope="col">{t('tokens.session')}</th>
            <th scope="col">{t('tokens.last')}</th>
          </tr>
        </thead>
        <tbody>
          <UsageRow label={t('tokens.prompt')} total={formatCount(totalPrompt)} last={formatCount(lastPrompt)} />
          <UsageRow label={t('tokens.uncached')} total={formatCount(usage.uncachedInputTokens)} last={formatCount(last.uncachedInputTokens)} />
          <UsageRow label={t('tokens.cacheRead')} total={formatCount(usage.cacheReadTokens)} last={formatCount(last.cacheReadTokens)} />
          <UsageRow label={t('tokens.cacheWrite')} total={formatCount(usage.cacheWriteTokens)} last={formatCount(last.cacheWriteTokens)} />
          <UsageRow
            label={t('tokens.cacheHit')}
            total={formatCacheHit(usage.cacheReadTokens, totalPrompt, t) ?? none}
            last={formatCacheHit(last.cacheReadTokens, lastPrompt, t) ?? none}
          />
          <UsageRow label={t('tokens.output')} total={formatCount(usage.outputTokens)} last={formatCount(last.outputTokens)} />
        </tbody>
      </table>
      <p className={css.note}>{t('tokens.note')}</p>
    </>
  )
}

/** Occupancy of the next request's prompt against the newest advertised window. */
function ContextSection({ pressure, t }: {
  readonly pressure: ContextPressureProjection | undefined
  readonly t: PrefillTranslate
}): ReactNode {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (used === undefined) return <p className={css.note}>{t('context.unavailable')}</p>
  const window = pressure?.contextWindow
  if (window === undefined) {
    return (
      <>
        <p className={css.reading}>{t('context.used', { used: formatCount(used) })}</p>
        <p className={css.note}>{t('context.note')}</p>
      </>
    )
  }
  const percent = Math.min(100, used / window * 100)
  return (
    <>
      <div className={css.meterRow}>
        <span className={css.reading}>{t('context.usedOf', { used: formatCount(used), total: formatCount(window) })}</span>
        <span className={css.percent}>{formatPercent(percent, t)}</span>
      </div>
      <div
        className={css.meter}
        role="progressbar"
        aria-label={t('context.title')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div className={css.meterFill} style={{ width: `${percent}%` }} />
      </div>
      <p className={css.note}>{t('context.note')}</p>
    </>
  )
}

/**
 * Render the prefill, token, and context readings for the current Session.
 * @param props - projection reads and localized copy.
 * @returns the dashboard, or one notice when the host serves none of its keys.
 */
export function PrefillDashboard({ useProjection, t }: PrefillDashboardProps): ReactNode {
  const savings = useProjection('prefillContext')
  const ledger = useProjection('prefillLedger')
  const usage = useProjection('tokenUsage')
  const pressure = useProjection('contextPressure')
  if (savings === undefined && ledger === undefined && usage === undefined && pressure === undefined) {
    return <div className={css.unavailable} role="status">{t('panel.unavailable')}</div>
  }
  return (
    <div className={css.panel}>
      <div className={css.content}>
        <section className={css.section} aria-label={t('savings.title')}>
          <h2 className={css.heading}>{t('savings.title')}</h2>
          {savings === undefined
            ? <p className={css.note}>{t('savings.unavailable')}</p>
            : <SavingsReadings savings={savings} fileCount={ledger?.files.length} t={t} />}
          <FilesSection ledger={ledger} t={t} />
        </section>
        <section className={css.section} aria-label={t('tokens.title')}>
          <h2 className={css.heading}>{t('tokens.title')}</h2>
          <TokensSection usage={usage} t={t} />
        </section>
        <section className={css.section} aria-label={t('context.title')}>
          <h2 className={css.heading}>{t('context.title')}</h2>
          <ContextSection pressure={pressure} t={t} />
        </section>
      </div>
    </div>
  )
}
