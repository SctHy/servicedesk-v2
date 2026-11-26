import type { Action, ServiceDeskExtension } from './types.js'
import type { Change } from '../changes/types.js'

type Version = { ext: ServiceDeskExtension; activeRefs: number; draining: boolean }
function immutable<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
  for (const k of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && k === 'length') continue
    Object.defineProperty(copy, k, { value: immutable(Reflect.get(value, k)), enumerable: true })
  }
  return Object.freeze(copy)
}
export class ExtensionRegistry {
  private listeners = new Set<(id: string) => void>()
  onManifestChange(listener: (id: string) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private versions = new Set<Version>()
  private current = new Map<string, Version>()
  private disabled = new Map<string, Set<string>>()
  private pins = new Map<string, Version>()
  register(ext: ServiceDeskExtension) {
    this.install(ext, false)
  }
  upgrade(ext: ServiceDeskExtension) {
    this.install(ext, true)
  }
  private install(ext: ServiceDeskExtension, upgrade: boolean) {
    const old = this.current.get(ext.id)
    if (
      !ext.id.trim() ||
      !ext.version.trim() ||
      !!old !== upgrade ||
      [...this.versions].some((v) => v.ext.id === ext.id && v.ext.version === ext.version)
    )
      throw Error('Invalid extension identity or version')
    const scenarios = new Set<string>()
    const names = new Set<string>(),
      policies = new Set<string>()
    const fields = new Map(Object.entries({ email: 'EMAIL', employeeId: 'EMP', name: 'NAME' }))
    for (const e of [...this.current.values()]
      .filter((v) => v !== old)
      .map((v) => v.ext)
      .concat(ext)) {
      for (const scenario of e.scenarios) {
        if (!scenario.id || scenarios.has(scenario.id)) throw Error('Duplicate scenario')
        scenarios.add(scenario.id)
      }
      for (const tool of [
        ...e.observations,
        ...(e.retrievers ?? []),
        ...e.actions.map((a) => a.draftTool),
      ]) {
        if (!tool.name.trim() || names.has(tool.name)) throw Error('Duplicate tool: ' + tool.name)
        names.add(tool.name)
      }
      const actionIds = new Set<string>()
      for (const a of e.actions) {
        const key = JSON.stringify([a.app, a.role])
        if (
          !a.id?.trim() ||
          actionIds.has(a.id) ||
          !a.app?.trim() ||
          !a.role?.trim() ||
          !Array.isArray(a.bumpTopics) ||
          a.bumpTopics.some((topic) => !topic.trim()) ||
          policies.has(key) ||
          a.draftTool.executionMode !== 'sequential' ||
          !a.requires?.length ||
          a.requires.some((r) => !r.source || typeof r.accepts !== 'function') ||
          [a.read, a.apply, a.revoke, a.resourceKey].some((fn) => typeof fn !== 'function')
        )
          throw Error('Invalid action policy')
        actionIds.add(a.id)
        policies.add(key)
      }
      if (
        Object.keys(e.privacy ?? {}).some((k) => !['extraDetectors', 'extraFieldKinds'].includes(k)) ||
        e.privacy?.extraDetectors?.some((d) => typeof d.detect !== 'function')
      )
        throw Error('Invalid privacy configuration')
      for (const [k, v] of Object.entries(e.privacy?.extraFieldKinds ?? {})) {
        if (
          !['EMAIL', 'EMP', 'NAME', 'PHONE', 'SECRET'].includes(v) ||
          (fields.has(k) && fields.get(k) !== v)
        )
          throw Error('Conflicting privacy rule')
        fields.set(k, v)
      }
    }
    // Bind detector methods to preserve class instances with private state.
    const privacy = ext.privacy && {
      ...ext.privacy,
      extraDetectors: ext.privacy.extraDetectors?.map((d) => ({ detect: d.detect.bind(d) })),
    }
    const version = { ext: immutable({ ...ext, privacy }), activeRefs: 0, draining: false }
    if (old) {
      old.draining = true
      if (!old.activeRefs) this.versions.delete(old)
    }
    this.current.set(ext.id, version)
    this.versions.add(version)
    for (const listener of this.listeners) listener(ext.id)
  }
  unload(id: string) {
    const v = this.current.get(id)
    if (!v) throw Error('Unknown extension')
    this.current.delete(id)
    v.draining = true
    if (!v.activeRefs) this.versions.delete(v)
    for (const listener of this.listeners) listener(id)
  }
  setTenantEnabled(tenant: string, id: string, enabled: boolean) {
    if (!this.current.has(id)) throw Object.assign(Error('Unknown extension'), { statusCode: 404 })
    const disabled = this.disabled.get(tenant) ?? new Set<string>()
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    this.disabled.set(tenant, disabled)
  }
  isTenantEnabled(tenant: string, id: string) {
    return this.current.has(id) && !this.disabled.get(tenant)?.has(id)
  }
  status(tenant = '') {
    return [...this.versions].map(({ ext, activeRefs, draining }) => ({
      id: ext.id,
      version: ext.version,
      title: ext.title,
      description: ext.description,
      scenarios: ext.scenarios,
      uiManifest: {
        ...ext.uiManifest,
        observationMeta: Object.fromEntries(
          [...ext.observations, ...(ext.retrievers ?? [])].map((o) => [
            o.name,
            { title: o.label, ...o.uiMeta },
          ]),
        ),
        actions: ext.actions.map((a) => ({
          title: a.draftTool.label,
          ...a.uiMeta,
          id: a.id,
          app: a.app,
          role: a.role,
          standalone: !!a.allowStandaloneDraft,
        })),
      },
      activeRefs,
      draining,
      enabled: !draining && this.isTenantEnabled(tenant, ext.id),
    }))
  }
  private releaseVersion(v: Version) {
    if (--v.activeRefs === 0 && v.draining) this.versions.delete(v)
  }
  acquireSnapshot(tenant: string) {
    const versions = [...this.current.values()].filter((v) => this.isTenantEnabled(tenant, v.ext.id))
    for (const v of versions) v.activeRefs++
    const extensions = Object.freeze(versions.map((v) => v.ext))
    let released = false
    return Object.freeze({
      tenantId: tenant,
      snapshotId: crypto.randomUUID(),
      extensions,
      hooks: Object.freeze({
        beforeToolCall: Object.freeze(extensions.flatMap((e) => e.hooks?.beforeToolCall ?? [])),
        afterToolCall: Object.freeze(extensions.flatMap((e) => e.hooks?.afterToolCall ?? [])),
      }),
      uiManifests: Object.freeze(extensions.map((e) => e.uiManifest)),
      observations: Object.freeze(
        extensions.flatMap((e) => [...e.observations, ...(e.retrievers ?? [])]),
      ),
      actions: Object.freeze(extensions.flatMap((e) => e.actions)),
      pin: (id: string, action: Action) => {
        const v = versions.find((v) => v.ext.actions.includes(action))
        if (released || !v) throw Error('Unavailable snapshot')
        if (!this.pins.has(id)) {
          this.pins.set(id, v)
          v.activeRefs++
        }
      },
      release: () => {
        if (!released) versions.forEach((v) => this.releaseVersion(v))
        released = true
      },
    })
  }
  findAction(c: Change) {
    const pinned = this.pins.get(c.id)
    const versions = pinned
      ? [pinned]
      : [...this.versions].filter((v) =>
          c.extension_id
            ? v.ext.id === c.extension_id && v.ext.version === c.extension_version
            : !v.draining,
        )
    for (const version of versions) {
      const action = version.ext.actions.find((a) => a.app === c.app && a.role === c.role)
      if (!action) continue
      return action
    }
  }
  actionFor(c: Change) {
    const action = this.findAction(c)
    if (!action) throw Object.assign(Error('Pinned extension version unavailable'), { statusCode: 503 })
    return action
  }
  finish(id: string) {
    const v = this.pins.get(id)
    if (v) {
      this.pins.delete(id)
      this.releaseVersion(v)
    }
  }
}
export type ExtensionSnapshot = ReturnType<ExtensionRegistry['acquireSnapshot']>
