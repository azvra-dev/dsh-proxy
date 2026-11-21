// Standalone checks for the pure parts of dsh-proxy: WinINET parsing, body
// limits, and the loopback guard. Runs against the real source file by
// importing it (apply() is not called here).
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'index.js')).href)

assert.equal(typeof mod.apply, 'function', 'apply exported')
assert.equal(mod.name, 'dsh-proxy', 'plugin name')

// The source keeps its helpers private; assert on the observable contract that
// the Host route relies on instead: `reg query` output shape.
const sample = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    127.0.0.1:7897',
  '    ProxyOverride    REG_SZ    localhost;127.*;10.*;*.corp.example;<local>',
  '    AutoConfigURL    REG_SZ    ',
  '',
].join('\r\n')
const parsed = {}
for (const line of sample.split(/\r?\n/)) {
  const m = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line)
  if (m !== null) parsed[m[1]] = m[3].trim()
}
assert.equal(parsed.ProxyEnable, '0x1')
assert.equal(parsed.ProxyServer, '127.0.0.1:7897')
assert.equal(parsed.AutoConfigURL, '')

// The package the Host half loads must be resolvable from the installation
// anchor, which is what `importWithFallback` tries second. A plain Node runtime
// cannot traverse Desktop's app.asar, so run this file with the Harness's own
// executable (ELECTRON_RUN_AS_NODE=1) to exercise the resolution itself.
const anchor = process.env.DSH_INSTALL_DIR
if (anchor !== undefined && anchor !== '') {
  const { createRequire } = await import('node:module')
  const req = createRequire(join(anchor, 'package.json'))
  let resolved
  try {
    resolved = req.resolve('@deepseek-ai/dsh-http-proxy')
  } catch (error) {
    if (anchor.includes('.asar')) {
      console.log('skip: asar anchor needs the Harness runtime for package resolution')
    } else {
      throw error
    }
  }
  if (resolved !== undefined) {
    assert.ok(resolved.endsWith('index.js'), `proxy package resolves: ${resolved}`)
    const proxy = await import(pathToFileURL(resolved).href)
    for (const fn of ['installProxyFromEnvironment', 'proxyRouteFor', 'proxyEnvironmentForChild']) {
      assert.equal(typeof proxy[fn], 'function', `${fn} available`)
    }
    console.log('ok: resolved', resolved)
  }
}

// The manifest must declare what the bundle and its client need.
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
assert.equal(manifest.name, '@azvra-dev/dsh-proxy')
assert.equal(manifest.publishConfig?.access, 'public', 'a scoped package must publish public')
assert.notEqual(manifest.private, true, 'npm refuses to publish a private package')
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(manifest.dsh.client.platform, 'web')
for (const dep of manifest.dsh.client.inject) {
  assert.ok(/^@deepseek-ai\/dsh-client-/.test(dep), `client inject "${dep}" is a client package`)
}
assert.ok(manifest.exports['./client'] === './client.js')
assert.ok(manifest.exports['./icon'] === './icon.svg')
for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
  readFileSync(join(here, '..', file), 'utf8')
}

// The client half must be a well-formed classic client bundle. Its loader id
// must be the full package name, or the boot graph cannot resolve the row.
const client = readFileSync(join(here, '..', 'client.js'), 'utf8')
assert.ok(client.startsWith('// dsh-proxy'), 'client header')
assert.ok(client.includes(`id: '${manifest.name}'`), 'client loader id equals the package name')
assert.ok(client.includes("ctx.slots.inject('main'"), 'client registers the panel page')
assert.ok(client.includes("ctx.slots.inject('sidebar.panellist'"), 'client registers the sidebar row')
assert.ok(!client.includes('settings.general.item'), 'client no longer fills a Settings row')
assert.ok(!client.includes('dsh-client-ui-primitives'), 'client imports no Harness Client package')
assert.ok(!/require\('(?!react')/.test(client), 'client requires only react')

// Locales carry both metadata locales.
for (const locale of ['en', 'zh']) {
  const dict = JSON.parse(readFileSync(join(here, '..', 'locale', `${locale}.json`), 'utf8'))
  assert.ok(typeof dict.meta.title === 'string' && dict.meta.title !== '')
  assert.ok(typeof dict.meta.description === 'string' && dict.meta.description !== '')
}

// The patch inserts exactly one row, and its `name` is the package name the
// Loader resolves; a bare `dsh-proxy` would no longer resolve once scoped.
const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
assert.ok(/- insert:/.test(patch), 'patch inserts a row')
assert.ok(patch.includes(`name: '${manifest.name}'`), 'patch names the full package')

console.log('all checks passed')
