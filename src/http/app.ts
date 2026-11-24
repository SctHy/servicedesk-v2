import type { PermissionsAdapter } from '../changes/permissions.js'
import { DemoPermissions, Executor } from '../changes/executor.js'
import { draft, decide, privileged } from '../changes/service.js'
import Fastify from 'fastify'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import type { Auth, Store, Run, Ticket, Event } from '../db/store.js'
import { seed } from '../retrieval/lexical.js'
import { investigate } from '../investigation/engine.js'

const users = new Map<string, Auth>([
  [
    'carol',
    {
      tenant_id: 'demo',
      actor_id: 'carol',
      department_id: 'it',
      role: 'approver',
    },
  ],
  ['alice', { tenant_id: 'demo', actor_id: 'alice', department_id: 'it' }],
  ['bob', { tenant_id: 'demo', actor_id: 'bob', department_id: 'it' }],
  [
    'guest',
    { tenant_id: 'other', actor_id: 'guest', department_id: 'finance' },
  ],
])
const demoAuth = (id: unknown) =>
  typeof id === 'string' ? users.get(id) : undefined
export async function application(
  db: Store,
  key: Buffer,
  transport?: StreamFn,
  authenticate: (id: unknown) => Auth | undefined = demoAuth,
  permissions: PermissionsAdapter = new DemoPermissions(db),
) {
  const app = Fastify({ bodyLimit: 32_768 })
  await seed(db)
  // A single process owns every investigation. Close interrupted event streams
  // after a restart so reconnecting subscribers receive a terminal event.
  for (const run of await db.rows('runs', {})) {
    const events = await db.rows('run_events', { run_id: run.id })
    if (!events.some((e) => ['final', 'error'].includes(e.data.type))) {
      await db.add('run_events', {
        run_id: run.id,
        seq: events.reduce((max, e) => Math.max(max, e.seq), 0) + 1,
        data: { type: 'error', text: '服务已重启，请发起新一轮调查。' },
      })
    }
  }
  const shutdown = new AbortController()
  app.addHook('preClose', async () => shutdown.abort())
  const queues = new Map<string, Promise<void>>()
  const scope = (a: Auth) => ({ tenant_id: a.tenant_id, actor_id: a.actor_id })
  const fail = (statusCode: number, message: string) =>
    Object.assign(Error(message), { statusCode })
  const owner = (header: unknown) => {
    const a = authenticate(header)
    if (!a) throw fail(401, 'Unknown identity')
    return a
  }
  async function ticket(id: string, a: Auth) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
      throw fail(404, 'Unknown ticket')
    const [t] = await db.rows('tickets', { ...scope(a), id })
    if (!t) throw fail(404, 'Unknown ticket')
    return t
  }
  const executor = new Executor(db, permissions)
  let active: Promise<void> | undefined
  const wake = () => {
    active ??= executor
      .run()
      .catch(() => app.log.error('Change executor scan failed'))
      .finally(() => {
        active = undefined
      })
  }
  const timer = setInterval(wake, 1000)
  timer.unref()
  wake()
  app.get('/api/changes', async (req) => {
    const a = owner(req.headers['x-demo-user'])
    const changes = await db.rows('changes', { tenant_id: a.tenant_id })
    return changes.filter(
      (c) =>
        privileged(a) ||
        a.actor_id === c.requester_id ||
        a.actor_id === c.beneficiary_principal,
    )
  })
  app.post<{ Body: { app: string; role: string; reason: string } }>(
    '/api/changes',
    async (req, reply) => {
      const a = owner(req.headers['x-demo-user'])
      if (
        Object.keys(req.body ?? {}).some(
          (k) => !['app', 'role', 'reason'].includes(k),
        )
      )
        throw fail(400, 'Unexpected field')
      return reply.code(201).send(await draft(db, a, req.body))
    },
  )
  for (const path of ['decision', 'resolve']) {
    app.post<{ Params: { id: string }; Body: Parameters<typeof decide>[3] }>(
      '/api/changes/:id/' + path,
      async (req) => {
        if (
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(req.params.id)
        )
          throw fail(404, 'Unknown change')
        const result = await decide(
          db,
          owner(req.headers['x-demo-user']),
          req.params.id,
          req.body,
          path === 'resolve',
        )
        wake()
        return result
      },
    )
  }
  app.get('/healthz', async () => ({ ok: true }))
  app.get('/api/demo/scenarios', async () => [
    { id: 'A', title: '桌面端 403，网页正常' },
    { id: 'B', title: '项目 B 只读访问被拒，请勿授予管理员权限' },
  ])
  app.post<{ Body: { scenario: Ticket['scenario'] } }>(
    '/api/tickets',
    async (req, reply) => {
      const a = owner(req.headers['x-demo-user'])
      if (!['A', 'B'].includes(req.body?.scenario))
        throw fail(400, 'Invalid scenario')
      const t = {
        id: crypto.randomUUID(),
        ...scope(a),
        scenario: req.body.scenario,
      }
      await db.add('tickets', t)
      return reply.code(201).send(t)
    },
  )
  app.get('/api/tickets', (req) =>
    db.rows('tickets', scope(owner(req.headers['x-demo-user']))),
  )
  app.get<{ Params: { id: string } }>('/api/tickets/:id', async (req) => {
    const t = await ticket(req.params.id, owner(req.headers['x-demo-user']))
    return {
      ...t,
      evidence: await db.rows('evidence', { ticket_id: t.id }),
      runs: (await db.rows('runs', { ticket_id: t.id })).sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      ),
    }
  })
  app.post<{
    Params: { id: string }
    Body: { message: string; client_request_id: string }
  }>('/api/tickets/:id/runs', async (req, reply) => {
    const a = owner(req.headers['x-demo-user']),
      t = await ticket(req.params.id, a)
    const { message, client_request_id } = req.body ?? {}
    if (
      typeof message !== 'string' ||
      !message.trim() ||
      typeof client_request_id !== 'string' ||
      !client_request_id.trim()
    )
      throw fail(400, 'Missing message or client_request_id')
    const filter = { ...scope(a), ticket_id: t.id, client_request_id }
    const fingerprint = createHash('sha256').update(message).digest('hex')
    const { run, created } = await db.locked('request:' + t.id, async (tx) => {
      const [existing] = await tx.rows('runs', filter)
      if (existing) {
        if (existing.request_fingerprint !== fingerprint)
          throw fail(409, 'Request content changed')
        return { run: existing, created: false }
      }
      const run: Run = {
        ...filter,
        id: crypto.randomUUID(),
        request_fingerprint: fingerprint,
        created_at: new Date().toISOString(),
      }
      await tx.add('runs', run)
      return { run, created: true }
    })
    if (created) {
      let seq = 0
      const emit = (data: Event['data']) =>
        db.add('run_events', { run_id: run.id, seq: ++seq, data })
      const task = (queues.get(t.id) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          try {
            await emit({ type: 'started' })
            await investigate(
              db,
              a,
              t,
              message,
              key,
              emit,
              transport,
              undefined,
              undefined,
              true,
              { signal: shutdown.signal },
              permissions,
            )
          } catch (err) {
            await emit({
              type: 'error',
              text:
                err instanceof Error && err.name === 'TimeoutError'
                  ? '调查超时，请重试。'
                  : '调查中断，请发起新一轮调查。',
            })
          }
        })
      queues.set(t.id, task)
      void task
        .finally(() => {
          if (queues.get(t.id) === task) queues.delete(t.id)
        })
        .catch(() => {})
    }
    return reply.code(created ? 202 : 200).send({ runId: run.id })
  })
  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/events',
    async (req, reply) => {
      const a = owner(req.headers['x-demo-user']),
        id = req.params.runId
      if (
        !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ||
        !(await db.rows('runs', { ...scope(a), id })).length
      )
        throw fail(404, 'Unknown run')
      let cursor = Number(req.headers['last-event-id'] ?? 0)
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw fail(400, 'Invalid event cursor')
      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
      while (!reply.raw.destroyed) {
        const events = (await db.rows('run_events', { run_id: id })).sort(
          (a, b) => a.seq - b.seq,
        )
        for (const e of events)
          if (e.seq > cursor) {
            reply.raw.write(
              'id: ' + e.seq + '\ndata: ' + JSON.stringify(e.data) + '\n\n',
            )
            cursor = e.seq
          }
        if (events.some((e) => ['final', 'error'].includes(e.data.type))) break
        await delay(100)
      }
      reply.raw.end()
    },
  )
  app.addHook('onClose', async () => {
    clearInterval(timer)
    await active
    await Promise.allSettled(queues.values())
  })
  return app
}
