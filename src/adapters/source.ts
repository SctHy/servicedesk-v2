interface Directory {
  name: string
  email: string
  employeeId: string
  license?: 'valid' | 'expired'
  groups: string[]
}

type Observation<T> = T | Promise<T>

export interface InvestigationSource {
  directory: Directory
  sessionUpdatedAt?: string
  get_directory_profile(email: string): Observation<Directory>
  get_login_sessions(email: string): Observation<{
    desktop: { email: string; status: number }
    web: { email: string; status: number }
    samePrincipal: boolean | 'unknown'
    sameMailbox: boolean | 'unknown'
  }>
  get_app_permissions(
    email: string,
  ): Observation<{ app: string; roles: string[] | null; directorySyncPending?: boolean }>
  get_service_events(email: string): Observation<{
    incident?: { occurredAt: string; requestId?: string }
    errorLogs: { eventAt: string; requestId?: string; status: number }[]
    auditEvents: { action: string; recordedAt: string }[]
    serviceStatus?: { globalOutage: boolean }
  }>
}
