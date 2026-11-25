import { PGlite } from '@electric-sql/pglite'
import type { Change, Job } from '../changes/types.js'
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export type Auth = {
  role?: 'approver' | 'admin'
  tenant_id: string
  actor_id: string
  department_id: string
}
export type Ticket = Pick<Auth, 'tenant_id' | 'actor_id'> & {
  id: string
  session?: 'normal' | 'wrong_account'
  session_updated_at?: string | null
  scenario: 'A' | 'B'
}
export type Run = Pick<Ticket, 'tenant_id' | 'actor_id'> & {
  id: string
  ticket_id: string
  client_request_id: string
  status: 'running' | 'completed' | 'failed'
  lease_until: string | null
  request_fingerprint: string
  created_at: string
}
export type Evidence = {
  id: string
  ticket_id: string
  source: string
  observed_at: string
  data: Record<string, unknown>
}
export type Event = {
  run_id: string
  seq: number
  data: { type: string; [key: string]: unknown }
}
export type Chunk = {
  id: string
  tenant_id: string
  department_id: string
  visibility: 'tenant' | 'department'
  app: string
  code: string
  body: string
}
export type Tables = {
  changes: Change
  jobs: Job
  demo_grants: { resource_key: string; role: string }
  change_audit: {
    id: string
    change_id: string
    actor_id: string
    action: string
    note: string
    created_at: string
  }
  tickets: Ticket
  runs: Run
  run_events: Event
  evidence: Evidence
  kb_chunks: Chunk
  mask_bindings: {
    tenant_id: string
    ticket_id: string
    ref: string
    cipher: string
  }
}
type WithDefaults<Row, Keys extends keyof Row> = Omit<Row, Keys> &
  Partial<Pick<Row, Keys>>
type Inserts = Omit<Tables, 'runs' | 'changes' | 'jobs'> & {
  runs: WithDefaults<Run, 'status' | 'lease_until'>
  changes: WithDefaults<Change, 'expires_at' | 'revoked_at'>
  jobs: WithDefaults<Job, 'kind' | 'run_at'>
}
type Query = (sql: string, params: unknown[]) => Promise<unknown[]>
export class Store {
  constructor(
    private read: Query,
    readonly exec: (sql: string) => Promise<void>,
    readonly tx: <T>(fn: (db: Store) => Promise<T>) => Promise<T>,
  ) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return JSON.parse(JSON.stringify(await this.read(sql, params)))
  }

  locked<T>(key: string, work: (db: Store) => Promise<T>) {
    return this.tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1)', [
        createHash('sha256').update(key).digest().readBigInt64BE().toString(),
      ])
      return work(db)
    })
  }
  async removeGrant(key: string, role: string) {
    await this.query(
      'DELETE FROM demo_grants WHERE resource_key = $1 AND role = $2',
      [key, role],
    )
  }
  async rows<K extends keyof Tables>(table: K, filter: Partial<Tables[K]>) {
    const fields = Object.keys(filter)
    const where = fields
      .map(
        (k, i) => pg.escapeIdentifier(k) + ' IS NOT DISTINCT FROM $' + (i + 1),
      )
      .join(' AND ')
    const result = await this.query(
      'SELECT * FROM ' +
        pg.escapeIdentifier(table) +
        (where ? ' WHERE ' + where : ''),
      Object.values(filter),
    )
    return result as Tables[K][]
  }
  async add<K extends keyof Tables>(table: K, row: Inserts[K]) {
    const fields = Object.keys(row)
    await this.query(
      'INSERT INTO ' +
        pg.escapeIdentifier(table) +
        ' (' +
        fields.map(pg.escapeIdentifier).join(',') +
        ') VALUES (' +
        fields.map((_, i) => '$' + (i + 1)).join(',') +
        ')',
      Object.entries(row).map(([k, v]) =>
        k === 'evidence_ids' ? JSON.stringify(v) : v,
      ),
    )
  }
  async update<K extends keyof Tables>(
    table: K,
    filter: Partial<Tables[K]>,
    patch: Partial<Tables[K]>,
  ) {
    const fields = Object.keys(patch)
    const sets = fields.map((k, i) => pg.escapeIdentifier(k) + '=$' + (i + 1))
    const where = Object.keys(filter).map(
      (k, i) =>
        pg.escapeIdentifier(k) +
        ' IS NOT DISTINCT FROM $' +
        (fields.length + i + 1),
    )
    const result = await this.query(
      'UPDATE ' +
        pg.escapeIdentifier(table) +
        ' SET ' +
        sets.join(',') +
        ' WHERE ' +
        where.join(' AND ') +
        ' RETURNING 1',
      [...Object.values(patch), ...Object.values(filter)],
    )
    return result.length
  }

  async migrate() {
    await this.locked('migration', async (db) => {
      await db.exec(
        'CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY)',
      )
      const files = [
        '001_init',
        '002_m3_changes',
        '003_m4_expiry',
        '004_m5_indexes',
        '005_observability',
        '006_tenant_relations',
        '007_multi_instance_runs',
      ]
      for (const [i, file] of files.entries()) {
        if (
          (
            await db.query('SELECT 1 FROM schema_migrations WHERE version=$1', [
              i + 1,
            ])
          ).length
        )
          continue
        await db.exec(
          await readFile(
            new URL('./migrations/' + file + '.sql', import.meta.url),
            'utf8',
          ),
        )
        await db.query('INSERT INTO schema_migrations VALUES ($1)', [i + 1])
      }
    })
  }
}

