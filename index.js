/**
 * dsh-proxy — choose how this DSH process reaches the network.
 *
 * Two modes:
 *
 *   direct   DSH connects to the internet without any proxy.
 *   system   DSH routes its outbound HTTP through the proxy that Windows'
 *            Internet Options name (the same setting Chrome, Edge, and the
 *            desktop apps use), read from the registry at switch time.
 *
 * The switch is a real switch, not a preference file: DSH resolves its proxy
 * once at launch and installs the answer as undici's global dispatcher, which
 * is what Node's `fetch` uses. So changing the mode means replacing that
 * dispatcher while the process keeps running. `@deepseek-ai/dsh-http-proxy`
 * ships exactly the layering this needs — its installer keeps the previous
 * dispatcher and restores it on disposal, and a policy that proxies nothing
 * installs a direct dispatcher instead of leaving the previous one in place.
 *
 * Deliberately NOT proxied: loopback (dsh-http-proxy always bypasses it), the
 * Node ptc-runtime and workflow workers (model-authored code must not receive
 * a proxy URL that may carry a password), and OTLP telemetry (it uses
 * node:http, not fetch).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-proxy'

/** Route prefix of this plugin's own JSON endpoints. */
const ROUTE_BASE = '/dsh-proxy'

/** Accepted mode ids. */
const MODES = new Set(['direct', 'system'])

/**
 * Every environment name that carries proxy configuration, plus the flag that
 * makes a child Node process honour them. The list matches the names
 * `dsh-http-proxy` publishes, so a snapshot restores exactly what this plugin
 * could have changed.
 */
const PROXY_ENV_NAMES = [
  'http_proxy', 'HTTP_PROXY',
  'https_proxy', 'HTTPS_PROXY',
  'no_proxy', 'NO_PROXY',
  'all_proxy', 'ALL_PROXY',
  'NODE_USE_ENV_PROXY',
]

/** Windows Internet Options key that holds the WinINET ("system") proxy. */
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** Largest accepted request body for the mode endpoint. */
const BODY_LIMIT = 4096

/**
 * Read the current value of every proxy-related environment name.
 * @returns a snapshot that {@link restoreProxyEnv} can put back.
 */
function snapshotProxyEnv() {
  const snapshot = {}
  for (const entry of PROXY_ENV_NAMES) snapshot[entry] = process.env[entry]
  return snapshot
}

/**
 * Restore a snapshot taken by {@link snapshotProxyEnv}.
 * @param snapshot - the values to put back; `undefined` removes a name.
 */
function restoreProxyEnv(snapshot) {
  for (const entry of PROXY_ENV_NAMES) {
    const value = snapshot[entry]
    if (value === undefined) Reflect.deleteProperty(process.env, entry)
    else process.env[entry] = value
  }
}

/**
 * Remove every proxy name from this process's environment.
 *
 * Used by `direct`: DSH's own requests are already routed by the dispatcher,
 * but the shell tools, `git`, and MCP servers DSH spawns copy this
 * environment, and a child that still sees `HTTPS_PROXY` would keep
 * tunnelling through the proxy the user just turned off.
 */
function clearProxyEnv() {
  for (const entry of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, entry)
}

/**
 * Parse `reg query <key>` output into a value table.
 *
 * The format is one `    Name    REG_TYPE    Value` line per value. Only the
 * names this plugin reads are used, and all of them are single ASCII tokens.
 * @param text - stdout of `reg query`.
 * @returns name to raw value text.
 */
function parseRegQuery(text) {
  const values = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line)
    if (match !== null) values[match[1]] = match[3].trim()
  }
  return values
}

/**
 * Turn a WinINET `ProxyServer` value into per-scheme endpoints.
 *
 * Windows accepts either one `host:port` used for every scheme, or a
 * `scheme=host:port` list where `http=` is also the fallback for `https:`.
 * @param raw - the `ProxyServer` value.
 * @returns endpoints keyed by `http` and `https`, each `host:port`.
 */
function proxyEndpoints(raw) {
  const parts = String(raw ?? '').split(';').map(part => part.trim()).filter(part => part !== '')
  if (parts.length === 0) return {}
  const list = parts.every(part => !part.includes('='))
  /** @type {Record<string, string>} */
  const byScheme = {}
  if (list) {
    byScheme.http = parts[0]
    byScheme.https = parts[0]
  } else {
    for (const part of parts) {
      const equals = part.indexOf('=')
      if (equals === -1) continue
      const scheme = part.slice(0, equals).trim().toLowerCase()
      const target = part.slice(equals + 1).trim()
      if (target !== '') byScheme[scheme] = target
    }
    if (byScheme.https === undefined && byScheme.http !== undefined) byScheme.https = byScheme.http
  }
  return byScheme
}

