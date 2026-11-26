import { describe, it, expect, afterAll, beforeAll } from 'bun:test'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import {
  MemoryStore,
  PgStore,
  type Store,
  type Ticket,
} from '../src/db/store.js'
import { Vault } from '../src/privacy/vault.js'
import { compare } from '../src/adapters/demo.js'
import { Lexical, seed } from '../src/retrieval/lexical.js'
import { mockStream } from '../src/investigation/mock.js'
import { application } from '../src/http/app.js'
const auth = { tenant_id: 'demo', actor_id: 'alice', department_id: 'it' },
  key = randomBytes(32)
const fresh = (): Ticket => ({
  id: crypto.randomUUID(),
  tenant_id: 'demo',
  actor_id: 'alice',
  scenario: 'A',
})
it('applies field policy, scoped authenticated encryption, and contextual secret detection', async () => {
  await using db = new MemoryStore()
  const t = fresh()
  await db.add("tickets", t)
  const v = await Vault.open(db, t, key)
  const hash = '2b37d91e559c2af96f4a5dd5923a75263777ad00'
  expect(
    await v.project({
      email: 'alice@corp.example',
      employeeId: 'EMP-101',
      name: 'Alice',
      secret: 'never',
      diagnostic: {
        traceId: hash,
        commitHash: hash,
        errorCode: 403,
        other: 'drop',
      },
    }),
  ).toEqual({
    email: '[EMAIL_1]',
    employeeId: '[EMP_1]',
    name: '[NAME_1]',
    diagnostic: { traceId: hash, commitHash: hash, errorCode: 403 },
  })
  expect(
    await v.text(
      'Alice EMP-101 13800138000 bob@example.org token=' +
        hash +
        ' ' +
        hash +
        ' v2.1.4 403',
    ),
  ).toBe(
    '[NAME_1] [EMP_1] [PHONE_1] [EMAIL_2] [REDACTED] ' + hash + ' v2.1.4 403',
  )
  const emails = ['first@corp.example', 'second@corp.example', 'first@corp.example']
  const refs = await Promise.all(emails.map(email => v.bind('EMAIL', email)))
  expect(refs[0]).toBe(refs[2])
  expect(refs[0]).not.toBe(refs[1])
  await v.bind('NAME', 'Agent mail')
  expect(await v.preview('Agent mail@outside.example。')).not.toContain('outside')
  const sensitive = '联系 Alice、EMP-101、13800138000 或 private@corp.example。token="split。key"'
  for (let end = 1; end <= sensitive.length; end++) {
    const preview = await v.preview('已核实。' + sensitive.slice(0, end))
    expect(preview).not.toMatch(/Alic|EMP-10|13800|private|corp\.example|split|key/)
  }
  const restored = await Vault.open(db, t, key)
  expect(restored.resolve(auth, t.id, '[EMAIL_1]', 'EMAIL')).toBe(
    'alice@corp.example',
  )
  expect(() => v.resolve(auth, fresh().id, '[EMAIL_1]', 'EMAIL')).toThrow()
  expect(() =>
    v.resolve({ ...auth, actor_id: 'bob' }, t.id, '[EMAIL_1]', 'EMAIL'),
  ).toThrow()
  expect(() => v.resolve(auth, t.id, '[EMAIL_9]', 'EMAIL')).toThrow()
  expect(JSON.stringify(await db.rows('mask_bindings', {}))).not.toContain(
    'corp.example',
  )
  expect(compare('a', 'b', 'id', 'id')).toEqual({
    sameMailbox: false,
    samePrincipal: true,
  })
  expect(compare()).toEqual({
    sameMailbox: 'unknown',
    samePrincipal: 'unknown',
  })
})
it('filters ACL before ranking and weights exact status code', async () => {
  await using db = new MemoryStore()
  await seed(db)
  await db.add('kb_chunks', {
    id: '503',
    tenant_id: 'demo',
    department_id: 'it',
    visibility: 'department',
    code: '503',
    app: 'other',
    body: '403',
  })
  expect((await new Lexical(db).search(auth, '403')).map((d) => d.id)).toEqual([
    'desktop',
    'viewer',
    '503',
  ])
  expect(
    await new Lexical(db).search({ ...auth, tenant_id: 'other' }, '403'),
  ).toEqual([])
})
for (const backend of ['memory', 'postgres']) {
  describe.skipIf(backend === 'postgres' && !process.env.TEST_DATABASE_URL)(
    backend,
    () => {
      let db: Store,
        pgdb: PgStore | undefined,
        app: Awaited<ReturnType<typeof application>>
      const captured: string[] = []
      beforeAll(async () => {
        if (backend === 'postgres') {
          pgdb = new PgStore(
            new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }),
          )
          await pgdb.migrate()
          await pgdb.migrate()
        }
        db = pgdb ?? new MemoryStore()
        app = await application(
          db,
          key,
          mockStream((c) => captured.push(JSON.stringify(c))),
        )
      })
      afterAll(async () => {
        await app?.close()
        if (db instanceof MemoryStore) await db.close()
        await pgdb?.pool.end()
      })
      for (const scenario of ['A', 'B']) {
        it(
          'investigates ' + scenario + ' and reuses evidence on follow-up',
          async () => {
            const headers = { 'x-demo-user': 'alice' }
            const create = await app.inject({
              method: 'POST',
              url: '/api/tickets',
              headers,
              payload: { scenario },
            })
            const { id } = create.json()
            const start = (message: string, rid: string) =>
              app.inject({
                method: 'POST',
                url: '/api/tickets/' + id + '/runs',
                headers,
                payload: { message, client_request_id: rid },
              })
            const msg =
              'alice@corp.example 403 Authorization: Bearer supersecretABC12345'
            const [r1, r2] = await Promise.all([
              start(msg, '1'),
              start(msg, '1'),
            ])
            expect(r1.json()).toEqual(r2.json())
            expect((await start('different', '1')).statusCode).toBe(409)
            const events = '/api/runs/' + r1.json().runId + '/events'
            expect(
              (
                await app.inject({
                  url: events,
                  headers: { 'x-demo-user': 'guest' },
                })
              ).statusCode,
            ).toBe(404)
            const stream = await app.inject({ url: events, headers })
            expect(stream.body).toContain(
              scenario === 'A' ? '登错账号' : '建议申请 project-b:viewer',
            )
            const evidence = await db.rows('evidence', { ticket_id: id })
            expect(evidence).toHaveLength(5)
            for (const e of evidence)
              expect(stream.body.trim().split('\n').at(-1)).toContain(e.id)
            expect(
              evidence.find((e) => e.source === 'get_login_sessions')?.data,
            ).toMatchObject({
              sameMailbox: scenario === 'B',
              samePrincipal: scenario === 'B',
            })
            const resumed = await app.inject({
              url: events,
              headers: { ...headers, 'last-event-id': '2' },
            })
            expect(resumed.body).toBe(
              stream.body.slice(stream.body.indexOf('id: 3\n')),
            )
            const second = await start('请引用上轮证据', '2')
            expect(
              (
                await app.inject({
                  url: '/api/runs/' + second.json().runId + '/events',
                  headers,
                })
              ).body,
            ).toContain(evidence[0].id)
            expect(await db.rows('evidence', { ticket_id: id })).toHaveLength(5)
            expect(captured.join('')).not.toMatch(
              /alice|bob@|personal\.example|EMP-10|supersecret/,
            )
            const changes = await db.rows('changes', { ticket_id: id })
            expect(changes).toHaveLength(scenario === 'A' ? 0 : 1)
            for (const c of changes)
              expect(await db.rows('jobs', { change_id: c.id })).toHaveLength(0)
          },
        )
      }
    },
  )
}

