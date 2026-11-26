import { it, expect } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { Type } from 'typebox'
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { entry, Interventions, loadCheckpoint, runHarness } from '../src/harness/runtime'
import { investigationModel } from '../src/model/transport'
import { MemoryStore } from '../src/db/store'
import { Vault } from '../src/privacy/vault'

function respond(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'], errorMessage?: string) {
  const model = investigationModel()
  const message: AssistantMessage = {
    role: 'assistant', api: model.api, model: model.id, provider: model.provider, content, stopReason, errorMessage, timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const stream = createAssistantMessageEventStream()
  if (stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message })
  else stream.push({ type: 'done', reason: 'stop', message })
  stream.end(message)
  return stream
}
async function setup(db: MemoryStore) {
  const ticket = { tenant_id: 'tenant', actor_id: 'owner', id: crypto.randomUUID(), scenario: 'A' as const }
  await db.add('tickets', ticket)
  const vault = await Vault.open(db, ticket, randomBytes(32))
  return { db, vault, model: investigationModel(), signal: AbortSignal.timeout(10000),
    getApiKey: () => 'offline', reasoning: undefined, context: { systemPrompt: 'test', messages: [] },
    emit: () => {}, prompts: [entry({ baseline: 'stable' }), entry({ text: 'old detail' }, true), entry({ question: 'continue' })] }
}
it('retains the prefix and retries an overflow once with stale observations folded', async () => {
  await using db = new MemoryStore()
  const opts = await setup(db)
  const contexts: Context[] = []
  const stream: StreamFn = (_, ctx) => {
    contexts.push(structuredClone(ctx))
    return contexts.length === 1 ? respond([], 'error', 'prompt is too long: 999 tokens > 500 maximum')
      : respond([{ type: 'text', text: 'ok' }], 'stop')
  }
  expect(await runHarness({ ...opts, stream })).toMatchObject({ stopReason: 'stop' })
  expect(contexts).toHaveLength(2)
  expect(contexts[1].messages[0]).toEqual(contexts[0].messages[0])
  expect(JSON.stringify(contexts[0])).toContain('old detail')
  expect(JSON.stringify(contexts[1])).not.toContain('old detail')
  expect(contexts[1].messages.at(-1)?.role).toBe('user')
})
it('checkpoints a finished tool batch before interruption and resumes without replaying it', async () => {
  await using db = new MemoryStore()
  const opts = await setup(db)
  const { ticket } = opts.vault
  const runId = crypto.randomUUID()
  await db.add('runs', { id: runId, tenant_id: ticket.tenant_id, actor_id: ticket.actor_id,
    ticket_id: ticket.id, request_fingerprint: 'test', client_request_id: runId, created_at: new Date().toISOString(), status: 'running' })
  let executions = 0, calls = 0
  const secret = 'pii@example.org'
  const updates: string[] = []
  const options: Parameters<typeof runHarness>[0] = {
    ...opts, runId, progress: async (_, detail) => { updates.push(detail) },
    context: { ...opts.context, tools: [{ name: 'read', label: 'read', description: '', parameters: Type.Object({}),
      async execute(_, __, ___, update) {
        executions++
        const result = { content: [{ type: 'text' as const, text: secret + ' password=hidden。联系人欧阳筱禾' }], details: {} }
        update?.(result)
        return result
      } }] },
    stream: (_, ctx) => {
      if (++calls === 1) return respond([{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }], 'toolUse')
      expect(ctx.messages.at(-1)?.role).toBe('toolResult')
      return respond([{ type: 'text', text: 'finished' }], 'stop')
    },
  }
  await expect(runHarness({ ...options, emit: e => { if (e.type === 'turn_end') throw Error('interrupted') } })).rejects.toThrow('interrupted')
  const [row] = await db.query('SELECT turn,messages FROM run_checkpoints WHERE run_id=$1', [runId])
  expect(row.turn).toBe(1)
  for (const wire of [JSON.stringify(row), ...updates]) {
    expect(wire).not.toContain(secret)
    expect(wire).not.toContain('hidden')
  }
  expect(JSON.stringify(row)).not.toContain('欧阳筱禾')
  expect(updates).toHaveLength(1)
  expect(updates[0]).toContain('[EMAIL_1]')
  const saved = await loadCheckpoint(db, opts.vault, runId)
  expect(JSON.stringify(saved)).toContain('[EMAIL_1]')
  expect(JSON.stringify(saved)).not.toContain(secret)
  expect(await runHarness({ ...options, saved })).toMatchObject({ stopReason: 'stop' })
  expect(calls).toBe(2)
  expect(executions).toBe(1)
})
it('injects sanitized steer and followUp at separate turn boundaries', async () => {
  await using db = new MemoryStore()
  const opts = await setup(db)
  const interventions = new Interventions()
  const contexts: Context[] = []
  await runHarness({ ...opts, interventions, stream: (_, ctx) => {
    if (!contexts.length) {
      interventions.push('steer', 'check owner@example.org')
      interventions.push('followUp', 'then verify password=private')
    }
    contexts.push(structuredClone(ctx))
    return respond([{ type: 'text', text: 'ok' }], 'stop')
  } })
  expect(contexts).toHaveLength(3)
  expect(contexts[1].messages.at(-1)?.content).toBe('check [EMAIL_1]')
  expect(contexts[2].messages.at(-1)?.content).toBe('then verify [REDACTED]')
})

