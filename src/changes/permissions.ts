import { viewer } from './service.js'

export interface PermissionsAdapter {
  read(key: string): Promise<boolean | null>
  grant(key: string): Promise<void>
}

export class HttpPermissions implements PermissionsAdapter {
  private endpoint: string
  constructor(baseUrl: string, private token?: string, private timeoutMs = 3000) {
    this.endpoint = baseUrl.replace(/\/+$/, '') + '/grants'
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw Error('Invalid PERMISSIONS_TIMEOUT_MS')
  }

  private request(url: string, body?: string) {
    return fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(this.token && { Authorization: 'Bearer ' + this.token }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    })
  }

  async read(key: string) {
    try {
      const response = await this.request(this.endpoint + '?' + new URLSearchParams({ resource_key: key }))
      if (response.status !== 200) return null
      const data = await response.json()
      return typeof data?.granted === 'boolean' ? data.granted as boolean : null
    } catch {
      return null
    }
  }

  async grant(key: string) {
    const response = await this.request(this.endpoint, JSON.stringify({ resource_key: key, role: viewer }))
    if (!response.ok) throw Error('Grant failed: HTTP ' + response.status)
  }
}

export function configuredPermissions() {
  const { PERMISSIONS_API_URL, PERMISSIONS_API_TOKEN, PERMISSIONS_TIMEOUT_MS } = process.env
  if (PERMISSIONS_API_URL)
    return new HttpPermissions(PERMISSIONS_API_URL, PERMISSIONS_API_TOKEN, Number(PERMISSIONS_TIMEOUT_MS ?? 3000))
}
