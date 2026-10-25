import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateRelease } from './check-release.mjs'
import { prepareRelease } from './release.mjs'

test('release checks allow deleting superseded modules but reject referenced deletions, edits, and reused versions', () => {
  const previous = {
    version: 1,
    providers: [{ id: 'test', version: '1.0.0', sha256: 'old', entry: 'providers/test-1.0.0.mjs' }],
  }
  const next = {
    version: 2,
    providers: [{ id: 'test', version: '1.0.1', sha256: 'new', entry: 'providers/test-1.0.1.mjs' }],
  }
  validateRelease(previous, next, [])
  validateRelease(previous, next, [], ['providers/test-1.0.0.mjs'])
  assert.throws(
    () => validateRelease(previous, previous, [], ['providers/test-1.0.0.mjs']),
    /cannot delete/
  )
  validateRelease(previous, previous, [])
  assert.throws(() => validateRelease(previous, next, ['providers/test-1.0.0.mjs']), /immutable/)
  assert.throws(() => validateRelease(previous, { ...next, version: 1 }, []), /Bump/)
  assert.throws(
    () =>
      validateRelease(
        previous,
        { ...next, providers: [{ ...next.providers[0], version: '1.0.10' }] },
        []
      ),
    /patch must be 0-9/
  )
  assert.throws(
    () =>
      validateRelease(
        previous,
        { ...next, providers: [{ ...next.providers[0], version: '1.0.0' }] },
        []
      ),
    /new provider version/
  )
})

test('release copies the module without changing published bytes; hash checks fail on missing files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'test-1.0.0.mjs'), 'export default () => ({})\n')
  const registry = path.join(root, 'registry.json')
  fs.writeFileSync(
    registry,
    JSON.stringify({
      version: 1,
      providers: [{ id: 'test', version: '1.0.0', entry: 'test-1.0.0.mjs' }],
    })
  )
  assert.throws(() => prepareRelease(root, 'test', '../outside'), /major.minor.patch/)
  assert.throws(() => prepareRelease(root, 'test', '0.9.0'), /greater/)
  const next = prepareRelease(root, 'test', '1.0.1')
  assert.equal(next.entry, 'test-1.0.1.mjs')
  assert.equal(
    fs.readFileSync(path.join(root, next.entry), 'utf8'),
    fs.readFileSync(path.join(root, 'test-1.0.0.mjs'), 'utf8')
  )
  assert.throws(() => prepareRelease(root, 'test', '1.0.1'), /greater/)
  const sha = fileURLToPath(new URL('sha.mjs', import.meta.url))
  execFileSync(process.execPath, [sha, '--registry', registry, '--write'])
  execFileSync(process.execPath, [sha, '--registry', registry])
  fs.writeFileSync(path.join(root, next.entry), 'export default () => ({})\r\n')
  assert.throws(
    () => execFileSync(process.execPath, [sha, '--registry', registry]),
    /Command failed/
  )
  execFileSync(process.execPath, [sha, '--registry', registry, '--write', '--fix'])
  fs.unlinkSync(path.join(root, next.entry))
  assert.throws(
    () => execFileSync(process.execPath, [sha, '--registry', registry, '--write']),
    /Command failed/
  )
  fs.writeFileSync(path.join(root, next.entry), 'export default () => ({})\n')
  prepareRelease(root, 'test', '1.0.9')
  assert.throws(() => prepareRelease(root, 'test', '1.0.10'), /patch 0-9/)
  assert.equal(prepareRelease(root, 'test', '1.1.0').entry, 'test-1.1.0.mjs')
})

test('EmbedMaster contains upstream script loops and keeps its host responsive', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-worker-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const moduleUrl = new URL('providers/tv/embedmaster-1.1.0.mjs', import.meta.url).href
  const cfg = { feedUrl: 'https://fixture/feed', scrapeToken: 'token', resolveUrl: '/resolve' }
  const plain = `__EM_PLAYER__=${JSON.stringify(cfg)};`
  const bytes = Buffer.from(plain, 'utf8').map((byte, i) => byte ^ ((3 + i) & 255))
  const html = `<script>var a="${bytes.toString('base64')}",b=[2],c=1;var d=atob(</script>`
  for (const script of ['while(true){}', 'function EMFetch(){while(true){}}']) {
    const preload = `globalThis.fetch=async(url)=>{
      if(String(url).includes('em-crypto')) return new Response(${JSON.stringify(script)});
      if(String(url).includes('/feed')) return new Response(JSON.stringify({type:'server',source_url:'source',source_name:'Premium VidSpark'}));
      if(String(url).includes('/movie/')) return {ok:true,url:'https://fixture/page'};
      return new Response(${JSON.stringify(html)});
    };`
    const entry = path.join(root, 'check.mjs')
    fs.writeFileSync(
      entry,
      `
        const {default:create}=await import(${JSON.stringify(moduleUrl)});
        let ticks=0;
        const timer=setInterval(()=>ticks++,20);
        const result=await create().getSources({tmdbId:1,type:'movie'});
        clearInterval(timer);
        console.log(JSON.stringify({result,ticks}));
      `
    )
    const result = execFileSync(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entry],
      { encoding: 'utf8', timeout: 8000 }
    )
    const parsed = JSON.parse(result.trim())
    assert.equal(parsed.result, null)
    assert.ok(parsed.ticks >= 5, 'upstream loops must not block the host event loop')
  }
})
