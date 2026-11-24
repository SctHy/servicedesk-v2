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
  scenario: 'A' | 'B'
}
export type Run = Pick<Ticket, 'tenant_id' | 'actor_id'> & {
  id: string
  ticket_id: string
  client_request_id: string
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
type Tables = {
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
type WithDefaults<Row, Keys extends keyof Row> = Omit<Row, Keys> & Partial<Pick<Row, Keys>>
type Inserts = Omit<Tables, 'changes' | 'jobs'> & {
  changes: WithDefaults<Change, 'expires_at' | 'revoked_at'>
  jobs: WithDefaults<Job, 'kind' | 'run_at'>
}
export interface Store {
  removeGrant(key: string, role: string): Promise<void>
  rows<K extends keyof Tables>(
    table: K,
    filter: Partial<Tables[K]>,
  ): Promise<Tables[K][]>
  add<K extends keyof Tables>(table: K, row: Inserts[K]): Promise<void>
  update<K extends keyof Tables>(
    table: K,
    filter: Partial<Tables[K]>,
    patch: Partial<Tables[K]>,
  ): Promise<number>
  locked<T>(key: string, work: (db: Store) => Promise<T>): Promise<T>
}
export class MemoryStore implements Store {
  async removeGrant(key: string, role: string) {
    this.tables.set('demo_grants', (this.tables.get('demo_grants') ?? []).filter(
      row => Reflect.get(row, 'resource_key') !== key || Reflect.get(row, 'role') !== role))
  }
  private tables = new Map<string, object[]>()
  private locks = new Map<string, Promise<unknown>>()
  async rows<K extends keyof Tables>(table: K, filter: Partial<Tables[K]>) {
    return structuredClone(
      (this.tables.get(table) ?? []).filter((row) =>
        Object.entries(filter).every(([k, v]) => Reflect.get(row, k) === v),
      ),
    ) as Tables[K][]
  }
  async add<K extends keyof Tables>(table: K, row: Inserts[K]) {
    const rows = this.tables.get(table) ?? []
    const defaults = table === 'jobs' ? { kind: 'grant', run_at: new Date().toISOString() }
      : table === 'changes' ? { expires_at: null, revoked_at: null } : {}
    rows.push(structuredClone({ ...defaults, ...row }))
    this.tables.set(table, rows)
  }
  async update<K extends keyof Tables>(
    table: K,
    filter: Partial<Tables[K]>,
    patch: Partial<Tables[K]>,
  ) {
    const rows = (this.tables.get(table) ?? []).filter((row) =>
      Object.entries(filter).every(([k, v]) => Reflect.get(row, k) === v),
    )
    for (const row of rows) Object.assign(row, structuredClone(patch))
    return rows.length
  }
  async locked<T>(key: string, work: (db: Store) => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const staged = new MemoryStore()
        staged.tables = structuredClone(this.tables)
        const commits: (() => void)[] = []
        const tx: Store = {
          removeGrant: async (key, role) => {
            await staged.removeGrant(key, role)
            commits.push(() => { void this.removeGrant(key, role) })
          },
          rows: staged.rows.bind(staged),
          add: async (table, row) => {
            await staged.add(table, row)
            commits.push(() => {
              void this.add(table, row)
            })
          },
          update: async (table, filter, patch) => {
            const n = await staged.update(table, filter, patch)
            commits.push(() => {
              void this.update(table, filter, patch)
            })
            return n
          },
          locked: async (_key, fn) => fn(tx),
        }
        const result = await work(tx)
        for (const commit of commits) commit()
        return result
      })
    this.locks.set(key, next)
    try {
      return await next
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key)
    }
  }
}
export class PgStore implements Store {
  constructor(
    readonly pool: pg.Pool,
    private client?: pg.PoolClient,
  ) {}
  async removeGrant(key: string, role: string) {
    await this.sql.query('DELETE FROM demo_grants WHERE resource_key=$1 AND role=$2', [key, role])
  }
  private get sql() {
    return this.client ?? this.pool
  }
  async rows<K extends keyof Tables>(table: K, filter: Partial<Tables[K]>) {
    const fields = Object.keys(filter)
    const where = fields
      .map((k, i) => pg.escapeIdentifier(k) + ' IS NOT DISTINCT FROM $' + (i + 1))
      .join(' AND ')
    const result = await this.sql.query(
      'SELECT * FROM ' +
        pg.escapeIdentifier(table) +
        (where ? ' WHERE ' + where : ''),
      Object.values(filter),
    )
    return JSON.parse(JSON.stringify(result.rows)) as Tables[K][]
  }
  async add<K extends keyof Tables>(table: K, row: Inserts[K]) {
    const fields = Object.keys(row)
    await this.sql.query(
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
    const result = await this.sql.query(
      'UPDATE ' +
        pg.escapeIdentifier(table) +
        ' SET ' +
        sets.join(',') +
        ' WHERE ' +
        where.join(' AND '),
      [...Object.values(patch), ...Object.values(filter)],
    )
    return result.rowCount ?? 0
  }
  async locked<T>(key: string, work: (db: Store) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock($1)', [
        createHash('sha256').update(key).digest().readBigInt64BE(),
      ])
      const result = await work(new PgStore(this.pool, client))
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
  async migrate() {
    const sql = await readFile(
      new URL('./migrations/001_init.sql', import.meta.url),
      'utf8',
    )
    await this.locked('migration', async (db) => {
      const conn = (db as PgStore).sql
      await conn.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY)',
      )
      if (
        !(await conn.query('SELECT 1 FROM schema_migrations WHERE version=1'))
          .rowCount
      ) {
        await conn.query(sql)
        await conn.query('INSERT INTO schema_migrations VALUES(1)')
      }
      if (
        !(await conn.query('SELECT 1 FROM schema_migrations WHERE version=2'))
          .rowCount
      ) {
        await conn.query(
          await readFile(
            new URL('./migrations/002_m3_changes.sql', import.meta.url),
            'utf8',
          ),
        )
        await conn.query('INSERT INTO schema_migrations VALUES(2)')
      }
      if (!(await conn.query('SELECT 1 FROM schema_migrations WHERE version=3')).rowCount) {
        await conn.query(await readFile(new URL('./migrations/003_m4_expiry.sql', import.meta.url), 'utf8'))
        await conn.query('INSERT INTO schema_migrations VALUES(3)')
      }
    })
  }
}
