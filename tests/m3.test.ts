import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { MemoryStore, PgStore, type Store, type Auth } from '../src/db/store'
import { application } from '../src/http/app'
import { mockStream } from '../src/investigation/mock'
import { Executor, DemoPermissions } from '../src/changes/executor'
import { investigate } from '../src/investigation/engine'
import { fixture, type Observations } from '../src/adapters/demo'
import { draft, decide, viewer, appName } from '../src/changes/service'

const bob: Auth = { actor_id: 'bob', tenant_id: 'demo', department_id: 'it' }
const carol: Auth = { ...bob, actor_id: 'carol', role: 'approver' }
const input = { app: appName, role: viewer, reason: '读取项目资料' }
for (const pgMode of [false, true]) {
  describe.skipIf(pgMode && !process.env.TEST_DATABASE_URL)(
    pgMode ? 'M3 PostgreSQL' : 'M3 Memory',
    () => {
      let db: Store,
        pool: pg.Pool | undefined,
        admin: pg.Pool | undefined,
        schema: string
      beforeEach(async () => {
        if (!pgMode) {
          db = new MemoryStore()
          return
        }
        schema = 't_' + crypto.randomUUID().replaceAll('-', '')
        admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
        await admin.query('CREATE SCHEMA ' + schema)
        pool = new pg.Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          options: '-c search_path=' + schema,
        })
        const pgdb = new PgStore(pool)
        await pgdb.migrate()
        db = pgdb
      })
      afterEach(async () => {
        if (pool) {
          await pool.end()
          await admin!.query('DROP SCHEMA ' + schema + ' CASCADE')
          await admin!.end()
        }
      })
      async function queue(reason = input.reason) {
        const c = await draft(db, bob, { ...input, reason })
        await decide(db, carol, c.id, {
          payload_hash: c.payload_hash,
          decision: 'approve',
        })
        return (await db.rows('jobs', { change_id: c.id }))[0]
      }
      it('scopes evidence, approvals and ordinary access through HTTP', async () => {
        const app = await application(db, randomBytes(32), mockStream())
        const post = (url: string, payload: object, user = 'bob') =>
          app.inject({
            method: 'POST',
            url,
            headers: { 'x-demo-user': user },
            payload,
          })
        try {
          for (const scenario of ['A', 'B']) {
            const { id } = (await post('/api/tickets', { scenario })).json()
            const { runId } = (
              await post('/api/tickets/' + id + '/runs', {
                message: '调查权限',
                client_request_id: 'm3',
              })
            ).json()
            await app.inject({
              url: '/api/runs/' + runId + '/events',
              headers: { 'x-demo-user': 'bob' },
            })
            const changes = await db.rows('changes', { ticket_id: id })
            expect(changes.length).toBe(scenario === 'A' ? 0 : 1)
            expect(await db.rows('jobs', {})).toHaveLength(0)
            expect(await db.rows('demo_grants', {})).toHaveLength(0)
            if (scenario === 'A') continue
            const c = changes[0]
            expect(c.role).toBe(viewer)
            expect(c.evidence_ids).toHaveLength(2)
            const path = '/api/changes/' + c.id + '/decision'
            const approve = {
              decision: 'approve',
              payload_hash: c.payload_hash,
            }
            expect((await post(path, approve)).statusCode).toBe(403)
            expect(
              (
                await post(
                  path,
                  { ...approve, payload_hash: 'changed' },
                  'carol',
                )
              ).statusCode,
            ).toBe(409)
            expect((await post(path, approve, 'carol')).statusCode).toBe(200)
          }
          expect(
            (await post('/api/changes', { ...input, role: 'admin' }))
              .statusCode,
          ).toBe(403)
          const c = (await post('/api/changes', input, 'alice')).json()
          expect(c.ticket_id).toBeNull()
          expect(
            (
              await post(
                '/api/changes/' + c.id + '/decision',
                { decision: 'approve', payload_hash: c.payload_hash },
                'carol',
              )
            ).statusCode,
          ).toBe(200)
          for (
            let i = 0;
            i < 100 &&
            (await db.rows('jobs', { status: 'succeeded' })).length < 2;
            i++
          )
            await Bun.sleep(25)
          expect(
            await db.rows('changes', { status: 'succeeded' }),
          ).toHaveLength(2)
          expect(await db.rows('demo_grants', {})).toHaveLength(2)
        } finally {
          await app.close()
        }
      })
      it('rechecks a successful change and follows desktop account changes on one ticket', async () => {
        const ticket = {
          actor_id: bob.actor_id,
          tenant_id: bob.tenant_id,
          id: crypto.randomUUID(),
          scenario: 'B' as const,
        }
        await db.add('tickets', ticket)
        const key = randomBytes(32)
        const run = async (question: string, state: Observations = {}) => {
          const events: { type: string; [key: string]: unknown }[] = []
          let leaked = false
          const result = await investigate(
            db,
            bob,
            ticket,
            question,
            key,
            async (e) => {
              events.push(e)
            },
            mockStream((ctx) => {
              leaked ||= /corp\.example|EMP-102|probeOnly/i.test(
                JSON.stringify(ctx),
              )
            }),
            fixture('B', state),
            undefined,
            true,
            { timeoutMs: 3000 },
          )
          expect(leaked).toBe(false)
          expect(result.toolFailures).toBe(0)
          expect(result.toolAttempts).toBeLessThanOrEqual(5)
          const answer = String(events.at(-1)?.text)
          for (const source of ['get_app_permissions', 'get_login_sessions']) {
            const fresh = events.find(
              (e) => e.type === 'evidence' && e.source === source,
            )
            expect(fresh).toBeDefined()
            expect(answer).toContain(String(fresh!.evidenceId))
          }
          return answer
        }
        await run('调查 403 password=probeOnly')
        const [change] = await db.rows('changes', { ticket_id: ticket.id })
        await decide(db, carol, change.id, {
          decision: 'approve',
          payload_hash: change.payload_hash,
        })
        const permissions = new DemoPermissions(db)
        const executor = new Executor(db, permissions)
        await executor.run()
        expect((await db.rows('changes', { id: change.id }))[0].status).toBe(
          'succeeded',
        )
        expect(await run('现在呢？')).toContain('权限已生效')
        const wrong = await run('权限已经批了但还是 403', {
          principal: 'external',
          sessionEmail: 'alias@corp.example',
        })
        expect(wrong).toContain('登错账号')
        expect(wrong).toContain('已拥有 project-b:viewer')
        expect(
          await run('切换回正确账号后重新检查', { desktopStatus: 200 }),
        ).toContain('访问已恢复')
        await executor.run()
        expect(await db.rows('changes', { ticket_id: ticket.id })).toHaveLength(
          1,
        )
        expect(await db.rows('jobs', { change_id: change.id })).toHaveLength(1)
        expect(await db.rows('demo_grants', {})).toMatchObject([
          { role: viewer },
        ])
        expect(permissions.writes).toBe(1)
      })
      it('blocks both reviewer conflicts even with approval authority', async () => {
        const c = await draft(db, carol, input)
        await expect(
          decide(db, carol, c.id, {
            decision: 'approve',
            payload_hash: c.payload_hash,
          }),
        ).rejects.toMatchObject({ statusCode: 403 })
      })
      it('rolls back approval and queue insertion if audit persistence fails', async () => {
        const c = await draft(db, bob, input)
        const failing: Store = {
          rows: db.rows.bind(db),
          add: db.add.bind(db),
          update: db.update.bind(db),
          locked: (key, fn) =>
            db.locked(key, (tx) =>
              fn({
                rows: tx.rows.bind(tx),
                update: tx.update.bind(tx),
                locked: tx.locked.bind(tx),
                add: async (table, row) => {
                  if (table === 'change_audit')
                    throw Error('injected transaction failure')
                  await tx.add(table, row)
                },
              }),
            ),
        }
        await expect(
          decide(failing, carol, c.id, {
            decision: 'approve',
            payload_hash: c.payload_hash,
          }),
        ).rejects.toThrow('injected')
        expect(await db.rows('jobs', { change_id: c.id })).toHaveLength(0)
        expect(
          await db.rows('changes', { id: c.id, status: 'pending_approval' }),
        ).toHaveLength(1)
      })
      it('takes over after a committed grant without repeating the write', async () => {
        const j = await queue(),
          adapter = new DemoPermissions(db)
        adapter.fault = 'crash_after_external_write'
        await new Executor(db, adapter, 100).step(j)
        expect(await db.rows('jobs', { status: 'running' })).toHaveLength(1)
        await Bun.sleep(120)
        await new Executor(db, adapter).run()
        expect(adapter.writes).toBe(1)
        expect((await db.rows('jobs', { id: j.id }))[0]).toMatchObject({
          status: 'succeeded',
          attempt_count: 2,
          version: 3,
        })
      })
      it('requires a privileged documented resolution for unknown state', async () => {
        const j = await queue(),
          adapter = new DemoPermissions(db)
        adapter.fault = 'unknown_external_state'
        await new Executor(db, adapter).run()
        expect(adapter.writes).toBe(0)
        const [c] = await db.rows('changes', { id: j.change_id })
        expect(c.status).toBe('manual_review')
        const body = {
          decision: 'failed',
          payload_hash: c.payload_hash,
          note: '人工核对未授权',
        }
        const app = await application(
          db,
          randomBytes(32),
          mockStream(),
          (id) =>
            id === 'admin'
              ? { ...carol, actor_id: 'admin', role: 'admin' }
              : bob,
        )
        try {
          const resolve = (user: string) =>
            app.inject({
              method: 'POST',
              url: '/api/changes/' + c.id + '/resolve',
              headers: { 'x-demo-user': user },
              payload: body,
            })
          expect((await resolve('bob')).statusCode).toBe(403)
          expect((await resolve('admin')).statusCode).toBe(200)
          expect(
            await db.rows('jobs', { id: j.id, status: 'failed' }),
          ).toHaveLength(1)
          expect(
            await db.rows('change_audit', {
              actor_id: 'admin',
              action: 'failed',
            }),
          ).toHaveLength(1)
        } finally {
          await app.close()
        }
      })
      it('serializes a resource and fences stale versions', async () => {
        const first = await queue('first'),
          second = await queue('second')
        const adapter = new DemoPermissions(db),
          one = new Executor(db, adapter),
          two = new Executor(db, adapter)
        await Promise.all([one.step(first), two.step(second), two.step(first)])
        await two.run()
        await one.step(first)
        expect(adapter.writes).toBe(1)
        expect(
          await db.rows('jobs', { status: 'succeeded', version: 2 }),
        ).toHaveLength(2)
      })
    },
  )
}

