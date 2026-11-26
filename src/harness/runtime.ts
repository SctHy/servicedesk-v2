import { runAgentLoop, runAgentLoopContinue, type AgentContext, type AgentEventSink, type AgentLoopConfig, type AgentMessage, type StreamFn, type AfterToolCallResult } from '@mariozechner/pi-agent-core'
import { isContextOverflow, type Message } from '@mariozechner/pi-ai'
import type { Store } from '../db/store.js'
import type { Vault } from '../privacy/vault.js'

interface Entry {
  role: 'timeline'
  value: unknown
  stale?: boolean
  timestamp: number
}
declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages { timeline: Entry }
}
export function entry(value: unknown, stale = false): Entry {
  return { role: 'timeline', value, stale, timestamp: 0 }
}
function project(m: AgentMessage): Message {
  return m.role === 'timeline' ? { role: 'user', content: JSON.stringify(m.value), timestamp: m.timestamp } : m
}
export class Interventions {
  private queues = { steer: [] as string[], followUp: [] as string[] }
  push(kind: 'steer' | 'followUp', text: string) { this.queues[kind].push(text) }
  async drain(kind: 'steer' | 'followUp', vault: Vault): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = []
    for (const text of this.queues[kind].splice(0))
      messages.push({ role: 'user', content: await vault.text(text), timestamp: Date.now() })
    return messages
  }
}
type Saved = { turn: number; messages: AgentMessage[] }
export async function loadCheckpoint(db: Store, vault: Vault, id: string) {
  const [row] = await db.query<{ turn: number; messages: { cipher: string } }>(
    'SELECT c.turn,c.messages FROM run_checkpoints c JOIN runs r ON r.id=c.run_id WHERE c.run_id=$1 AND c.tenant_id=$2 AND r.ticket_id=$3 AND r.actor_id=$4',
    [id, vault.ticket.tenant_id, vault.ticket.id, vault.ticket.actor_id])
  if (!row) throw Error('Checkpoint unavailable')
  const messages = vault.openCheckpoint(id, row.turn, row.messages)
  if (!Array.isArray(messages) || !messages.length) throw Error('Invalid checkpoint')
  return { turn: row.turn, messages } as Saved
}
type Options = {
  context: AgentContext; prompts: AgentMessage[]; model: AgentLoopConfig['model']
  reasoning: AgentLoopConfig['reasoning']; getApiKey: AgentLoopConfig['getApiKey']
  stream: StreamFn; signal: AbortSignal; emit: AgentEventSink; vault: Vault; db: Store
  runId?: string; saved?: Saved; interventions?: Interventions
  progress?: (source: string, detail: string) => Promise<void>
  beforeToolCall?: NonNullable<AgentLoopConfig['beforeToolCall']>[]
  afterToolCall?: NonNullable<AgentLoopConfig['afterToolCall']>[]
}
function compress(messages: AgentMessage[], limit: number) {
  return messages.filter(m => m.role !== 'timeline' || !m.stale).map((m, i) => {
    if (!i) return m
    if (m.role === 'timeline' && m !== messages.at(-1) && JSON.stringify(m.value).length > limit)
      return entry({ excerpt: JSON.stringify(m.value).slice(0, limit) })
    if (m.role === 'toolResult') return { ...m, content: m.content.map(c =>
      c.type === 'text' && c.text.length > limit ? { ...c, text: JSON.stringify({ excerpt: c.text.slice(0, limit) }) } : c) }
    return m
  })
}
// Only persist replayable text and calls. Provider signatures, binary content and
// private reasoning can be opaque and cannot be inspected by text detectors.
async function checkpointMessages(messages: AgentMessage[], vault: Vault) {
  const replay: AgentMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const content: typeof m.content = []
      for (const c of m.content) {
        if (c.type === 'text') content.push({ type: 'text', text: c.text })
        if (c.type === 'toolCall') content.push({ type: 'toolCall', id: c.id, name: c.name,
          arguments: await vault.project(c.arguments) as typeof c.arguments })
      }
      replay.push({ role: m.role, content, model: m.model, api: m.api, provider: m.provider,
        usage: m.usage, timestamp: m.timestamp, stopReason: m.stopReason })
    } else if (m.role === 'toolResult') {
      replay.push({ role: m.role, toolName: m.toolName, toolCallId: m.toolCallId, isError: m.isError,
        timestamp: m.timestamp, content: m.content.filter(c => c.type === 'text').map(c => ({ type: 'text', text: c.text })) })
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      replay.push({ ...m, content: m.content.filter(c => c.type === 'text').map(c => ({ type: 'text', text: c.text })) })
    } else if (m.role === 'timeline') {
      replay.push({ ...m, value: await vault.project(m.value) })
    } else replay.push(m)
  }
  return vault.scrub(replay)
}
export async function runHarness(o: Options) {
  let calls = o.saved?.turn ?? 0
  const messages = [...(o.saved?.messages ?? o.context.messages)]
  let overflow = false, retried = false
  const config: AgentLoopConfig = {
    model: o.model, reasoning: o.reasoning, getApiKey: o.getApiKey, sessionId: o.vault.ticket.id,
    toolExecution: 'parallel', convertToLlm: ms => ms.map(project),
    transformContext: async ms => retried || JSON.stringify(ms).length > o.model.contextWindow * 2.5
      ? compress(ms, Math.max(64, Math.min(retried ? 512 : 2048, Math.floor(o.model.contextWindow / ms.length)))) : ms,
    shouldStopAfterTurn: () => overflow || calls >= 10 || o.signal.aborted,
    getSteeringMessages: async () => o.interventions?.drain('steer', o.vault) ?? [],
    getFollowUpMessages: async () => o.interventions?.drain('followUp', o.vault) ?? [],
    async beforeToolCall(ctx, signal) {
      for (const hook of o.beforeToolCall ?? []) {
        const decision = await hook(ctx, signal)
        if (decision?.block) return decision
      }
    },
    async afterToolCall(ctx, signal) {
      let patch: AfterToolCallResult = {}
      for (const hook of o.afterToolCall ?? []) {
        patch = { ...patch, ...await hook({ ...ctx, result: { ...ctx.result, ...patch }, isError: patch.isError ?? ctx.isError }, signal) }
      }
      return patch
    },
  }
  const emit: AgentEventSink = async e => {
    o.signal.throwIfAborted()
    if (e.type === 'tool_execution_update' && o.progress) {
      const text = e.partialResult?.content?.filter((p: {type: string}) => p.type === 'text')
        .map((p: {text: string}) => p.text).join(' ') ?? ''
      const safe = await o.vault.text(text)
      o.vault.assertSafe(safe)
      await o.progress(await o.vault.text(e.toolName), safe.slice(0, 256))
    }
    if (e.type === 'message_end') messages.push(e.message)
    if (e.type === 'turn_end' && e.message.role === 'assistant') {
      overflow = isContextOverflow(e.message, o.model.contextWindow)
      if (!e.toolResults.length && (overflow || e.message.stopReason !== 'stop')) messages.pop()
      if (o.runId) {
        const safe = await checkpointMessages(messages, o.vault)
        const envelope = o.vault.sealCheckpoint(o.runId, calls, safe)
        const written = await o.db.query(`INSERT INTO run_checkpoints (run_id,tenant_id,turn,messages)
          SELECT id,tenant_id,$4,$5::jsonb FROM runs WHERE id=$1 AND tenant_id=$2 AND ticket_id=$3 AND actor_id=$6 AND status='running'
          ON CONFLICT (run_id) DO UPDATE SET turn=excluded.turn,messages=excluded.messages,updated_at=now()
          WHERE run_checkpoints.turn < excluded.turn RETURNING run_id`,
          [o.runId,o.vault.ticket.tenant_id,o.vault.ticket.id,calls,JSON.stringify(envelope),o.vault.ticket.actor_id])
        if (!written.length) throw Error('Inactive checkpoint writer')
      }
    }
    await o.emit(e)
  }
  const stream: StreamFn = (...args) => {
    o.signal.throwIfAborted()
    if (calls >= 10) throw Error('Model call limit reached')
    calls++
    return o.stream(...args)
  }
  const context = () => ({ ...o.context, messages: [...messages] })
  const last = messages.at(-1)
  if (o.saved && last?.role === 'assistant' && last.stopReason === 'stop') return last
  let result = o.saved ? await runAgentLoopContinue(context(), config, emit, o.signal, stream)
    : await runAgentLoop(o.prompts, context(), config, emit, o.signal, stream)
  if (overflow && calls < 10) {
    o.signal.throwIfAborted()
    retried = true
    result = await runAgentLoopContinue(context(), config, emit, o.signal, stream)
  }
  if (overflow) throw Error('Context overflow')
  return result.at(-1)
}
