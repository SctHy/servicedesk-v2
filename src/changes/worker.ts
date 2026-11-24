import pg from 'pg'
import { PgStore } from '../db/store.js'
import { Executor } from './executor.js'
import { configuredPermissions } from './permissions.js'

const url = process.env.DATABASE_URL
if (!url) throw Error('Set DATABASE_URL')
const leaseMs = Number(process.env.LEASE_MS ?? 30000)
if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw Error('Invalid LEASE_MS')
const db = new PgStore(new pg.Pool({ connectionString: url }))
try {
  await new Executor(db, configuredPermissions(), leaseMs).run()
} finally {
  await db.pool.end()
}
