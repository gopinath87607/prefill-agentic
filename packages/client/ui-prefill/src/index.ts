/**
 * Prefill dashboard plugin, node half. Pure UI plugin: the empty apply exists
 * so the plugin appears in the host cordis.yml / Loader; the browser half ships
 * via exports["./client"], discovered through the package.json dsh.client
 * declaration. The prefill and token projections it reads are owned by
 * `@deepseek-ai/dsh-prefill-context` and `@deepseek-ai/dsh-token-meter`,
 * composed independently on the host roster.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
