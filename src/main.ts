import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import serve from '@fastify/static'
import { PgStore, MemoryStore } from './db/store.js'
import { application } from './http/app.js'
const url = process.env.DATABASE_URL
const key = process.env.MASK_KEY
  ? Buffer.from(process.env.MASK_KEY, 'base64')
  : url
    ? Buffer.alloc(0)
    : randomBytes(32)
if (key.length !== 32)
  throw Error('Set MASK_KEY to a base64-encoded 32-byte key')
const db = url
  ? new PgStore(new pg.Pool({ connectionString: url }))
  : new MemoryStore()
if (db instanceof PgStore) await db.migrate()
const app = await application(db, key)
if (existsSync('web/dist/index.html'))
  await app.register(serve, { root: resolve('web/dist') })
await app.listen({ port: Number(process.env.PORT || 3000), host: '127.0.0.1' })
console.log('ServiceDesk listening at ' + app.listeningOrigin)
async function close() {
  await app.close()
  if (db instanceof PgStore) await db.pool.end()
}
process.once('SIGTERM', close)
process.once('SIGINT', close)
