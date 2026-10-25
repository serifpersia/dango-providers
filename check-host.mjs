import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dango = path.resolve(process.argv[2] || '../dango')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dango-provider-contract-'))
process.env.APPDATA = root
process.env.XDG_DATA_HOME = root
process.env.DANGO_MAL_CACHE_PATH = path.join(root, 'mal-cache.db')
process.env.DOTENV_CONFIG_QUIET = 'true'
process.env.LOG_LEVEL = 'error'

try {
  const { INSTALL_CONFIG } = await import(pathToFileURL(path.join(dango, 'server/src/config.ts')))
  INSTALL_CONFIG.ROOT = root
  const { loadRemoteProviders } = await import(
    pathToFileURL(path.join(dango, 'server/src/providers/remote-loader.ts'))
  )
  const { AppCache } = await import(
    pathToFileURL(path.join(dango, 'server/src/utils/cache.utils.ts'))
  )
  const { parseRegistry } = await import(
    pathToFileURL(path.join(dango, 'server/src/providers/remote-types.ts'))
  )
  const registryPath = new URL('registry.json', import.meta.url)
  const registry = parseRegistry(JSON.parse(await fs.readFile(registryPath, 'utf8')))
  const fetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('Provider factories must not make network requests')
  }
  let result
  try {
    result = await loadRemoteProviders({
      cache: new AppCache(),
      registryUrl: registryPath.href,
      enabledProviders: registry.providers.map((p) => p.id),
      allowUnsigned: false,
    })
  } finally {
    globalThis.fetch = fetch
  }
  assert.equal(result.registryLoaded, true)
  assert.equal(result.catalog.length, registry.providers.length)
  for (const item of result.catalog) assert.equal(item.loaded, true, `${item.id}: ${item.error}`)

  const contract = path.join(root, 'contract.mts')
  const host = path.join(dango, 'server/src/providers/remote-loader.js').replaceAll('\\', '/')
  const declaration = fileURLToPath(new URL('ctx.js', import.meta.url)).replaceAll('\\', '/')
  await fs.writeFile(
    contract,
    `declare const host: import(${JSON.stringify(host)}).RemoteCtx;\nconst provider: import(${JSON.stringify(declaration)}).RemoteCtx = host;\nvoid provider;\n`
  )
  execFileSync(
    process.execPath,
    [
      path.join(dango, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'nodenext',
      '--target',
      'es2022',
      '--ignoreDeprecations',
      '6.0',
      contract,
    ],
    { stdio: 'inherit', cwd: root }
  )
  console.log(`Host context and ${result.catalog.length} provider factories verified against dango`)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
