import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { MemoryStore, PgStore, type Store, type Auth } from '../src/db/store'
import { application } from '../src/http/app'
import { mockStream } from '../src/investigation/mock'
import { Executor, DemoPermissions } from '../src/changes/executor'
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
