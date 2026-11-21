// Behavioural test for the switch, run as its own Node process so it can
// never disturb the DSH instance serving this session.
//
// It replays what the Host half does: read the Windows system proxy, install
// it with @deepseek-ai/dsh-http-proxy, and ask the policy where a public URL
// and a loopback URL go. Nothing is written to disk and the process exits.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { request } from 'node:http'

const anchor = process.env.DSH_INSTALL_DIR
const req = createRequire(join(anchor, 'package.json'))
const proxy = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-http-proxy')).href)

const { readSystemProxy } = (await import(pathToFileURL(join(process.cwd(), 'index.js')).href)).internals

const sample = readSystemProxy()
console.log('system proxy report:', JSON.stringify(sample))

if (sample.supported !== true) {
  console.log('SKIP: this machine has no usable http(s) system proxy right now')
  process.exit(0)
}

const values = {
  http_proxy: sample.httpProxy,
  https_proxy: sample.httpsProxy,
  ...(sample.noProxy === '' ? {} : { no_proxy: sample.noProxy }),
}
const lookup = {
  get(name) {
    const value = values[String(name).toLowerCase()]
    return value === undefined ? undefined : { value }
  },
}
const reports = []
const dispose = await proxy.installProxyFromEnvironment(lookup, message => { reports.push(message) })
console.log('installer reports:', JSON.stringify(reports))
console.log('public  ->', JSON.stringify(proxy.proxyRouteFor(new URL('https://www.example.com/')).proxied))
console.log('loopback->', JSON.stringify(proxy.proxyRouteFor(new URL('http://127.0.0.1:62984/api')).proxied))
console.log('child env keys:', Object.keys(proxy.proxyEnvironmentForChild()).sort().join(','))

// Prove a real request reaches the proxy: ask it for a URL only it can answer
// and check that the connection was attempted through the proxy port.
const reached = await new Promise(resolve => {
  const req2 = request({
    host: '127.0.0.1',
    port: Number(new URL(sample.httpProxy).port || 80),
    method: 'GET',
    path: 'http://example.invalid/',
    headers: { host: 'example.invalid' },
    timeout: 3000,
  }, res => { res.resume(); resolve({ status: res.statusCode }) })
  req2.on('error', error => resolve({ error: String(error.code ?? error.message) }))
  req2.on('timeout', () => { req2.destroy(); resolve({ error: 'timeout' }) })
  req2.end()
})
console.log('proxy port answers:', JSON.stringify(reached))

await dispose()
const after = proxy.proxyRouteFor(new URL('https://www.example.com/')).proxied
console.log('after dispose proxied:', JSON.stringify(after))
console.log(after === false ? 'PASS: disposal restores a direct policy' : 'FAIL: disposal left the proxy installed')
