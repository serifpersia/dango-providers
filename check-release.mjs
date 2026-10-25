import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

export function validateRelease(previous, current, changedFiles, deletedFiles = []) {
  assert.equal(
    changedFiles.length,
    0,
    `Published modules are immutable; create a new version: ${changedFiles.join(', ')}`
  )
  if (JSON.stringify(previous.providers) !== JSON.stringify(current.providers)) {
    assert.ok(current.version > previous.version, 'Bump registry.version when changing providers')
  }
  for (const entry of current.providers) {
    assert.ok(
      !deletedFiles.some((file) => entry.entry === file || entry.entry?.endsWith(`/${file}`)),
      `${entry.id}: cannot delete a module referenced by the current registry`
    )
    assert.match(
      entry.version,
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/,
      `${entry.id}: patch must be 0-9; 1.0.9 is followed by 1.1.0`
    )
    const old = previous.providers.find((p) => p.id === entry.id && p.version === entry.version)
    if (old) {
      assert.equal(
        entry.sha256,
        old.sha256,
        `${entry.id}: new bytes require a new provider version`
      )
      assert.equal(
        entry.embedBase,
        old.embedBase,
        `${entry.id}: new embedBase requires a new provider version`
      )
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const base = process.argv[2] || 'HEAD'
  assert.match(base, /^(HEAD|[0-9a-f]{40})$/, 'Expected HEAD or a full commit SHA')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const previous = JSON.parse(git('show', `${base}:registry.json`))
  const current = JSON.parse(readFileSync(new URL('registry.json', import.meta.url), 'utf8'))
  const changed = git(
    'diff',
    '--no-renames',
    '--name-status',
    '--diff-filter=MD',
    base,
    '--',
    'providers'
  )
    .split('\n')
    .filter(Boolean)
  const changes = changed.map((line) => line.split('\t'))
  validateRelease(
    previous,
    current,
    changes.filter(([status]) => status === 'M').map(([, file]) => file),
    changes.filter(([status]) => status === 'D').map(([, file]) => file)
  )
  console.log('Release versions and immutable modules verified')
}
