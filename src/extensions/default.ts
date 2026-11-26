import { ExtensionRegistry } from './registry.js'
import { projectBAccess } from './builtin/project-b-access.js'
export function createDefaultRegistry() {
  const registry = new ExtensionRegistry()
  registry.register(projectBAccess)
  return registry
}
export const defaultRegistry = createDefaultRegistry()
