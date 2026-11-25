import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { MemoryStore, PgStore, type Store, type Auth } from '../src/db/store'
import { application } from '../src/http/app'
import { mockStream } from '../src/investigation/mock'
import { Executor, DemoPermissions } from '../src/changes/executor'
import { HttpPermissions } from '../src/changes/permissions'
import { investigate } from '../src/investigation/engine'
import { fixture, type Observations } from '../src/adapters/demo'
import { draft, decide, viewer, appName } from '../src/changes/service'

const bob: Auth = { actor_id: 'bob', tenant_id: 'demo', department_id: 'it' }
const carol: Auth = { ...bob, actor_id: 'carol', role: 'approver' }
const input = { app: appName, role: viewer, reason: '读取项目资料' }
function permissionServer(mode: 'ok' | 'write-error' | 'unknown' | 'hold' = 'ok') {
  const grants = new Set<string>()
  const traces: (string | null)[] = []
  const methods: string[] = []
  const written = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let writes = 0
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/grants' || req.headers.get('Authorization') !== 'Bearer test')
        return new Response(null, { status: 403 })
      traces.push(req.headers.get('traceparent'))
      methods.push(req.method)
      if (req.method === 'GET')
        return mode === 'unknown' ? new Response(null, { status: 503 }) :
          Response.json({ granted: grants.has(url.searchParams.get('resource_key')!) })
      if (req.method === 'DELETE') {
        if (url.searchParams.get('role') !== viewer) return new Response(null, { status: 400 })
        grants.delete(url.searchParams.get('resource_key')!)
        return new Response(null, { status: mode === 'write-error' ? 503 : 204 })
      }
      const body = await req.json()
      if (req.method !== 'POST' || body.role !== viewer || typeof body.resource_key !== 'string')
        return new Response(null, { status: 400 })
      writes++
      grants.add(body.resource_key)
      written.resolve()
      if (mode === 'hold') await release.promise
      return new Response(null, { status: mode === 'write-error' ? 500 : 204 })
    },
  })
  return {
    url: server.url.href, adapter: new HttpPermissions(server.url.href, 'test'),
    methods, traces, written: written.promise, get writes() { return writes }, release: () => release.resolve(),
    close() { release.resolve(); return server.stop(true) },
  }
}
for (const pgMode of [false, true]) {
  describe.skipIf(pgMode && !process.env.TEST_DATABASE_URL)(
    pgMode ? 'M3 PostgreSQL' : 'M3 Memory',
    () => {
      let db: Store,
        pool: pg.Pool | undefined,
        admin: pg.Pool | undefined,
        schema: string
      let http: ReturnType<typeof permissionServer> | undefined
      beforeEach(async () => {
        if (!pgMode) {
          db = new MemoryStore()
          await db.query('SELECT 1')
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
        await http?.close()
        http = undefined
        if (db instanceof MemoryStore) await db.close()
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
      it('allows a concurrent ticket transaction while grant is suspended', async () => {
        const job = await queue()
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let granted = false
        const executor = new Executor(db, {
          read: async () => granted,
          grant: async () => { entered.resolve(); await release.promise; granted = true },
          revoke: async () => {},
        })
        const running = executor.step(job)
        await entered.promise
        try {
          const id = crypto.randomUUID()
          await db.tx(async tx => {
            await tx.add('tickets', {id, tenant_id:bob.tenant_id, actor_id:bob.actor_id, scenario:'A'})
            expect(await tx.rows('tickets',{id})).toHaveLength(1)
          })
        } finally { release.resolve(); await running }
      })
      for (const overlap of [false, true]) {
        it('recovers expired access with overlap=' + overlap, async () => {
          const adapter = new DemoPermissions(db)
          const executor = new Executor(db, adapter)
          if (overlap) {
            await queue('长期授权')
            await executor.run()
          }
          const c = await draft(db, bob, { ...input, ttl_minutes: 0.01 })
          await decide(db, carol, c.id, { decision: 'approve', payload_hash: c.payload_hash })
          await executor.run()
          const [job] = await db.rows('jobs', { change_id: c.id, kind: 'revoke' })
          expect(job.run_at).toBe(c.expires_at!)
          await executor.step(job)
          expect((await db.rows('changes', { id: c.id }))[0].status).toBe('succeeded')
          await Bun.sleep(Math.max(0, Date.parse(job.run_at) - Date.now() + 5))
          await Promise.all([executor.run(), new Executor(db, adapter).run()])
          expect((await db.rows('changes', { id: c.id }))[0].revoked_at).toBeTruthy()
          expect(await adapter.read(job.resource_key)).toBe(overlap)
          expect(adapter.revokes).toBe(overlap ? 0 : 1)
          expect(await db.rows('change_audit', { change_id: c.id, actor_id: 'system', action: 'revoked' })).toHaveLength(1)
        })
      }
      it('reads back an ambiguous HTTP revoke and avoids a second delete', async () => {
        http = permissionServer('write-error')
        const c = await draft(db, bob, { ...input, ttl_minutes: 0.01 })
        await decide(db, carol, c.id, { decision: 'approve', payload_hash: c.payload_hash })
        const executor = new Executor(db, http.adapter)
        await executor.run()
        await Bun.sleep(Math.max(0, Date.parse(c.expires_at!) - Date.now() + 5))
        await executor.run()
        await executor.run()
        expect(http.methods).toEqual(['GET','POST','GET','GET','DELETE','GET'])
        expect((await db.rows('changes', {id: c.id}))[0].status).toBe('revoked')
      })
      it('requires evidence to close an unknown revoke and records the recovery time', async () => {
        const c = await draft(db, bob, { ...input, ttl_minutes: 0.01 })
        await decide(db, carol, c.id, { decision: 'approve', payload_hash: c.payload_hash })
        const adapter = new DemoPermissions(db)
        const executor = new Executor(db, adapter)
        await executor.run()
        await Bun.sleep(Math.max(0, Date.parse(c.expires_at!) - Date.now() + 5))
        adapter.fault = 'unknown_external_state'
        await executor.run()
        expect(adapter.revokes).toBe(0)
        expect((await db.rows('changes', {id:c.id}))[0].status).toBe('manual_review')
        const [job] = await db.rows('jobs', {change_id:c.id, kind:'revoke'})
        adapter.fault = undefined
        await adapter.revoke(job.resource_key)
        await decide(db, carol, c.id, {decision:'succeeded',payload_hash:c.payload_hash,note:'核对外部角色已移除'},true)
        expect((await db.rows('changes', {id:c.id}))[0].revoked_at).toBeTruthy()
      })
      it('isolates audit and exercises account drift through the HTTP controls', async () => {
        const app = await application(db, randomBytes(32), mockStream())
        const request = (url: string, user: string, payload?: object) => app.inject({
          method: payload ? 'POST' : 'GET', url, headers: { 'x-demo-user': user }, payload,
        })
        try {
          const j = await queue()
          const audit = '/api/changes/' + j.change_id + '/audit'
          for (const user of ['bob','carol']) expect((await request(audit,user)).statusCode).toBe(200)
          for (const user of ['alice','guest']) expect((await request(audit,user)).statusCode).toBe(404)
          expect((await request(audit,'unknown')).statusCode).toBe(401)
          const t = (await request('/api/tickets','bob',{scenario:'B'})).json()
          const path = '/api/demo/tickets/' + t.id + '/session'
          expect((await request(path,'alice',{session:'wrong_account'})).statusCode).toBe(404)
          for (const session of ['wrong_account','normal']) {
            expect((await request(path,'bob',{session})).statusCode).toBe(200)
            if (session === 'normal') {
              const detail = (await request('/api/tickets/' + t.id, 'bob')).json()
              expect(detail.evidence.filter((e: { stale: boolean }) => e.stale)
                .map((e: { source: string }) => e.source)).toEqual(['get_login_sessions'])
            }
            const run = (await request('/api/tickets/'+t.id+'/runs','bob',{
              message:'再看看现在情况怎么样',client_request_id:session,
            })).json()
            await request('/api/runs/'+run.runId+'/events','bob')
            const detail = (await request('/api/tickets/'+t.id,'bob')).json()
            const observations = detail.evidence.filter((e: {source:string})=>e.source==='get_login_sessions')
              .sort((a:{observed_at:string},b:{observed_at:string})=>a.observed_at.localeCompare(b.observed_at))
            expect(observations.at(-1).data.samePrincipal).toBe(session==='normal')
            expect(observations.at(-1).stale).toBe(false)
            expect(detail.evidence.filter((e: {source:string}) => e.source === 'get_app_permissions')).toHaveLength(1)
          }
          expect((await request('/api/demo/fault','guest',{fault:'unknown_external_state'})).statusCode).toBe(403)
          expect((await request('/api/demo/fault','carol',{fault:'unknown_external_state'})).statusCode).toBe(200)
          expect((await request('/api/demo/fault','bob')).json().fault).toBe('unknown_external_state')
        } finally {
          await app.close()
        }
      })
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
        http = permissionServer()
        const permissions = http.adapter
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
            permissions,
          )
          expect(leaked).toBe(false)
          expect(result.toolFailures).toBe(0)
          expect(result.toolAttempts).toBeLessThanOrEqual(6)
          const answer = String(events.at(-1)?.text)
          for (const source of state.sessionUpdatedAt ? ['get_login_sessions'] : ['get_app_permissions', 'get_login_sessions']) {
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
        const executor = new Executor(db, permissions)
        await executor.run()
        expect((await db.rows('changes', { id: change.id }))[0].status).toBe(
          'succeeded',
        )
        expect(http.methods.slice(-3)).toEqual(['GET', 'POST', 'GET'])
        expect((await db.rows('jobs', { change_id: change.id }))[0].status).toBe('succeeded')
        expect(await run('现在呢？')).toContain('权限已生效')
        await Bun.sleep(2) // Model a later source transition at millisecond precision.
        const wrong = await run('再看看现在情况怎么样', {
          sessionUpdatedAt: new Date().toISOString(),
          principal: 'external',
          sessionEmail: 'alias@corp.example',
        })
        expect(wrong).toContain('登错账号')
        expect(wrong).toContain('已拥有 project-b:viewer')
        await Bun.sleep(2)
        expect(
          await run('现在呢？', { sessionUpdatedAt: new Date().toISOString(), desktopStatus: 200 }),
        ).toContain('访问已恢复')
        await executor.run()
        expect(await db.rows('changes', { ticket_id: ticket.id })).toHaveLength(
          1,
        )
        expect(await db.rows('jobs', { change_id: change.id })).toHaveLength(1)
        expect(http.writes).toBe(1)
      })
      for (const mode of ['write-error', 'unknown'] as const) {
        it('reconciles HTTP permission state: ' + mode, async () => {
          http = permissionServer(mode)
          const j = await queue()
          const executor = new Executor(db, http.adapter)
          await executor.run()
          await executor.run()
          const unknown = mode === 'unknown'
          const status = unknown ? 'manual_review' : 'succeeded'
          const [change] = await db.rows('changes', { id: j.change_id })
          expect(change.status).toBe(status)
          expect((await db.rows('jobs', { id: j.id }))[0].status).toBe(status)
          expect(http.methods).toEqual(unknown ? ['GET'] : ['GET', 'POST', 'GET'])
          expect(http.writes).toBe(unknown ? 0 : 1)
          if (unknown) {
            await decide(db, carol, change.id, {
              decision: 'failed', payload_hash: change.payload_hash, note: '人工核对未授权',
            }, true)
            expect((await db.rows('jobs', { id: j.id }))[0].status).toBe('failed')
          }
        })
      }
      if (pgMode) it('streams an independent worker completion to the API tenant', async () => {
        http = permissionServer('hold')
        const job = await queue()
        const url = new URL(process.env.TEST_DATABASE_URL!)
        url.searchParams.set('options', '-c search_path=' + schema)
        const worker = Bun.spawn(['bun', 'src/changes/worker.ts'], {
          env: { ...process.env, DATABASE_URL: url.href, PERMISSIONS_API_URL: http.url,
            PERMISSIONS_API_TOKEN: 'test', PERMISSIONS_TIMEOUT_MS: '10000' },
        })
        let app: Awaited<ReturnType<typeof application>> | undefined
        const controller = new AbortController()
        try {
          await Promise.race([http.written, worker.exited.then(() => { throw Error('Worker exited early') })])
          app = await application(db, randomBytes(32))
          const origin = await app.listen({ host: '127.0.0.1', port: 0 })
          const response = await fetch(origin + '/api/events', {
            headers: { 'x-demo-user': 'alice' },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          })
          const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
          http.release()
          let buffer = ''
          while (!/data: [^\n]+\n\n/.test(buffer)) {
            const chunk = await reader.read()
            if (chunk.done) throw Error('SSE closed before completion')
            buffer += chunk.value
          }
          expect(JSON.parse(buffer.match(/data: ([^\n]+)/)![1])).toEqual({ type: 'change', id: job.change_id })
          expect(await worker.exited).toBe(0)
          expect((await db.rows('changes', { id: job.change_id }))[0].status).toBe('succeeded')
        } finally {
          controller.abort()
          http.release()
          await worker.exited
          await app?.close()
        }
      }, 15000)
      if (pgMode) it('recovers after SIGKILL between external write and response', async () => {
        http = permissionServer('hold')
        const j = await queue()
        const url = new URL(process.env.TEST_DATABASE_URL!)
        url.searchParams.set('options', '-c search_path=' + schema)
        const spawn = () => Bun.spawn(['bun', 'src/changes/worker.ts'], {
          env: { ...process.env, DATABASE_URL: url.href, PERMISSIONS_API_URL: http!.url,
            PERMISSIONS_API_TOKEN: 'test', PERMISSIONS_TIMEOUT_MS: '3000', LEASE_MS: '300' },
        })
        const first = spawn()
        try {
          await Promise.race([http.written, first.exited.then(code => { throw Error('Worker exited early: ' + code) })])
          first.kill('SIGKILL')
          expect(await first.exited).not.toBe(0)
        } finally {
          if (first.exitCode === null && !first.signalCode) first.kill('SIGKILL')
          await first.exited
        }
        const [running] = await db.rows('jobs', { id: j.id })
        expect(running.status).toBe('running')
        expect(http.writes).toBe(1)
        await Bun.sleep(Math.max(0, Date.parse(running.lease_until!) - Date.now()) + 50)
        expect(await spawn().exited).toBe(0)
        expect(http.methods).toEqual(['GET', 'POST', 'GET'])
        expect(http.writes).toBe(1)
        expect((await db.rows('jobs', { id: j.id }))[0]).toMatchObject({
          status: 'succeeded', attempt_count: 2,
        })
        expect((await db.rows('changes', { id: j.change_id }))[0].status).toBe('succeeded')
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
        await db.exec(`ALTER TABLE change_audit ADD CONSTRAINT injected
          CHECK (action <> 'approved')`)
        await expect(
          decide(db, carol, c.id, {
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
  await using db = new MemoryStore()
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

it('completes all seven evidence-backed workflows offline', async () => {
  const { runWorkflowEval, stability } = await import('../src/eval/workflow')
  const report = await runWorkflowEval(false, 3)
  expect(report).toMatchObject({ runs: 3, meanPassRate: 1, passAtK: 1, passAllK: 1 })
  expect(report.results).toHaveLength(21)
  for (const task of report.perTask) expect(task.passed).toEqual([true, true, true])
  expect(report.meanPerRun.ms).toBe(report.ms / 3)
  const mixed = report.results.map(({ task }, i) => ({ task, passed: i % 7 !== 0 && i !== 1 }))
  expect(stability(mixed)).toMatchObject({ meanPassRate: 17 / 21, passAtK: 6 / 7, passAllK: 5 / 7 })
  const results = report.results.slice(0, 7)
  expect(results.map((r) => r.passed)).toEqual(Array(7).fill(true))
  expect(results.map((r) => r.externalWrites)).toEqual([1, 1, 0, 0, 1, 1, 1])
  expect(results[6].externalRevokes).toBe(1)
}, 60000)

it('uses ticket ownership and latest observations even for fixture A', async () => {
  await using db = new MemoryStore()
  const ticket = { ...bob, id: crypto.randomUUID(), scenario: 'A' as const }
  await db.add('tickets', {id:ticket.id, scenario:ticket.scenario, actor_id:bob.actor_id, tenant_id:bob.tenant_id})
  const row = (source: string, data: Record<string, unknown>, observed_at: string) => ({
    ticket_id: ticket.id, id: crypto.randomUUID(), source, data, observed_at,
  })
  const missing = row('get_app_permissions', { app: appName, roles: [] }, '2026-11-01')
  const context = {
    ticket, beneficiary: 'alice',
    evidence: [row('get_login_sessions', { samePrincipal: true }, '2026-11-01'), missing],
  }
  expect((await draft(db, bob, input, context)).role).toBe(viewer)
  await expect(draft(db, carol, input, context)).rejects.toThrow('Missing supporting evidence')
  context.evidence.unshift(row('get_app_permissions', { app: appName, roles: [viewer] }, '2026-11-02'))
  await expect(draft(db, bob, input, context)).rejects.toThrow('Missing supporting evidence')
})

it('separates directory, application and raw service observations', () => {
  const adapter = fixture('B', {
    license: 'expired', member: true, refreshAudit: true, globalIncident: false,
    incidentAt: '2026-11-01T12:00:00Z', logAt: '2026-11-01T12:00:01Z',
    incidentRequest: 'req-1', logRequest: 'req-2',
  })
  const ref = adapter.directory.email
  expect(adapter.get_directory_profile(ref).license).toBe('expired')
  expect(adapter.get_app_permissions(ref)).toEqual({ app: appName, roles: [], directorySyncPending: true })
  expect(adapter.get_service_events(ref)).toEqual({
    incident: { occurredAt: '2026-11-01T12:00:00Z', requestId: 'req-1' },
    errorLogs: [{ eventAt: '2026-11-01T12:00:01Z', requestId: 'req-2', status: 403 }],
    auditEvents: [{ action: 'refresh', recordedAt: '2026-11-01T12:01:00Z' }],
    serviceStatus: { globalOutage: false },
  })
  expect(() => adapter.get_service_events('unbound')).toThrow('Subject unavailable')
})

it('authenticates tenant event streams and isolates their notifications', async () => {
  await using db = new MemoryStore()
  const app = await application(db, randomBytes(32))
  const ctl = new AbortController()
  try {
    expect((await app.inject('/api/events')).statusCode).toBe(401)
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await fetch(origin + '/api/events', {
      headers: { 'x-demo-user': 'alice' }, signal: ctl.signal,
    })
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    for (const user of ['guest', 'bob']) {
      const response = await app.inject({
        method: 'POST', url: '/api/tickets', headers: { 'x-demo-user': user },
        payload: { scenario: 'A' },
      })
      expect(response.statusCode).toBe(201)
      if (user === 'bob') {
        let buffer = ''
        while (!buffer.includes('data: ') || !buffer.endsWith('\n\n')) {
          const chunk = await reader.read()
          if (chunk.done) throw Error('Stream ended before ticket notification')
          buffer += chunk.value
        }
        expect(buffer.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))))
          .toEqual([{ type: 'ticket', id: response.json().id }])
      }
    }
  } finally {
    ctl.abort()
    await app.close()
  }
})

it('authenticates signed callers and carries approval traces into metered execution', async () => {
  await using db = new MemoryStore()
  const http = permissionServer()
  const key = randomBytes(32)
  const app = await application(db, key, undefined, undefined, http.adapter)
  const { signToken } = await import('../src/http/auth')
  const token = signToken(bob, key, 60)
  const headers = { authorization: 'Bearer ' + token }
  const demo = process.env.ALLOW_DEMO_AUTH
  try {
    process.env.ALLOW_DEMO_AUTH = '0'
    const metrics = () => app.inject({ url: '/api/metrics', headers })
    expect((await metrics()).statusCode).toBe(200)
    for (const authorization of [
      undefined,
      'Bearer ' + signToken(bob, key, -1),
      'Bearer ' + token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
    ]) {
      const response = await app.inject({
        url: '/api/tickets',
        headers: { ...(authorization && { authorization }), 'x-demo-user': 'bob' },
      })
      expect(response.statusCode).toBe(401)
    }
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers })
    const ticket = (await post('/api/tickets', { scenario: 'B' })).json()
    const run = (
      await post('/api/tickets/' + ticket.id + '/runs', { message: '调查', client_request_id: 'one' })
    ).json()
    await app.inject({ url: '/api/runs/' + run.runId + '/events', headers })
    const [change] = await db.rows('changes', { ticket_id: ticket.id })
    const trace = '00-12345678901234567890123456789012-1234567890123456-01'
    const approved = await app.inject({
      method: 'POST',
      url: '/api/changes/' + change.id + '/decision',
      headers: { authorization: 'Bearer ' + signToken(carol, key, 60), traceparent: trace },
      payload: { decision: 'approve', payload_hash: change.payload_hash },
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.headers.traceparent).toBe(trace)
    for (let i = 0; i < 100 && !(await metrics()).json().jobs_succeeded; i++) await Bun.sleep(10)
    expect(http.traces.slice(-3)).toEqual([trace, trace, trace])
    expect((await metrics()).json()).toEqual({
      runs_total: 1,
      runs_failed: 0,
      tool_attempts: 6,
      tool_failures: 0,
      tokens_total: 0,
      jobs_succeeded: 1,
      jobs_revoked: 0,
      jobs_manual_review: 0,
    })
  } finally {
    if (demo === undefined) delete process.env.ALLOW_DEMO_AUTH
    else process.env.ALLOW_DEMO_AUTH = demo
    await app.close()
    await http.close()
  }
})
