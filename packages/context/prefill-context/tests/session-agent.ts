/**
 * Structural Agent stub for specs that call session-backed helpers directly.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'

/**
 * Build the smallest Agent surface the prefill helpers read.
 * @param subject - session the agent owns.
 * @param id - agent identity.
 * @returns an Agent stub bound to `subject`.
 */
export function sessionAgent(subject: Session, id = 'agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session: subject,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('prefill-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}
