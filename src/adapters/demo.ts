import type { Ticket } from '../db/store.js'
export type Observations = {
  principal?: string | null
  sessionEmail?: string
  license?: 'valid' | 'expired'
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
        desktop: { email: session.email, status: 403 },
        web: { email, status: scenario === 'A' ? 200 : 403 },
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
        ...Object.fromEntries(
          Object.entries(observations).filter(
            ([k]) => !['principal', 'sessionEmail', 'member'].includes(k),
          ),
        ),
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
