import { randomBytes } from 'node:crypto'

export function traceparent(value: unknown) {
  if (
    typeof value === 'string' &&
    /^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)
  )
    return value
  return '00-' + randomBytes(16).toString('hex') + '-' + randomBytes(8).toString('hex') + '-01'
}