it('scrubs system prompt, previous messages, tool results and provider error text before transport', async () => {
  await using db = new MemoryStore()
  const t = fresh()
  await db.add("tickets",t)
  const vault = await Vault.open(db, t, key)
  const raw = 'private@corp.example'
  await vault.bind('EMAIL', raw)
  const { getModel, createAssistantMessageEventStream } =
    await import('@mariozechner/pi-ai')
  const model = getModel('openai', 'gpt-4o-mini')
  let wire = ''
  await vault.gateway((_model, ctx) => {
    wire = JSON.stringify(ctx)
    return createAssistantMessageEventStream()
  })(model, {
    systemPrompt: raw,
    messages: [
      { role: 'user', content: raw, timestamp: 0 },
      {
        role: 'toolResult',
        toolCallId: '1',
        toolName: 'directory',
        isError: true,
        content: [
          {
            type: 'text',
            text: 'failed for ' + raw + ' api_key=sampleKEY123456',
          },
        ],
        timestamp: 0,
      },
    ],
  })
  expect(wire).not.toMatch(/private@|sampleKEY/)
  expect(wire.match(/\[EMAIL_1\]/g)).toHaveLength(3)
})

it('sends a masked request over the OpenAI-compatible HTTP transport', async () => {
  const { default: Fastify } = await import('fastify')
  const endpoint = Fastify()
  let payload = ''
  endpoint.post('/v1/chat/completions', async (req, reply) => {
    payload = JSON.stringify(req.body)
    const chunk = {
      id: 'chat-1',
      model: 'desk-test',
      object: 'chat.completion.chunk',
      created: 1,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '请核实登录账号。' },
          finish_reason: 'stop',
        },
      ],
    }
    const chunks = [
      '请核实登录账号。split@',
      'outside.example 13800',
      '138000 token=split',
      'Key9988',
    ].map((content, i) => ({
      ...chunk,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: i === 3 ? 'stop' : null,
        },
      ],
    }))
    return reply
      .type('text/event-stream')
      .send(
        chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') +
          'data: [DONE]\n\n',
      )
  })
  const previous = { ...process.env }
  const url = await endpoint.listen({ host: '127.0.0.1', port: 0 })
  process.env.MODEL_BASE_URL = url + '/v1'
  process.env.MODEL_API_KEY = 'local-test'
  process.env.MODEL_ID = 'desk-test'
  await using db = new MemoryStore()
  const app = await application(
    db,
    key,
    (await import('@mariozechner/pi-ai')).streamSimple,
  )
  try {
    const headers = { 'x-demo-user': 'alice' }
    const t = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers,
      payload: { scenario: 'A' },
    })
    const run = await app.inject({
      method: 'POST',
      url: '/api/tickets/' + t.json().id + '/runs',
      headers,
      payload: {
        client_request_id: 'local',
        message: 'alice@corp.example 403',
      },
    })
    const events = await app.inject({
      url: '/api/runs/' + run.json().runId + '/events',
      headers,
    })
    expect(events.body).toContain('"reply_preview"')
    expect(events.body).toContain('请核实登录账号。')
    const seqs = [...events.body.matchAll(/^id: (\d+)/gm)].map(m => Number(m[1]))
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
    const persisted = await db.rows('run_events', { run_id: run.json().runId })
    for (const safe of [events.body, JSON.stringify(persisted)]) {
      expect(safe).not.toMatch(
        /split@|outside.example|13800138000|splitKey9988/,
      )
      expect(safe).toContain('[REDACTED]')
    }
    expect(persisted.filter((e) => e.data.type === 'final')).toHaveLength(1)
    expect(payload).toContain('[EMAIL_1]')
    expect(payload).not.toMatch(/alice|corp.example/)
  } finally {
    for (const k of ['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_ID']) {
      if (previous[k] === undefined) delete process.env[k]
      else process.env[k] = previous[k]
    }
    await app.close()
    await endpoint.close()
  }
})

