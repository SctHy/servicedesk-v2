import type { Ticket } from '../db/store.js'
export type Observations = {
  principal?: string | null
  sessionEmail?: string
  license?: 'valid' | 'expired'
  webStatus?: number
  desktopStatus?: number
  incidentRequest?: string
  logRequest?: string
  incidentAt?: string
  logAt?: string
  refreshAudit?: boolean
  member?: boolean
  globalIncident?: boolean
  roleInventory?: 'complete' | 'unavailable'
}
export function fixture(
  scenario: Ticket['scenario'],
  observations: Observations = {},
) {
  const name = scenario === 'A' ? 'alice' : 'bob'
  const email = name + '@corp.example'
  const directory = {
    name,
    email,
    employeeId: scenario === 'A' ? 'EMP-101' : 'EMP-102',
    ...(observations.license && { license: observations.license }),
    groups: observations.member === false ? [] : ['project-b-team'],
  }
  const session = {
    email:
      observations.sessionEmail ??
      (scenario === 'A' ? 'alice.old@personal.example' : email),
    principal:
      observations.principal === null
        ? undefined
        : (observations.principal ??
          (scenario === 'A' ? 'external-71' : directory.employeeId)),
  }
  const check = (value: string) => {
    if (value !== email) throw Error('Subject unavailable')
  }
  return {
    directory,
    get_directory_profile(value: string) {
      check(value)
      return directory
    },
    get_login_sessions(value: string) {
      check(value)
      return {
        desktop: {
          email: session.email,
          status: observations.desktopStatus ?? 403,
        },
        web: { email, status: observations.webStatus ?? (scenario === 'A' ? 200 : 403) },
        ...compare(
          email,
          session.email,
          directory.employeeId,
          session.principal,
        ),
      }
    },
    get_app_permissions(value: string) {
      check(value)
      return {
        app: 'project-b-app',
        ...(observations.member === undefined
          ? {}
          : { directorySyncPending: true }),
        roles:
          observations.roleInventory === 'unavailable'
            ? null
            : scenario === 'A'
              ? ['project-b:viewer']
              : [],
      }
    },
    get_service_events(value: string) {
      check(value)
      return {
        ...(observations.incidentAt && { incident: { occurredAt: observations.incidentAt, requestId: observations.incidentRequest } }),
        errorLogs: observations.logAt ? [{ eventAt: observations.logAt, requestId: observations.logRequest, status: 403 }] : [],
        auditEvents: observations.refreshAudit ? [{ action: 'refresh', recordedAt: '2026-11-01T12:01:00Z' }] : [],
        ...(observations.globalIncident !== undefined && { serviceStatus: { globalOutage: observations.globalIncident } }),
      }
    },
  }
}
export function compare(
  mail?: string,
  other?: string,
  id?: string,
  otherId?: string,
) {
  return {
    sameMailbox:
      mail && other ? mail.toLowerCase() === other.toLowerCase() : 'unknown',
    samePrincipal: id && otherId ? id === otherId : 'unknown',
  }
}