it('ends slow runs on deadline and shutdown, releasing the ticket queue', async () => {
  const previous = process.env.INVESTIGATION_TIMEOUT_MS
  process.env.INVESTIGATION_TIMEOUT_MS = '100'
  const db = new MemoryStore()
  let slow = true
  let started!: () => void
  let modelStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const app = await application(db, randomBytes(32), async (...args) => {
    if (slow) {
      slow = false
      started()
      // Even a transport that ignores cancellation cannot hold the queue.
      return new Promise<never>(() => {})
    }
    return mockStream()(...args)
  })
  const headers = { 'x-demo-user': 'bob' }
  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers, payload })
  try {
    const ticket = (await post('/api/tickets', { scenario: 'B' })).json()
    const run = async (id: string) =>
      (
        await post('/api/tickets/' + ticket.id + '/runs', {
          message: '调查',
          client_request_id: id,
        })
      ).json().runId
    const first = await run('slow')
    await modelStarted
    const next = await run('next')
    await app.inject({ url: '/api/runs/' + next + '/events', headers })
    const terminal = async (id: string) =>
      (await db.rows('run_events', { run_id: id })).at(-1)!.data
    expect(await terminal(first)).toMatchObject({
      type: 'error',
      text: expect.stringContaining('超时'),
    })
    expect(await terminal(next)).toMatchObject({ type: 'final' })
    process.env.INVESTIGATION_TIMEOUT_MS = '60000'
    slow = true
    modelStarted = new Promise((resolve) => {
      started = resolve
    })
    const closing = await run('closing')
    await modelStarted
    await app.close()
    expect(await terminal(closing)).toMatchObject({ type: 'error' })
  } finally {
    if (previous === undefined) delete process.env.INVESTIGATION_TIMEOUT_MS
    else process.env.INVESTIGATION_TIMEOUT_MS = previous
    await app.close()
  }
})
