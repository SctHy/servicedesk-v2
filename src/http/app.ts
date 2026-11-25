import { TenantScope } from '../db/tenant.js'
import { Metrics } from './metrics.js'
import { traceparent } from './trace.js'
import { verifyToken } from './auth.js'
import type { FastifyRequest } from 'fastify'
import type { PermissionsAdapter } from '../changes/permissions.js'
import { DemoPermissions, Executor } from '../changes/executor.js'
import { draft, decide, privileged } from '../changes/service.js'
import Fastify, { LogController } from 'fastify'
import { createHash } from 'node:crypto'
import { events, listenChanges, notify } from './events.js'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { PgStore } from '../db/store.js'
import type { Auth, Store, Run, Ticket, Event } from '../db/store.js'
import { seed } from '../retrieval/lexical.js'
import { Type } from 'typebox'
import type { InvestigationSource } from '../adapters/source.js'
import { fixture } from '../adapters/demo.js'
import { appName, viewer } from '../changes/service.js'
import type { Change } from '../changes/types.js'
import { investigate, staleEvidence } from '../investigation/engine.js'

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
  ['guest', { tenant_id: 'other', actor_id: 'guest', department_id: 'finance' }],
])
const demoAuth = (id: unknown) => (typeof id === 'string' ? users.get(id) : undefined)
export async function application(
  db: Store,
  key: Buffer,
  transport?: StreamFn,
  authenticate: (id: unknown) => Auth | undefined = demoAuth,
  permissions: PermissionsAdapter = new DemoPermissions(db),
) {
  const app = Fastify({
    logger: {
      level:
        process.env.LOG_LEVEL ??
        ([process.env.NODE_ENV, process.env.BUN_ENV].includes('test') ? 'silent' : 'info'),
      serializers: {
        err: () => ({ type: 'Error', message: 'Request failed', stack: '' }),
        req: () => ({}),
        res: (r) => ({ statusCode: r.statusCode }),
      },
    },
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'traceparent' }),
    genReqId: (req) => traceparent(req.headers.traceparent),
    requestIdHeader: false,
    bodyLimit: 32_768,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  })
  app.addHook('onRequest', async (req, reply) => {
    reply.header('traceparent', req.id)
  })
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ statusCode: reply.statusCode }, 'Request completed')
  })
  const metrics = new Metrics()
  await seed(db)
  // A single process owns every investigation. Close interrupted event streams
  // after a restart so reconnecting subscribers receive a terminal event.
  await db.query(
    `INSERT INTO run_events(run_id, seq, data)
    SELECT r.id, coalesce(max(e.seq),0)+1, $1::jsonb FROM runs r
    LEFT JOIN run_events e ON e.run_id=r.id GROUP BY r.id
    HAVING NOT coalesce(bool_or(e.data->>'type' IN ('final','error')),false)`,
    [JSON.stringify({ type: 'error', text: '服务已重启，请发起新一轮调查。' })],
  )
  const bus = events(db)
  const shutdown = new AbortController()
  app.addHook('preClose', async () => shutdown.abort())
  const queues = new Map<string, Promise<void>>()
  const scope = (a: Auth) => ({ tenant_id: a.tenant_id, actor_id: a.actor_id })
  const fail = (statusCode: number, message: string) => Object.assign(Error(message), { statusCode })
  const owner = (req: FastifyRequest) => {
    const a =
      req.headers.authorization !== undefined
        ? verifyToken(req.headers.authorization, key)
        : process.env.ALLOW_DEMO_AUTH !== '0'
          ? authenticate(req.headers['x-demo-user'])
          : undefined
    if (!a) throw fail(401, 'Unknown identity')
    return a
  }
  async function ticket(id: string, a: Auth) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw fail(404, 'Unknown ticket')
    const [t] = await new TenantScope(db, a.tenant_id).rows('tickets', { actor_id: a.actor_id, id })
    if (!t) throw fail(404, 'Unknown ticket')
    return t
  }
  const executor = new Executor(db, permissions, undefined, (tenant, action) => {
    metrics.for(tenant)[`jobs_${action}`]++
  })
  let active: Promise<void> | undefined
  let pending = false
  let timer: NodeJS.Timeout | undefined
  const wake = () => {
    if (shutdown.signal.aborted) return
    clearTimeout(timer)
    if (active) {
      pending = true
      return
    }
    active = executor
      .run()
      .then(async () => {
        const [next] = await db.query<{
          due: string | null
        }>(`SELECT min(CASE WHEN status='running'
        THEN lease_until ELSE run_at END) AS due FROM jobs j WHERE status IN ('running','queued')
        AND NOT EXISTS (SELECT 1 FROM jobs s WHERE s.resource_key=j.resource_key AND s.id<>j.id
          AND s.status IN ('running','manual_review'))`)
        const delay = Math.min(
          next.due ? Math.max(1, Date.parse(next.due) - Date.now()) : Infinity,
          db instanceof PgStore ? 30_000 : Infinity,
        )
        if (Number.isFinite(delay)) timer = setTimeout(wake, Math.min(delay, 2_147_483_647)).unref()
      })
      .catch(() => {
        app.log.error('Change executor scan failed')
        timer = setTimeout(wake, 5000).unref()
      })
      .finally(() => {
        active = undefined
        if (pending) {
          pending = false
          wake()
        }
      })
  }
  const stopListening = db instanceof PgStore ? await listenChanges(db) : undefined
  bus.on('jobs', wake)
  wake()
  const idParams = Type.Object({ id: Type.String() })
  const body = (fields: Parameters<typeof Type.Object>[0]) =>
    Type.Object(fields, { additionalProperties: false })
  const visible = (c: Change, a: Auth) =>
    c.tenant_id === a.tenant_id &&
    (privileged(a) || a.actor_id === c.requester_id || a.actor_id === c.beneficiary_principal)
  app.get('/api/metrics', async (req) => ({ ...metrics.for(owner(req).tenant_id) }))
  const local = () => {
    if (!(permissions instanceof DemoPermissions)) throw fail(404, 'Demo controls unavailable')
    return permissions
  }
  app.get('/api/changes', async (req) => {
    const a = owner(req)
    return new TenantScope(db, a.tenant_id).visibleChanges(a.actor_id, privileged(a))
  })
  app.get<{ Params: { id: string } }>(
    '/api/changes/:id/audit',
    { schema: { params: idParams } },
    async (req) => {
      const a = owner(req)
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(req.params.id))
        throw fail(404, 'Unknown change')
      const [c] = await new TenantScope(db, a.tenant_id).rows('changes', {
        id: req.params.id,
      })
      if (!c || !visible(c, a)) throw fail(404, 'Unknown change')
      return (await new TenantScope(db, a.tenant_id).children('change_audit', c.id)).sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      )
    },
  )
  app.post<{
    Params: { id: string }
    Body: { session: 'normal' | 'wrong_account' }
  }>(
    '/api/demo/tickets/:id/session',
    {
      schema: {
        params: idParams,
        body: body({
          session: Type.Union([Type.Literal('normal'), Type.Literal('wrong_account')]),
        }),
      },
    },
    async (req) => {
      const t = await ticket(req.params.id, owner(req))
      local()
      if (t.scenario !== 'B') throw fail(400, 'Scenario B required')
      await new TenantScope(db, t.tenant_id).setSession(t.id, req.body.session)
      notify(db, t.tenant_id, 'ticket', t.id)
      return req.body
    },
  )
  app.get('/api/demo/fault', async (req) => {
    owner(req)
    return { fault: local().fault ?? 'none' }
  })
  app.post<{ Body: { fault: 'none' | 'unknown_external_state' } }>(
    '/api/demo/fault',
    {
      schema: {
        body: body({
          fault: Type.Union([Type.Literal('none'), Type.Literal('unknown_external_state')]),
        }),
      },
    },
    async (req) => {
      const a = owner(req)
      if (a.tenant_id !== 'demo') throw fail(403, 'Demo tenant required')
      local().fault = req.body.fault === 'none' ? undefined : req.body.fault
      notify(db, a.tenant_id, 'fault')
      return req.body
    },
  )
  app.post<{
    Body: { app: string; role: string; reason: string; ttl_minutes?: number }
  }>(
    '/api/changes',
    {
      schema: {
        body: body({
          app: Type.String(),
          role: Type.String(),
          reason: Type.String(),
          ttl_minutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10080 })),
        }),
      },
    },
    async (req, reply) => {
      const a = owner(req)
      return reply.code(201).send(await draft(db, a, req.body))
    },
  )
  for (const path of ['decision', 'resolve']) {
    app.post<{ Params: { id: string }; Body: Parameters<typeof decide>[3] }>(
      '/api/changes/:id/' + path,
      {
        schema: {
          params: idParams,
          body: body({
            decision: Type.String(),
            payload_hash: Type.Optional(Type.String()),
            note: Type.Optional(Type.String()),
          }),
        },
      },
      async (req) => {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(req.params.id))
          throw fail(404, 'Unknown change')
        const auth = owner(req)
        const result = await decide(db, auth, req.params.id, req.body, path === 'resolve', req.id)
        if (path === 'resolve' && (result.status === 'succeeded' || result.status === 'revoked'))
          metrics.for(auth.tenant_id)[`jobs_${result.status}`]++
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
    {
      schema: {
        body: body({
          scenario: Type.Union([Type.Literal('A'), Type.Literal('B')]),
        }),
      },
    },
    async (req, reply) => {
      const a = owner(req)
      if (!['A', 'B'].includes(req.body?.scenario)) throw fail(400, 'Invalid scenario')
      const t = {
        id: crypto.randomUUID(),
        ...scope(a),
        scenario: req.body.scenario,
      }
      await new TenantScope(db, a.tenant_id).add('tickets', t)
      notify(db, t.tenant_id, 'ticket', t.id)
      return reply.code(201).send(t)
    },
  )
  app.get('/api/tickets', (req) => {
    const a = owner(req)
    return new TenantScope(db, a.tenant_id).rows('tickets', { actor_id: a.actor_id })
  })
  app.get<{ Params: { id: string } }>('/api/tickets/:id', { schema: { params: idParams } }, async (req) => {
    const t = await ticket(req.params.id, owner(req))
    const tenant = new TenantScope(db, t.tenant_id)
    const changes = await tenant.rows('changes', { ticket_id: t.id })
    const watermark = await tenant.permissionWatermark(t.id)
    return {
      ...t,
      changes,
      session: t.session ?? 'normal',
      demo: permissions instanceof DemoPermissions,
      evidence: (await tenant.children('evidence', t.id)).map((e) => ({
        ...e,
        stale: staleEvidence(e, watermark, t.session_updated_at),
      })),
      runs: (await tenant.rows('runs', { ticket_id: t.id })).sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      ),
    }
  })
  app.post<{
    Params: { id: string }
    Body: { message: string; client_request_id: string }
  }>(
    '/api/tickets/:id/runs',
    {
      schema: {
        params: idParams,
        body: body({
          message: Type.String(),
          client_request_id: Type.String(),
        }),
      },
    },
    async (req, reply) => {
      const a = owner(req),
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
      const { run, created } = await new TenantScope(db, a.tenant_id).locked(
        'request:' + t.id,
        async (tx) => {
          const [existing] = await tx.rows('runs', filter)
          if (existing) {
            if (existing.request_fingerprint !== fingerprint) throw fail(409, 'Request content changed')
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
        },
      )
      if (created) {
        metrics.for(a.tenant_id).runs_total++
        let seq = 0
        const emit = async (data: Event['data']) => {
          await new TenantScope(db, a.tenant_id).addChild('run_events', {
            run_id: run.id,
            seq: ++seq,
            data,
          })
          bus.emit('run:' + run.id)
          if (['final', 'error'].includes(data.type)) notify(db, t.tenant_id, 'ticket', t.id)
        }
        const task = (queues.get(t.id) ?? Promise.resolve())
          .catch(() => {})
          .then(async () => {
            try {
              await emit({ type: 'started' })
              const source: InvestigationSource = fixture(t.scenario)
              if (t.scenario === 'B' && permissions instanceof DemoPermissions) {
                const current = await ticket(t.id, a)
                source.sessionUpdatedAt = current.session_updated_at ?? undefined
                source.get_login_sessions = async (email) => {
                  const wrong = (await ticket(t.id, a)).session === 'wrong_account'
                  const granted = await permissions.read(
                    JSON.stringify([a.tenant_id, appName, 'bob']),
                    viewer,
                  )
                  return fixture('B', {
                    webStatus: granted ? 200 : 403,
                    desktopStatus: !wrong && granted ? 200 : 403,
                    ...(wrong && {
                      principal: 'external-71',
                      sessionEmail: 'other@personal.example',
                    }),
                  }).get_login_sessions(email)
                }
              }
              const usage = await investigate(
                db,
                a,
                t,
                message,
                key,
                emit,
                transport,
                source,
                undefined,
                true,
                { signal: shutdown.signal },
                permissions,
                req.id,
              )
              metrics.usage(a.tenant_id, usage)
            } catch (err) {
              metrics.for(a.tenant_id).runs_failed++
              if (err instanceof Error && 'usage' in err)
                metrics.usage(a.tenant_id, err.usage as Awaited<ReturnType<typeof investigate>>)
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
    },
  )
  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/events',
    { schema: { params: Type.Object({ runId: Type.String() }) } },
    async (req, reply) => {
      const a = owner(req),
        id = req.params.runId
      if (
        !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ||
        !(await new TenantScope(db, a.tenant_id).rows('runs', { actor_id: a.actor_id, id })).length
      )
        throw fail(404, 'Unknown run')
      let cursor = Number(req.headers['last-event-id'] ?? 0)
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw fail(400, 'Invalid event cursor')
      reply.hijack()
      reply.raw.writeHead(200, {
        traceparent: req.id,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
      const tenant = new TenantScope(db, a.tenant_id)
      const channel = 'run:' + id
      let dirty = true,
        reading = false,
        closed = false
      const end = () => {
        closed = true
        bus.off(channel, wakeRun)
        shutdown.signal.removeEventListener('abort', end)
        reply.raw.end()
      }
      async function wakeRun() {
        dirty = true
        if (reading || closed) return
        reading = true
        try {
          do {
            dirty = false
            const batch = await tenant.replay(id, cursor)
            for (const e of batch) {
              if (closed) return
              reply.raw.write('id: ' + e.seq + '\ndata: ' + JSON.stringify(e.data) + '\n\n')
              cursor = e.seq
              if (['final', 'error'].includes(e.data.type)) return end()
            }
            if (!batch.length && cursor && (await tenant.ended(id, cursor))) return end()
          } while (dirty && !closed)
        } catch {
          end()
        } finally {
          reading = false
        }
      }
      bus.on(channel, wakeRun)
      reply.raw.once('close', end)
      shutdown.signal.addEventListener('abort', end)
      await wakeRun()
    },
  )
  app.get('/api/events', async (req, reply) => {
    const channel = 'tenant:' + owner(req).tenant_id
    reply.hijack()
    reply.raw.writeHead(200, {
      traceparent: req.id,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    })
    const send = (event: unknown) => reply.raw.write('data: ' + JSON.stringify(event) + '\n\n')
    bus.on(channel, send)
    reply.raw.write(': connected\n\n')
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000)
    const end = () => {
      bus.off(channel, send)
      clearInterval(heartbeat)
      shutdown.signal.removeEventListener('abort', end)
      reply.raw.end()
    }
    reply.raw.once('close', end)
    shutdown.signal.addEventListener('abort', end)
  })
  app.addHook('onClose', async () => {
    bus.off('jobs', wake)
    await stopListening?.()
    await active
    clearTimeout(timer)
    await Promise.allSettled(queues.values())
  })
  return app
}
