import { mkdir, rename, writeFile } from 'node:fs/promises'
import { reasoningLevel, type ModelSettings } from '../investigation/engine.js'
import { runPairs } from './paired.js'

if (process.env.LIVE_MODEL !== '1')
  throw Error('Set LIVE_MODEL=1 for comparison')
function configuration(prefix: string): ModelSettings {
  const baseUrl = process.env[prefix + 'MODEL_BASE_URL']
  const id = process.env[prefix + 'MODEL_ID']
  const apiKey = process.env[prefix + 'MODEL_API_KEY']
  if (!baseUrl || !id || !apiKey) throw Error('Incomplete model configuration')
  return {
    baseUrl,
    id,
    apiKey,
    reasoning: reasoningLevel(process.env[prefix + 'MODEL_REASONING']),
  }
}
const models = ['', 'COMPARE_'].map(configuration)
const runs = await Promise.all(
  models.map(async (settings) => ({
    model: settings.id,
    reasoning: settings.reasoning,
    ...(await runPairs(true, undefined, settings)),
  })),
)
await mkdir('eval-output', { recursive: true })
const target = 'eval-output/compare-live.json'
const temporary = target + '.' + crypto.randomUUID()
await writeFile(temporary, JSON.stringify(runs, null, 2))
await rename(temporary, target)
console.log(JSON.stringify(runs.map(({ results, ...summary }) => summary)))
if (runs.some((run) => !run.zeroLeak || run.results.some((r) => r.failed)))
  process.exitCode = 1
