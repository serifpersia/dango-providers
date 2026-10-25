import assert from 'node:assert/strict'
import { copyFileSync, constants, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function prepareRelease(root, id, version) {
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/,
    'Use major.minor.patch with patch 0-9; 1.0.9 is followed by 1.1.0'
  )
  const registryPath = path.join(root, 'registry.json')
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  const entry = registry.providers.find((p) => p.id === id)
  assert.ok(entry, `Unknown provider: ${id}`)
  const oldVersion = entry.version.split('.').map(Number)
  const nextVersion = version.split('.').map(Number)
  const firstDifference = nextVersion.findIndex((n, i) => n !== oldVersion[i])
  assert.ok(
    firstDifference >= 0 && nextVersion[firstDifference] > oldVersion[firstDifference],
    'New version must be greater than the current version'
  )
  if (!entry.embedBase) {
    assert.ok(entry.entry && !entry.entry.includes('://'), 'Release a local module entry')
    const target = path.posix.join(path.posix.dirname(entry.entry), `${id}-${version}.mjs`)
    assert.ok(
      path.resolve(root, target).startsWith(path.resolve(root) + path.sep),
      'Module must stay inside the repository'
    )
    copyFileSync(
      path.resolve(root, entry.entry),
      path.resolve(root, target),
      constants.COPYFILE_EXCL
    )
    entry.entry = target
  }
  entry.version = version
  registry.version++
  registry.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')
  return entry
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const [, , id, version] = process.argv
  assert.ok(id && version, 'Usage: node release.mjs <provider-id> <new-version>')
  execFileSync(process.execPath, [path.join(root, 'check-release.mjs')], { stdio: 'inherit' })
  const entry = prepareRelease(root, id, version)
  console.log(
    `Prepared ${entry.id} ${entry.version}. Edit ${entry.entry || 'embedBase'}, then run npm run sha:write and npm run check.`
  )
}
