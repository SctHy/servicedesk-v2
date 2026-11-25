import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Auth } from '../db/store.js'

const signature = (payload: string, key: Buffer) =>
  createHmac('sha256', key)
    .update('servicedesk.auth.v1.' + payload)
    .digest('base64url')

function valid(auth: Auth) {
  return (
    auth &&
    [auth.actor_id, auth.tenant_id, auth.department_id].every(
      (id) => typeof id === 'string' && id.length <= 256 && !!id.trim() && !id.includes('\0'),
    ) &&
    (auth.role === undefined || auth.role === 'approver' || auth.role === 'admin')
  )
}

export function signToken(auth: Auth, key: Buffer, ttlSec: number) {
  if (!valid(auth) || !Number.isSafeInteger(ttlSec)) throw Error('Invalid token parameters')
  const payload = Buffer.from(
    JSON.stringify({ ...auth, exp: Math.floor(Date.now() / 1000) + ttlSec }),
  ).toString('base64url')
  return payload + '.' + signature(payload, key)
}

export function verifyToken(header: unknown, key: Buffer): Auth | undefined {
  const parts = typeof header === 'string' && /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/i.exec(header)
  if (!parts || !timingSafeEqual(Buffer.from(parts[2]), Buffer.from(signature(parts[1], key)))) return
  try {
    const { exp, actor_id, tenant_id, department_id, role } = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString(),
    )
    const auth = { actor_id, tenant_id, department_id, role }
    if (valid(auth) && Number.isSafeInteger(exp) && exp > Date.now() / 1000) return auth
  } catch {}
}
