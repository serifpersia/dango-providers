#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

function usage() {
  console.log(`usage:
  node sha.mjs [ids...]              verify sha256 of registry entries
  node sha.mjs [ids...] --write      update registry.json with computed shas
  node sha.mjs [ids...] --fix        convert CRLF to LF in provider files first
  node sha.mjs --registry <path>     use a different registry file`)
  process.exit(2)
}

const opts = { write: false, fix: false, registry: join(here, 'registry.json'), ids: [] }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--write') opts.write = true
  else if (a === '--fix') opts.fix = true
  else if (a === '--registry') {
    const p = args[++i]
    if (!p) usage()
    opts.registry = resolve(p)
  } else if (a === '--help' || a === '-h') usage()
  else if (a.startsWith('-')) usage()
  else opts.ids.push(a)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalize(bytes) {
  const text = Buffer.from(bytes).toString('utf8')
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
}

let registry
try {
  registry = JSON.parse(readFileSync(opts.registry, 'utf8'))
} catch (e) {
  console.error(`cannot read registry: ${opts.registry} (${e.message})`)
  process.exit(2)
}

const root = dirname(opts.registry)
const entries = Array.isArray(registry.providers) ? registry.providers : []
const wanted = new Set(opts.ids.map((s) => s.toLowerCase()))
const rows = []
let failed = 0

for (const entry of entries) {
  const id = String(entry.id || '')
  if (wanted.size > 0 && !wanted.has(id.toLowerCase())) continue
  const row = { id, version: String(entry.version || ''), status: '', note: '' }
  const target = String(entry.entry || '')
  if (/^https?:\/\//i.test(target)) {
    row.status = 'SKIP'
    row.note = 'remote entry'
    rows.push(row)
    continue
  }
  const file = resolve(root, target)
  if (!existsSync(file)) {
    row.status = 'MISSING'
    row.note = target
    failed++
    rows.push(row)
    continue
  }
  let bytes = readFileSync(file)
  const hasCr = bytes.includes(0x0d)
  if (hasCr && opts.fix) {
    const fixed = normalize(bytes)
    writeFileSync(file, fixed)
    bytes = fixed
    row.note = 'crlf->lf'
  } else if (hasCr) {
    row.note = 'has CRLF (hashes as LF; run --fix)'
  }
  const digest = sha256(normalize(bytes))
  const current = String(entry.sha256 || '').toLowerCase()
  if (current === digest) {
    row.status = 'OK'
  } else if (opts.write) {
    entry.sha256 = digest
    row.status = current ? 'UPDATED' : 'FILLED'
    row.note = [row.note, `${current || '(none)'} -> ${digest.slice(0, 12)}…`]
      .filter(Boolean)
      .join(' ')
  } else {
    row.status = 'MISMATCH'
    failed++
  }
  rows.push(row)
}

const width = Math.max(6, ...rows.map((r) => r.id.length))
for (const r of rows) {
  const extra = r.note ? `  ${r.note}` : ''
  console.log(`${r.status.padEnd(8)} ${r.id.padEnd(width)} ${r.version}${extra}`)
}

if (opts.write) {
  const changed = rows.filter((r) => r.status === 'UPDATED' || r.status === 'FILLED').length
  if (changed > 0) {
    registry.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    const raw = readFileSync(opts.registry, 'utf8')
    const indent = raw.match(/^ +"/m)?.[0].length - 1 || 2
    writeFileSync(opts.registry, JSON.stringify(registry, null, Math.min(indent, 8)) + '\n')
  }
  console.log(`${changed} entr${changed === 1 ? 'y' : 'ies'} updated`)
}

if (failed > 0 && !opts.write) {
  console.log(`${failed} problem${failed === 1 ? '' : 's'} — rerun with --write to fix shas`)
  process.exit(1)
}