/**
 * Prefix a scheme-less `host:port` with `http://` and validate the result.
 * @param value - a WinINET endpoint.
 * @returns the `http(s)://` proxy URL, or `undefined` when unusable.
 */
function proxyUrl(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed === '') return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href.replace(/\/$/, '') : undefined
  } catch {
    return undefined
  }
}

/**
 * Convert the WinINET `ProxyOverride` list into a `no_proxy` list.
 *
 * Entries DSH's matcher cannot express are dropped rather than passed
 * through: `127.*` and `10.0.0.0/8` style wildcards and CIDRs never match a
 * host-suffix rule, and `<local>` is WinINET's own keyword. Loopback needs no
 * entry because `dsh-http-proxy` always bypasses it.
 * @param raw - the `ProxyOverride` value.
 * @returns comma-separated host suffixes.
 */
function noProxyList(raw) {
  const entries = String(raw ?? '').split(';').map(part => part.trim()).filter(part => part !== '')
  const kept = []
  for (const entry of entries) {
    if (entry.includes('<') || entry.includes('/') || entry === '*') continue
    if (entry.includes('*')) {
      // Only a leading `*.` is expressible as a suffix rule.
      if (!entry.startsWith('*.')) continue
      kept.push(entry.slice(2))
      continue
    }
    kept.push(entry)
  }
  return [...new Set(kept)].join(',')
}

/**
 * Absolute path of this machine's `reg.exe`.
 * @returns the executable to run.
 */
function regExecutable() {
  const root = process.env.SystemRoot
  if (typeof root === 'string' && root !== '') {
    const candidate = join(root, 'System32', 'reg.exe')
    if (existsSync(candidate)) return candidate
  }
  return 'reg'
}

/**
 * Read the Windows system proxy.
 * @returns a report with `supported`, and on success the resolved proxy URLs.
 */
function readSystemProxy() {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'os', enabled: false }
  }
  const result = spawnSync(regExecutable(), ['query', REG_KEY], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 4000,
  })
  if (result.error !== undefined && result.error !== null) {
    return { supported: false, reason: 'reg', enabled: false, detail: String(result.error.message ?? result.error) }
  }
  const values = parseRegQuery(result.stdout)
  const enabled = typeof values.ProxyEnable === 'string' && /^0x0*1$/i.test(values.ProxyEnable)
  const pac = typeof values.AutoConfigURL === 'string' ? values.AutoConfigURL.trim() : ''
  const server = typeof values.ProxyServer === 'string' ? values.ProxyServer.trim() : ''
  const override = typeof values.ProxyOverride === 'string' ? values.ProxyOverride.trim() : ''

  if (!enabled) {
    return { supported: false, reason: pac === '' ? 'off' : 'pac', enabled: false, pac, server }
  }
  if (server === '') {
    return { supported: false, reason: pac === '' ? 'missing' : 'pac', enabled: true, pac, server }
  }
  const endpoints = proxyEndpoints(server)
  const http = proxyUrl(endpoints.http)
  const https = proxyUrl(endpoints.https ?? endpoints.http)
  if (http === undefined && https === undefined) {
    // A `socks=` only value: DSH routes http(s) proxies only.
    return { supported: false, reason: 'socks', enabled: true, pac, server }
  }
  return {
    supported: true,
    enabled: true,
    pac,
    server,
    httpProxy: http,
    httpsProxy: https,
    noProxy: noProxyList(override),
  }
}

// --- proxy kernel ------------------------------------------------------------

/**
 * Locate a Node package from this plugin.
 *
 * A bundle resolves dsh's own packages through the profile's runtime
 * interception, which is not guaranteed for every package, so plain Node
 * resolution from the profile directory and the installation anchor is tried
 * as well.
 * @param specifier - bare package name.
 * @param anchors - absolute package.json paths to resolve from.
 * @returns the imported module namespace.
 */
async function importWithFallback(specifier, anchors) {
  const failures = []
  try {
    return await import(specifier)
  } catch (error) {
    failures.push(`${specifier}: ${String(error?.message ?? error)}`)
  }
  for (const anchor of anchors) {
    try {
      const file = createRequire(anchor).resolve(specifier)
      return await import(pathToFileURL(file).href)
    } catch (error) {
      failures.push(`${specifier} from ${anchor}: ${String(error?.message ?? error)}`)
    }
  }
  throw new Error(`cannot load ${specifier} (${failures.join(' | ')})`)
}