function scoped(query: Query, exec: Store['exec']): Store {
  const db: Store = new Store(query, exec, (fn) => fn(db))
  return db
}

export class PgStore extends Store {
  async listenEvents(receive: (payload: string) => void) {
    const client = await this.pool.connect()
    const forward = (message: pg.Notification) => {
      if (message.channel === 'desk_events' && message.payload) receive(message.payload)
    }
    client.on('notification', forward)
    try {
      await client.query('LISTEN desk_events')
    } catch (error) {
      client.release(true)
      throw error
    }
    return async () => {
      client.off('notification', forward)
      try { await client.query('UNLISTEN desk_events') }
      finally { client.release(true) }
    }
  }
  constructor(readonly pool: pg.Pool) {
    super(
      async (s, p) => (await pool.query(s, p)).rows,
      async (s) => {
        await pool.query(s)
      },
      async (fn) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await fn(
            scoped(
              async (s, p) => (await client.query(s, p)).rows,
              async (s) => {
                await client.query(s)
              },
            ),
          )
          await client.query('COMMIT')
          return result
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        } finally {
          client.release()
        }
      },
    )
  }
  close() {
    return this.pool.end()
  }
}

export class MemoryStore extends Store {
  private ready: Promise<void>
  private engine: PGlite
  constructor() {
    const engine = new PGlite()
    // PGlite.transaction queues transactions and standalone queries on its single connection.
    const db = new Store(
      async (s, p) => (await engine.query(s, p)).rows,
      async (s) => {
        await engine.exec(s)
      },
      (fn) =>
        engine.transaction((t) =>
          fn(
            scoped(
              async (s, p) => (await t.query(s, p)).rows,
              async (s) => {
                await t.exec(s)
              },
            ),
          ),
        ),
    )
    const ready = db.migrate()
    super(
      async (s, p) => {
        await ready
        return db.query(s, p)
      },
      async (s) => {
        await ready
        await db.exec(s)
      },
      async (fn) => {
        await ready
        return db.tx(fn)
      },
    )
    this.ready = ready
    this.engine = engine
  }
  async close() {
    try {
      await this.ready
    } finally {
      await this.engine.close()
    }
  }
  [Symbol.asyncDispose]() {
    return this.close()
  }
}