it('checks HTTP intervention ownership and continues a failed run under a new ID', async () => {
  const { application } = await import('../src/http/app')
  const { mockStream } = await import('../src/investigation/mock')
  await using db = new MemoryStore()
  const contexts: Context[] = []
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const app = await application(db, randomBytes(32), async (...args) => {
    contexts.push(structuredClone(args[1]))
    if (contexts.length === 1) { entered.resolve(); await proceed.promise }
    if (contexts.length === 2) throw Error('interrupted')
    return mockStream()(...args)
  })
  const headers = { 'x-demo-user': 'bob' }
  const post = (url: string, payload: object, user = headers) => app.inject({ method: 'POST', url, headers: user, payload })
  try {
    const ticket = (await post('/api/tickets', { scenario: 'A' })).json().id
    const url = '/api/tickets/' + ticket + '/runs'
    const first = (await post(url, { message: '调查', client_request_id: 'initial' })).json().runId
    await entered.promise
    const steer = '/api/runs/' + first + '/steer'
    const payload = { message: 'check owner@example.org' }
    for (const actor of ['guest', 'alice'])
      expect((await post(steer, payload, { 'x-demo-user': actor })).statusCode).toBe(404)
    expect((await post(steer, payload)).statusCode).toBe(202)
    proceed.resolve()
    await app.inject({ url: '/api/runs/' + first + '/events', headers })
    expect(JSON.stringify(contexts[1].messages.at(-1))).toContain('check [EMAIL_')
    const detail = await app.inject({ url: '/api/tickets/' + ticket, headers })
    expect(detail.json().runs[0]).toMatchObject({id:first, status:'failed', has_checkpoint:true})
    const resumed = await post(url, { message: '调查', client_request_id: 'retry', resume_from: first })
    expect(resumed.statusCode).toBe(202)
    const id = resumed.json().runId
    await app.inject({ url: '/api/runs/' + id + '/events', headers })
    expect((await db.rows('runs', { id }))[0].status).toBe('completed')
    expect(contexts[2].messages.at(-1)?.role).toBe('toolResult')
    expect(await db.rows('evidence', { ticket_id: ticket })).toHaveLength(5)
  } finally { proceed.resolve(); await app.close() }
})

it('compacts before transport near the window and stops after one failed overflow retry', async () => {
  await using db = new MemoryStore()
  const opts = await setup(db)
  const contexts: Context[] = []
  await expect(runHarness({ ...opts, model: { ...opts.model, contextWindow: 100 },
    prompts: [opts.prompts[0], entry({ staleText: 'x'.repeat(1000) }, true), opts.prompts[2]],
    stream: (_, ctx) => {
      contexts.push(structuredClone(ctx))
      return respond([], 'error', 'prompt is too long: 999 tokens > 100 maximum')
    },
  })).rejects.toThrow('Context overflow')
  expect(contexts).toHaveLength(2)
  expect(contexts[0].messages).toHaveLength(2)
  expect(JSON.stringify(contexts)).not.toContain('staleText')
})