/**
 * Resolve, once per process, the code that installs this process's outbound
 * proxy policy.
 *
 * The preferred carrier is `@deepseek-ai/dsh-http-proxy`, which owns the
 * process-wide dispatcher contract. When it cannot be loaded the plugin falls
 * back to undici directly, which can still replace the global dispatcher but
 * cannot honour the same bypass rules.
 * @param ctx - plugin context, read for profile locations.
 * @returns a kernel with `install(values)` and `routeFor(url)`.
 */
function createKernelLoader(ctx) {
  let pending
  return () => {
    pending ??= (async () => {
      const profileContext = ctx.get('profileContext')
      const anchors = []
      if (typeof profileContext?.dir === 'string') anchors.push(join(profileContext.dir, 'package.json'))
      if (typeof profileContext?.installAnchor === 'string') anchors.push(profileContext.installAnchor)

      try {
        const mod = await importWithFallback('@deepseek-ai/dsh-http-proxy', anchors)
        if (typeof mod.installProxyFromEnvironment === 'function' && typeof mod.proxyRouteFor === 'function') {
          return {
            kind: 'dsh-http-proxy',
            /**
             * Install one policy.
             * @param values - proxy environment values, empty for a direct policy.
             * @returns the disposer and any diagnostic the package reported.
             */
            async install(values) {
              const lookup = {
                get(envName) {
                  const value = values[String(envName).toLowerCase()]
                  return value === undefined ? undefined : { value }
                },
              }
              const reports = []
              const dispose = await mod.installProxyFromEnvironment(lookup, message => { reports.push(message) })
              return { dispose, reports }
            },
            /**
             * Ask the policy now in force how one URL is sent.
             * @param url - URL to resolve.
             * @returns whether it is proxied and through which proxy.
             */
            routeFor(url) {
              const route = mod.proxyRouteFor(url)
              return { proxied: route.proxied === true, proxy: route.proxied === true ? route.proxy : null }
            },
          }
        }
        throw new Error('@deepseek-ai/dsh-http-proxy exports changed')
      } catch (packageError) {
        try {
          const undici = await importWithFallback('undici', anchors)
          return {
            kind: 'undici',
            /**
             * Ask the published environment where one URL would go. Without
             * this package's matcher the bypass list cannot be honoured, so a
             * loopback URL is still reported as proxied here; the dispatcher
             * itself is undici's own.
             * @param url - URL to describe.
             */
            routeFor(url) {
              const scheme = url.protocol === 'https:' ? 'https_proxy' : url.protocol === 'http:' ? 'http_proxy' : undefined
              const proxy = scheme === undefined ? undefined : process.env[scheme]
              return { proxied: proxy !== undefined, proxy: proxy ?? null }
            },
            async install(values) {
              const previous = undici.getGlobalDispatcher()
              const http = values.http_proxy
              const https = values.https_proxy
              const dispatcher = http === undefined && https === undefined
                ? new undici.Agent()
                : new undici.EnvHttpProxyAgent()
              undici.setGlobalDispatcher(dispatcher)
              return {
                reports: [],
                async dispose() {
                  undici.setGlobalDispatcher(previous)
                  try { await dispatcher.close() } catch { /* already closed */ }
                },
              }
            },
            /**
             * This carrier reads the published environment at call time, which
             * is what its dispatcher was built from.
             * @param url - URL to describe.
             */
            routeFor(url) {
              const scheme = url.protocol === 'https:' ? 'https_proxy' : url.protocol === 'http:' ? 'http_proxy' : undefined
              const proxy = scheme === undefined ? undefined : process.env[scheme]
              return { proxied: proxy !== undefined, proxy: proxy ?? null }
            },
          }
        } catch (undiciError) {
          throw new Error(`${String(packageError?.message ?? packageError)}; fallback: ${String(undiciError?.message ?? undiciError)}`)
        }
      }
    })()
    return pending
  }
}

// --- state -------------------------------------------------------------------

/**
 * Resolve this profile's DSH home directory.
 * @param ctx - plugin context.
 * @returns absolute directory holding the saved mode.
 */
function resolveHome(ctx) {
  const home = ctx.get('profileContext')?.home
  if (typeof home === 'string' && home !== '') return home
  return join(homedir(), '.dsh')
}