it('adds vault detectors and typed fields while enforcing baseline policy', async () => {
  await using db = new MemoryStore()
  const t = fresh()
  await db.add('tickets', t)
  const v = await Vault.open(db, t, key, {
    extraDetectors: [{ detect: text => [...text.matchAll(/tenant-code/g)].map(m =>
      ({ start: m.index, end: m.index + m[0].length, kind: 'SECRET' })) }],
    extraFieldKinds: { alias: 'NAME', email: 'EMP', password: 'NAME' },
  })
  expect(await v.project({ alias: 'Ada', email: 'one@example.com', password: 'hidden' }))
    .toEqual({ alias: '[NAME_1]', email: '[EMAIL_1]' })
  expect(await v.text('tenant-code password=test two@example.com')).toBe('[REDACTED] [REDACTED] [EMAIL_2]')
})

it('advances tenant-scoped topic watermarks and only invalidates subscribed evidence', async () => {
  const { TenantScope } = await import('../src/db/tenant')
  const { staleEvidence } = await import('../src/investigation/engine')
  await using db = new MemoryStore()
  const t = fresh()
  await db.add('tickets', t)
  const scope = new TenantScope(db, t.tenant_id), other = new TenantScope(db, 'other')
  const old = '2025-01-01T00:00:00.000Z', latest = '2025-01-02T00:00:00.000Z'
  await scope.bumpWatermark(t.id, 'inventory', latest)
  await scope.bumpWatermark(t.id, 'inventory', old)
  expect(await scope.watermarks(t.id)).toEqual({ inventory: latest })
  expect(await other.watermarks(t.id)).toEqual({})
  await expect(other.bumpWatermark(t.id, 'inventory')).rejects.toThrow()
  await scope.setSession(t.id, 'wrong_account')
  const marks = await scope.watermarks(t.id)
  expect(marks.session_state).toBe((await scope.rows('tickets', { id: t.id }))[0].session_updated_at!)
  const e = { ticket_id: t.id, id: crypto.randomUUID(), observed_at: old, source: 'inventory_tool', data: {} }
  expect(staleEvidence(e, marks, ['inventory'])).toBe(true)
  expect(staleEvidence(e, marks)).toBe(false)
  expect(staleEvidence({ ...e, source: 'get_login_sessions' }, marks)).toBe(true)
})
