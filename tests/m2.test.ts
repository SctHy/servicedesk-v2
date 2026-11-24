import { it, expect } from 'bun:test'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { Vault } from '../src/privacy/vault'
import { MemoryStore, PgStore } from '../src/db/store'
import { compare } from '../src/adapters/demo'
import { application } from '../src/http/app'
import { mockStream } from '../src/investigation/mock'
import { privacyReport } from '../src/eval/privacy'

it('distinguishes aliases, namesakes and missing directory identity', async () => {
  const a = { name: '李明', email: 'one@corp.example', employeeId: 'EMP-201' }
  const b = { ...a, email: 'two@corp.example', employeeId: 'EMP-202' }
  const auth = { tenant_id: 'demo', actor_id: 'tester', department_id: 'it' }
  const t = { ...auth, id: crypto.randomUUID(), scenario: 'B' as const }
  const v = await Vault.open(new MemoryStore(), t, randomBytes(32))
  const p = await v.project(a),
    q = await v.project(b)
  expect(p.email).not.toBe(q.email)
  expect(p.employeeId).not.toBe(q.employeeId)
  for (const [other, expected] of [
    [a.employeeId, true],
    [b.employeeId, false],
    [undefined, 'unknown'],
  ] as const)
    expect(compare(a.email, b.email, a.employeeId, other)).toEqual({
      sameMailbox: false,
      samePrincipal: expected,
    })
  expect(() => v.resolve(auth, t.id, p.employeeId, 'EMAIL')).toThrow()
  expect(() => v.resolve(auth, crypto.randomUUID(), p.email, 'EMAIL')).toThrow()
})

it('measures masking on labeled inputs and paired root causes', async () => {
  expect(await privacyReport()).toEqual({
    recall: {
      email: 1,
      phone: 1,
      employeeId: 1,
      secret: 1,
      unfamiliarChineseName: 0,
    },
    diagnosticChangeRate: 0,
    toolRestoreRate: 1,
    rootCauseConsistency: 1,
  })
})

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'PG concurrent creation, network disconnect, restart and exact replay',
  async () => {
    const db = new PgStore(
      new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }),
    )
    await db.migrate()
    const key = randomBytes(32),
      headers = { 'x-demo-user': 'alice' }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let app = await application(db, key, async (...args) => {
      await gate
      return mockStream()(...args)
    })
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 })
      const t = (
        await app.inject({
          method: 'POST',
          url: '/api/tickets',
          headers,
          payload: { scenario: 'A' },
        })
      ).json()
      const start = (message: string) =>
        app.inject({
          method: 'POST',
          url: '/api/tickets/' + t.id + '/runs',
          headers,
          payload: { client_request_id: 'one', message },
        })
      const results = await Promise.all(
        Array.from({ length: 32 }, () => start('调查 403')),
      )
      expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1)
      const { runId } = results[0].json()
      expect(results.every((r) => r.json().runId === runId)).toBe(true)
      expect(await db.rows('runs', { ticket_id: t.id })).toHaveLength(1)
      expect((await start('改内容')).statusCode).toBe(409)
      const url = '/api/runs/' + runId + '/events',
        controller = new AbortController()
      const response = await fetch(origin + url, {
        headers,
        signal: controller.signal,
      })
      const reader = response.body!.getReader()
      let prefix = ''
      while (!prefix.includes('\n\n'))
        prefix += new TextDecoder().decode((await reader.read()).value)
      const cursor = Number(prefix.match(/^id: (\d+)/)![1])
      controller.abort()
      release()
      await app.close()
      const events = (await db.rows('run_events', { run_id: runId })).sort(
        (a, b) => a.seq - b.seq,
      )
      expect(events.at(-1)?.data.type).toBe('final')
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
      app = await application(db, key, mockStream())
      const resumed = await app.inject({
        url,
        headers: { ...headers, 'last-event-id': String(cursor) },
      })
      expect(resumed.body).toBe(
        events
          .filter((e) => e.seq > cursor)
          .map(
            (e) =>
              'id: ' + e.seq + '\ndata: ' + JSON.stringify(e.data) + '\n\n',
          )
          .join(''),
      )
    } finally {
      release()
      await app.close()
      await db.pool.end()
    }
  },
)

it('configures Pi DeepSeek completions for tool-call continuation', async () => {
  const { investigationModel } = await import('../src/investigation/engine')
  expect(
    investigationModel('https://api.deepseek.com/v1', 'deepseek-flash'),
  ).toMatchObject({
    provider: 'deepseek',
    id: 'deepseek-flash',
    reasoning: true,
    api: 'openai-completions',
    compat: { supportsStrictMode: false, maxTokensField: 'max_tokens' },
  })
})

it('rejects extra tool fields before reading the adapter', async () => {
  const { investigate } = await import('../src/investigation/engine')
  const { createAssistantMessageEventStream } =
    await import('@mariozechner/pi-ai')
  const db = new MemoryStore(),
    auth = { tenant_id: 'test', actor_id: 'tester', department_id: 'it' }
  const t = { ...auth, scenario: 'A' as const, id: crypto.randomUUID() }
  await db.add('tickets', t)
  let rejected = false
  await investigate(
    db,
    auth,
    t,
    '检查账号',
    randomBytes(32),
    async () => {},
    async (m, c, o) => {
      if (c.messages.some((msg) => msg.role === 'toolResult' && msg.isError)) {
        rejected = true
        return mockStream()(m, c, o)
      }
      const msg = await (await mockStream()(m, c, o)).result()
      if (msg.stopReason === 'toolUse') {
        msg.content = msg.content.slice(0, 1)
        const call = msg.content[0]
        if (call.type === 'toolCall') call.arguments.unexpected = 'value'
      }
      const stream = createAssistantMessageEventStream()
      stream.push({ type: 'done', reason: msg.stopReason, message: msg })
      stream.end(msg)
      return stream
    },
  )
  expect(rejected).toBe(true)
  expect(await db.rows('evidence', { ticket_id: t.id })).toHaveLength(4)
})

it('accepts typographic variants of a single decision without inferring a code from prose', async () => {
  const { parseDecision } = await import('../src/eval/paired')
  expect(parseDecision('**Decision**：`license_ok`')).toBe('LICENSE_OK')
  expect(parseDecision('LICENSE_OK')).toBeNull()
  expect(parseDecision('DECISION=NEW_CODE')).toBeNull()
  expect(parseDecision('DECISION=LICENSE_OK\nDECISION=CHECK_ACCESS')).toBeNull()
})