/**
 * Read the saved mode.
 * @param file - absolute path of the store.
 * @returns the saved mode, or `undefined` when nothing valid is stored.
 */
function readSavedMode(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return MODES.has(parsed?.mode) ? parsed.mode : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the chosen mode.
 * @param file - absolute path of the store.
 * @param mode - the mode to save.
 */
function writeSavedMode(file, mode) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ mode, version: 1 }, null, 2)}\n`, 'utf8')
}

/**
 * Explain a system-proxy report in one sentence for the operator log.
 * @param system - the report from {@link readSystemProxy}.
 * @returns a diagnostic message.
 */
function systemProxyProblem(system) {
  switch (system.reason) {
    case 'os': return 'system proxy cannot be read on this platform'
    case 'pac': return 'the system proxy is an automatic configuration script (PAC), which DSH cannot use'
    case 'off': return 'the Windows system proxy is switched off'
    case 'missing': return 'the Windows system proxy is enabled but has no server address'
    case 'socks': return 'the Windows system proxy names a SOCKS server; DSH supports http(s) proxies only'
    case 'reg': return `the Windows proxy settings could not be read (${system.detail ?? 'reg query failed'})`
    default: return 'the Windows system proxy is unavailable'
  }
}

/**
 * Mount the settings switch: two JSON routes and the saved-mode bootstrap.
 * @param ctx - plugin context.
 * @param routes - host routes and auth helpers.
 */
function install(ctx, routes) {
  const { webServer, guard } = routes
  const storeFile = join(resolveHome(ctx), 'dsh-proxy.json')
  const loadKernel = createKernelLoader(ctx)
  const baseEnv = snapshotProxyEnv()
  const runtime = {
    /** Effective mode. */
    mode: 'direct',
    /** Result of the last apply, or `null` before the first one. */
    applied: null,
    /** Message of the last failure. */
    error: null,
    /** Loaded kernel kind. */
    kernel: null,
    /** Serializes applies so two clicks cannot interleave. */
    queue: Promise.resolve(),
    /** Disposer returned by the active installer. */
    disposeInstaller: null,
    /** Whether this plugin has installed a policy at all. */
    managed: false,
    /** Machine-readable reason of the last refusal, for localized copy. */
    reason: null,
    /** Informational diagnostic from the carrier; never marks the switch failed. */
    warning: null,
  }

  /** Tear the active installation down and put the launch environment back. */
  async function reset() {
    const dispose = runtime.disposeInstaller
    runtime.disposeInstaller = null
    if (dispose !== undefined) {
      try { await dispose() } catch { /* the previous installer is gone either way */ }
    }
    restoreProxyEnv(baseEnv)
  }

  /**
   * Read where a public HTTPS URL is being sent by the policy in force, without
   * installing one. Used before the user has ever chosen a mode, so the row
   * reports the launcher's policy instead of changing it.
   * @returns the current answer.
   */
  async function probeRoute() {
    try {
      const kernel = await loadKernel()
      runtime.kernel = kernel.kind
      if (typeof kernel.routeFor === 'function') return kernel.routeFor(new URL('https://www.example.com/'))
    } catch { /* fall through to the launch environment */ }
    const proxy = baseEnv.https_proxy ?? baseEnv.HTTPS_PROXY ?? baseEnv.all_proxy ?? baseEnv.ALL_PROXY
    return proxy === undefined ? { proxied: false, proxy: null } : { proxied: true, proxy }
  }

  /**
   * Put one mode into effect.
   *
   * Everything that can refuse — loading the carrier, reading Windows' proxy —
   * happens before the active policy is torn down, so a refused switch leaves
   * the connection that was working in place.
   * @param mode - `direct` or `system`.
   * @returns the installed policy's answer for a public HTTPS URL.
   */
  async function applyMode(mode) {
    const kernel = await loadKernel()
    runtime.kernel = kernel.kind
    let values = {}
    if (mode === 'system') {
      const system = readSystemProxy()
      if (!system.supported) {
        const failure = new Error(systemProxyProblem(system))
        failure.reason = system.reason
        throw failure
      }
      values = {
        http_proxy: system.httpProxy,
        https_proxy: system.httpsProxy,
        ...(system.noProxy === '' ? {} : { no_proxy: system.noProxy }),
      }
    }
    await reset()
    const installed = await kernel.install(values)
    runtime.disposeInstaller = installed.dispose
    runtime.managed = true
    if (mode === 'system') {
      // Child processes: Node honours these names only with the flag, and the
      // shell tools, git, and MCP servers read the names themselves.
      process.env.NODE_USE_ENV_PROXY = '1'
    } else {
      clearProxyEnv()
      delete process.env.NODE_USE_ENV_PROXY
    }
    runtime.mode = mode
    runtime.applied = { ...kernel.routeFor(new URL('https://www.example.com/')), at: Date.now() }
    // A diagnostic the package printed is informational: the policy is
    // installed and persisted, so it belongs beside the state, not in `ok`.
    runtime.warning = installed.reports.length > 0 ? installed.reports.join('; ') : null
    return runtime.applied
  }

  /**
   * Undo a failed first activation.
   *
   * Before the user has chosen anything this plugin manages nothing, so a
   * refused switch must put that state back exactly: the launcher's policy
   * returns and the row keeps reporting it without pretending a selection was
   * made. Once a mode is managed, a refusal instead restores the previous one.
   * @param wasManaged - whether a mode was already in force before the attempt.
   * @param previous - the mode in force before the attempt.
   */
  async function rollback(wasManaged, previous) {
    if (wasManaged) {
      runtime.mode = previous
      try {
        await applyMode(previous)
      } catch { /* the policy from before the attempt stays installed */ }
      return
    }
    // Never chosen: drop our installation and hand the environment back.
    await reset()
    runtime.managed = false
    runtime.mode = 'direct'
    runtime.applied = { ...(await probeRoute()), at: Date.now() }
  }

  /**
   * Serialize one mode change and persist it.
   *
   * A refused switch leaves the connection the user had in place and reports
   * why; it never guesses a substitute mode.
   * @param mode - `direct` or `system`.
   * @returns the state view after the change.
   */
  function switchTo(mode) {
    const run = async () => {
      const previous = runtime.mode
      const wasManaged = runtime.managed
      runtime.error = null
      runtime.reason = null
      runtime.warning = null
      try {
        await applyMode(mode)
        writeSavedMode(storeFile, mode)
      } catch (error) {
        runtime.error = String(error?.message ?? error)
        runtime.reason = typeof error?.reason === 'string' ? error.reason : null
        await rollback(wasManaged, previous)
        throw Object.assign(new Error(runtime.error), { reason: runtime.reason })
      }
      return view()
    }
    const result = runtime.queue.then(run, run)
    runtime.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** @returns the state the settings row renders. */
  function view() {
    return {
      ok: runtime.error === null,
      mode: runtime.mode,
      managed: runtime.managed,
      applied: runtime.applied === null
        ? null
        : { proxied: runtime.applied.proxied, proxy: runtime.applied.proxy, at: runtime.applied.at },
      kernel: runtime.kernel,
      error: runtime.error,
      reason: runtime.reason,
      warning: runtime.warning,
      system: readSystemProxy(),
    }
  }

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  /**
   * Read a bounded JSON body.
   * @param req - the incoming request.
   * @returns the parsed object, or `undefined` when the body is unusable.
   */
  const readJsonBody = req => new Promise(resolve => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        const parsed = text === '' ? {} : JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined)
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
    req.on('aborted', () => resolve(undefined))
  })

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/latency`,
    handler: async (req, res) => {
      if (!guard(req, res, sendJson)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      sendJson(res, 200, { ok: true, results: await measureSites() })
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/state`,
    handler: (req, res) => {
      if (!guard(req, res, sendJson)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      sendJson(res, 200, view())
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/mode`,
    handler: async (req, res) => {
      if (!guard(req, res, sendJson)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'malformed JSON body' })
        return
      }
      const mode = typeof body.mode === 'string' ? body.mode.trim() : ''
      if (!MODES.has(mode)) {
        sendJson(res, 400, { ok: false, error: 'mode must be "direct" or "system"' })
        return
      }
      try {
        sendJson(res, 200, await switchTo(mode))
      } catch (error) {
        const reason = typeof error?.reason === 'string' ? error.reason : null
        sendJson(res, 200, { ...view(), ok: false, error: String(error?.message ?? error), reason })
      }
    },
  }))

  // First activation: report the policy the launcher installed and install
  // nothing, so mounting this plugin never changes how DSH connects until the
  // user picks a mode. A saved choice from an earlier session is re-applied.
  const saved = readSavedMode(storeFile)
  runtime.mode = saved === 'system' ? 'system' : 'direct'
  void (async () => {
    if (saved === undefined) {
      runtime.applied = { ...(await probeRoute()), at: Date.now() }
      return
    }
    try {
      await applyMode(runtime.mode)
    } catch (error) {
      // The saved mode is no longer usable (Windows' proxy was switched off,
      // say). Keep reporting the launch policy and leave the choice unmanaged
      // so the row shows the truth instead of a failed selection.
      await rollback(false, 'direct')
      runtime.error = String(error?.message ?? error)
      runtime.reason = typeof error?.reason === 'string' ? error.reason : null
    }
  })()
  ctx.effect(() => () => {
    void reset()
  })
}

