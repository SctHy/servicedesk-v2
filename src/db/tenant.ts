import type { Store, Tables } from './store.js'

type Direct = 'tickets' | 'runs' | 'changes' | 'jobs'
type Child = 'evidence' | 'run_events' | 'change_audit'
const parents = {
  evidence: ['tickets', 'ticket_id'],
  run_events: ['runs', 'run_id'],
  change_audit: ['changes', 'change_id'],
} as const

export class TenantScope {
  constructor(
    private db: Store,
    readonly tenant: string,
  ) {}

  rows<K extends Direct>(table: K, filter: Partial<Tables[K]> = {}) {
    return this.db.rows(table, { ...filter, tenant_id: this.tenant })
  }
  add<K extends Direct>(table: K, row: Omit<Tables[K], 'tenant_id'> & {tenant_id?: string}) {
    return this.db.add(table, { ...row, tenant_id: this.tenant } as Tables[K])
  }
  update<K extends Direct>(table: K, filter: Partial<Tables[K]>, patch: Partial<Tables[K]>) {
    return this.db.update(
      table,
      { ...filter, tenant_id: this.tenant },
      { ...patch, tenant_id: this.tenant },
    )
  }
  children<K extends Child>(table: K, id: string) {
    const [parent, key] = parents[table]
    return this.db.query<Tables[K]>(
      `SELECT c.* FROM ${table} c JOIN ${parent} p ON p.id=c.${key} WHERE p.tenant_id=$1 AND p.id=$2`,
      [this.tenant, id],
    )
  }
  async addChild<K extends Child>(table: K, row: Tables[K]) {
    const [parent, key] = parents[table]
    const inserted = await this.db.query(
      `INSERT INTO ${table} SELECT c.* FROM json_populate_record(NULL::${table}, $1::json) c
       JOIN ${parent} p ON p.id=c.${key} WHERE p.tenant_id=$2 RETURNING 1`,
      [JSON.stringify(row), this.tenant],
    )
    if (!inserted.length) throw Error('Parent unavailable')
  }
  async bumpWatermark(ticket: string, topic: string, at = new Date().toISOString()) {
    await this.db.query(
      `INSERT INTO resource_watermarks (tenant_id,ticket_id,topic,updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id,ticket_id,topic) DO UPDATE SET updated_at=excluded.updated_at
       WHERE resource_watermarks.updated_at < excluded.updated_at`,
      [this.tenant, ticket, topic, at],
    )
  }
  async watermarks(ticket: string): Promise<Record<string, string>> {
    const rows = await this.db.query<{topic: string; updated_at: string}>(
      'SELECT topic,updated_at FROM resource_watermarks WHERE tenant_id=$1 AND ticket_id=$2',
      [this.tenant, ticket],
    )
    return Object.fromEntries(rows.map(row => [row.topic, row.updated_at]))
  }
  async permissionWatermark(ticket: string) {
    return (await this.watermarks(ticket)).access_state ?? null
  }
  visibleChanges(actor: string, privileged: boolean) {
    return this.db.query<Tables['changes']>(
      `SELECT * FROM changes WHERE tenant_id=$1 AND ($2 OR requester_id=$3 OR beneficiary_principal=$3)
       ORDER BY created_at,id`,
      [this.tenant, privileged, actor],
    )
  }
  setSession(ticket: string, session: string) {
    return this.db.tx(async db => {
      const [row] = await db.query<{session_updated_at: string}>(
        `UPDATE tickets SET session=$3, session_updated_at=greatest($4::timestamptz,
          (SELECT max(observed_at) + interval '1 millisecond' FROM evidence
           WHERE ticket_id=$1 AND source='get_login_sessions'))
         WHERE id=$1 AND tenant_id=$2 AND session<>$3 RETURNING session_updated_at`,
        [ticket, this.tenant, session, new Date().toISOString()],
      )
      if (row) await new TenantScope(db, this.tenant).bumpWatermark(ticket, 'session_state', row.session_updated_at)
    })
  }
  history(ticket: string) {
    return this.db.query<{ question: string; answer: string; created_at: string }>(
      `
      SELECT r.created_at, q.data->>'text' AS question, a.data->>'text' AS answer FROM runs r
      JOIN run_events q ON q.run_id=r.id AND q.data->>'type'='question'
      JOIN run_events a ON a.run_id=r.id AND a.data->>'type'='final'
      WHERE r.ticket_id=$1 AND r.tenant_id=$2 ORDER BY r.created_at`,
      [ticket, this.tenant],
    )
  }
  replay(run: string, cursor: number) {
    return this.db.query<Tables['run_events']>(
      `SELECT e.* FROM run_events e JOIN runs r ON r.id=e.run_id WHERE r.tenant_id=$1 AND r.id=$2
       AND e.seq>$3 ORDER BY e.seq`,
      [this.tenant, run, cursor],
    )
  }
  async ended(run: string, cursor: number) {
    return (
      (
        await this.db.query(
          `SELECT 1 FROM run_events e JOIN runs r ON r.id=e.run_id
      WHERE r.tenant_id=$1 AND r.id=$2 AND e.seq<=$3 AND e.data->>'type' IN ('final','error')`,
          [this.tenant, run, cursor],
        )
      ).length > 0
    )
  }
  static async inTransaction(db: Store, tenant: string) {
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant])
    return new TenantScope(db, tenant)
  }
  locked<T>(key: string, work: (scope: TenantScope) => Promise<T>) {
    return this.db.locked(key, async (tx) => {
      return work(await TenantScope.inTransaction(tx, this.tenant))
    })
  }
}