/**
 * Sites the latency check probes, in display order.
 *
 * Only endpoints that answer a bare `HEAD`/`GET` to any internet user are
 * listed: a captcha wall or a consent redirect would measure the wall, not the
 * network. `no-cors` on the browser side is irrelevant here because the probe
 * runs on the Host, which sees the real status.
 */
const PROBE_SITES = [
  { id: 'github', host: 'github.com', url: 'https://github.com/robots.txt' },
  { id: 'google', host: 'www.google.com', url: 'https://www.google.com/generate_204' },
  { id: 'youtube', host: 'www.youtube.com', url: 'https://www.youtube.com/robots.txt' },
  { id: 'claude', host: 'claude.ai', url: 'https://claude.ai/robots.txt' },
]

/** Per-site ceiling. The brief allows ten seconds; nothing here waits longer. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * Measure one site through the policy currently installed.
 *
 * The probe issues a real request with the process-wide `fetch`, so it travels
 * the same dispatcher — and therefore the same proxy — as every other DSH
 * request, which is the whole point of measuring after a switch.
 * @param site - the site descriptor.
 * @param signal - aborts the request when the ceiling is reached.
 * @returns a settled result; a failure is reported, never thrown.
 */
async function probeSite(site, signal) {
  const started = performance.now()
  try {
    const response = await fetch(site.url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'dsh-proxy/latency' },
    })
    const elapsed = Math.round(performance.now() - started)
    // Any HTTP answer proves the path worked; the body is never read.
    try { await response.body?.cancel() } catch { /* nothing to release */ }
    return { id: site.id, host: site.host, ok: true, ms: elapsed, status: response.status }
  } catch (error) {
    const elapsed = Math.round(performance.now() - started)
    const timedOut = signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
    return {
      id: site.id,
      host: site.host,
      ok: false,
      ms: timedOut ? PROBE_TIMEOUT_MS : elapsed,
      status: null,
      reason: timedOut ? 'timeout' : 'error',
      detail: timedOut ? null : String(error?.cause?.code ?? error?.message ?? error).slice(0, 120),
    }
  }
}

/**
 * Probe every site in parallel under one per-site ceiling.
 * @returns one result per site, in {@link PROBE_SITES} order.
 */
async function measureSites() {
  return await Promise.all(PROBE_SITES.map(async site => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, PROBE_TIMEOUT_MS)
    try {
      return await probeSite(site, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }))
}

/**
 * Decide whether one request may use these endpoints.
 *
 * The switch is local-only state, so the check is the one a local web route
 * needs: a loopback socket, a loopback Host header, and a same-origin Origin
 * when the browser sends one. A tunneled or LAN caller is rejected before any
 * process state is touched.
 * @param req - the incoming request.
 * @param res - the response to answer on rejection.
 * @param sendJson - the JSON writer.
 * @returns true when the request may proceed.
 */
function guard(req, res, sendJson) {
  const socketAddress = String(req.socket?.remoteAddress ?? '')
  const bare = socketAddress.startsWith('::ffff:') ? socketAddress.slice('::ffff:'.length) : socketAddress
  const loopback = bare === '::1' || bare === '::' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
  if (!loopback) {
    sendJson(res, 403, { ok: false, error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) {
    sendJson(res, 403, { ok: false, error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request' })
      return false
    }
  }
  return true
}

/**
 * Mount the switch on the web host when this composition has one.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const start = webServer => {
    if (webServer === undefined || typeof webServer.register !== 'function') return
    install(ctx, { webServer, guard })
  }
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) start(webServer)
  else ctx.inject(['webServer'], sub => start(sub.webServer))
}

/** Pure helpers, exported for the plugin's own checks. */
export const internals = {
  parseRegQuery,
  proxyEndpoints,
  proxyUrl,
  noProxyList,
  readSystemProxy,
  PROBE_SITES,
  PROBE_TIMEOUT_MS,
  measureSites,
}
