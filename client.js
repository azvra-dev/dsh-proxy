// dsh-proxy — browser half.
//
// A first-level entry in the left sidebar: "配置代理" (Network proxy). It adds
// one row to `sidebar.panellist` (the glyph) and one page under the `main`
// slot keyed by the same id, so clicking the row opens the page in the centre
// column, exactly like the shipped Plugins and Schedules rows.
//
// The page is deliberately small: two choices, one line of current state, and
// a latency table. Nothing is registered in Settings.
//
// Everything rendered comes from the Host: `GET /dsh-proxy/state` reports the
// mode in effect and what Windows' Internet Options hold; `POST
// /dsh-proxy/mode` performs the switch; `GET /dsh-proxy/latency` measures
// GitHub, Google, and YouTube through whichever policy is installed.
//
// No Harness Client package is imported: the page draws its own controls with
// the host's theme tokens, so an upstream rename or removal degrades
// appearance rather than blanking the slot entry.
window.__ModuleLoader__.load({
  id: '@azvra/dsh-proxy',
  factory(require) {
    const NS = 'dsh-proxy'
    const PANEL_ID = 'dsh-proxy'
    const react = require('react')
    const h = react.createElement
    const { useCallback, useEffect, useRef, useState } = react

    const zh = {
      'nav.panel': '配置代理',
      'page.title': '配置代理',
      'mode.direct': '不使用代理',
      'mode.direct.hint': '直接连接',
      'mode.system': '使用系统代理',
      'mode.system.hint': '沿用 Windows Internet 选项',
      'state.proxied': '经 {proxy} 出站',
      'state.direct': '直接连接',
      'state.untouched': '沿用启动时的代理设置',
      'state.untouched.title': '尚未在此选择',
      'first.use': '在此选择后会覆盖上面的设置，并在下次启动时沿用。',
      'system.title': 'Windows 系统代理',
      'system.ok': '{server}',
      'system.off': '未开启',
      'system.pac': '使用自动配置脚本（PAC），无法使用',
      'system.missing': '已开启但未填服务器地址',
      'system.socks': 'SOCKS，DSH 仅支持 http(s)',
      'system.os': '当前系统不是 Windows',
      'system.reg': '读取失败（reg 查询失败）',
      'system.unavailable': '不可用',
      'latency.title': '访问延迟',
      'latency.test': '测速',
      'latency.retest': '重新测速',
      'latency.running': '测速中…（每个站点最多 10 秒）',
      'latency.none': 'none',
      'latency.timeout': '超时',
      'latency.error': '失败',
      'latency.ms': '{ms} ms',
      'error.switch': '切换失败：{message}',
      'error.read': '读取状态失败：{message}',
      'error.latency': '测速失败：{message}',
      'error.retry': '重试',
      'busy': '应用中…',
      'loading': '读取中…',
    }
    const en = {
      'nav.panel': 'Network proxy',
      'page.title': 'Network proxy',
      'mode.direct': 'No proxy',
      'mode.direct.hint': 'Connect directly',
      'mode.system': 'Use system proxy',
      'mode.system.hint': 'Reuse Windows Internet Options',
      'state.proxied': 'Out through {proxy}',
      'state.direct': 'Direct connection',
      'state.untouched': 'Keeping the launch proxy setting',
      'state.untouched.title': 'Nothing chosen yet',
      'first.use': 'Choosing here overrides that and keeps the choice for the next start.',
      'system.title': 'Windows system proxy',
      'system.ok': '{server}',
      'system.off': 'Off',
      'system.pac': 'A PAC script, which DSH cannot use',
      'system.missing': 'On, but no server address',
      'system.socks': 'SOCKS; DSH supports http(s) only',
      'system.os': 'This system is not Windows',
      'system.reg': 'Unreadable (the reg query failed)',
      'system.unavailable': 'Unavailable',
      'latency.title': 'Latency',
      'latency.test': 'Test',
      'latency.retest': 'Test again',
      'latency.running': 'Measuring… (up to 10 s each)',
      'latency.none': 'none',
      'latency.timeout': 'Timeout',
      'latency.error': 'Failed',
      'latency.ms': '{ms} ms',
      'error.switch': 'The switch failed: {message}',
      'error.read': 'Reading the state failed: {message}',
      'error.latency': 'The test failed: {message}',
      'error.retry': 'Retry',
      'busy': 'Applying…',
      'loading': 'Loading…',
    }

    /** Read the Host's state. */
    async function readState() {
      const response = await fetch('/dsh-proxy/state', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null) {
        throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
      }
      return payload
    }

    /** Ask the Host to switch modes. */
    async function writeMode(mode) {
      const response = await fetch('/dsh-proxy/mode', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ mode }),
      })
      const payload = await response.json().catch(() => null)
      if (payload === null) throw new Error(`HTTP ${response.status}`)
      if (payload.ok !== true) {
        const error = new Error(payload.error ?? `HTTP ${response.status}`)
        error.reason = payload.reason ?? null
        throw error
      }
      return payload
    }

    /** Run the Host-side latency probe. */
    async function readLatency() {
      const response = await fetch('/dsh-proxy/latency', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null) {
        throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
      }
      return payload.results ?? []
    }

    /**
     * Localized text for a system-proxy report.
     * @param system - the report from the Host.
     * @param t - translate function.
     * @returns the sentence, or `undefined` when there is nothing to say.
     */
    function systemNote(system, t) {
      if (system === null || system === undefined) return undefined
      if (system.supported === true) return t('system.ok', { server: system.server })
      switch (system.reason) {
        case 'off': return t('system.off')
        case 'pac': return t('system.pac')
        case 'missing': return t('system.missing')
        case 'socks': return t('system.socks')
        case 'os': return t('system.os')
        case 'reg': return t('system.reg')
        default: return t('system.unavailable')
      }
    }

    /**
     * Localized text for a refusal.
     * @param error - the thrown error, which may carry `reason`.
     * @param t - translate function.
     * @returns the sentence to show.
     */
    function failureText(error, t) {
      const reason = error && typeof error.reason === 'string' ? error.reason : null
      const localized = reason === null ? undefined : systemNote({ supported: false, reason }, t)
      return t('error.switch', { message: localized ?? String((error && error.message) || error) })
    }

    /**
     * Brand marks for the probed sites, from Simple Icons (CC0 1.0).
     *
     * Path data only, in a 24x24 box. A `fill` here is the brand colour the
     * mark is recognised by — Google's four-colour G and YouTube's red plate
     * are the identity, so they carry their own fill. GitHub has no colour form
     * of its own (its official mark is black), so it stays `currentColor` and
     * follows the row's text colour, which is also how GitHub itself inverts it
     * on a dark surface.
     */
    const SITE_ICONS = {
      github: {
        path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
      },
      google: {
        fill: '#4285F4',
        path: 'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
      },
      youtube: {
        fill: '#FF0000',
        path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
      },
      claude: {
        fill: '#D97757',
        path: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
      },
    }

    /**
     * One brand mark.
     * @param props - `id` picks the mark; `size` is the edge in pixels.
     * @returns the inline SVG, or nothing for an unknown site.
     */
    function SiteIcon({ id, size = 16 }) {
      const icon = SITE_ICONS[id]
      if (icon === undefined) return null
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: icon.fill ?? 'currentColor',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      }, h('path', { d: icon.path }))
    }

    /** Page styles: the Plugins/Schedules page column, theme tokens only. */
    const css = `
.dsh-proxy-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 14px;
  line-height: 1.6;
}
.dsh-proxy-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.dsh-proxy-content { max-width: 560px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }
@media (max-width: 767px) { .dsh-proxy-content { padding-inline: 20px; } }
.dsh-proxy-heading { padding-top: 28px; margin-bottom: 20px; }
:global([data-platform='darwin']) .dsh-proxy-heading { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.dsh-proxy-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
.dsh-proxy-group { margin-bottom: 24px; }
.dsh-proxy-groupTitle {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.dsh-proxy-options { display: flex; flex-direction: column; gap: 8px; }
.dsh-proxy-option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  text-align: left;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: border-color .12s ease, background-color .12s ease;
}
@media (hover: hover) {
  .dsh-proxy-option:not(:disabled):not([aria-checked="true"]):hover {
    background: var(--dsw-alias-bg-layer-2);
  }
}
.dsh-proxy-option[aria-checked="true"] { border-color: var(--dsw-alias-brand-primary); }
.dsh-proxy-option:disabled { cursor: default; opacity: .6; }
.dsh-proxy-option:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dsh-proxy-mark {
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 4px;
  border: 1.5px solid var(--dsw-alias-border-l2);
  border-radius: 50%;
}
.dsh-proxy-option[aria-checked="true"] .dsh-proxy-mark {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary);
  box-shadow: inset 0 0 0 3px var(--dsw-alias-bg-base);
}
.dsh-proxy-optionText { min-width: 0; }
.dsh-proxy-optionLabel { font-size: 14px; line-height: 20px; }
.dsh-proxy-optionHint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-proxy-state {
  margin-top: 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-proxy-state strong { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-proxy-alert {
  margin-top: 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-proxy-retry {
  margin-left: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--dsw-alias-link, var(--dsw-alias-state-business-primary));
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.dsh-proxy-latencyHead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.dsh-proxy-latencyHead .dsh-proxy-groupTitle { margin: 0; }
.dsh-proxy-test {
  padding: 3px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
@media (hover: hover) { .dsh-proxy-test:not(:disabled):hover { background: var(--dsw-alias-bg-layer-2); } }
.dsh-proxy-test:disabled { cursor: default; opacity: .6; }
.dsh-proxy-test:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dsh-proxy-latency { display: flex; flex-direction: column; }
.dsh-proxy-latencyRow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 13px;
}
.dsh-proxy-latencyRow:last-child { border-bottom: none; }
.dsh-proxy-latencySite {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dsh-proxy-latencySite svg { flex: none; }
.dsh-proxy-latencyValue { flex: none; font-variant-numeric: tabular-nums; }
.dsh-proxy-good { color: var(--dsw-alias-state-success-primary); }
.dsh-proxy-fair { color: var(--dsw-alias-state-warn-primary); }
.dsh-proxy-bad { color: var(--dsw-alias-state-error-primary); }
.dsh-proxy-muted { color: var(--dsw-alias-label-secondary); }
`

    /**
     * Colour class for one measurement.
     * @param result - the Host's per-site result.
     * @returns a class name carrying the tone.
     */
    function toneOf(result) {
      if (result.ok !== true) return 'dsh-proxy-bad'
      if (result.ms <= 300) return 'dsh-proxy-good'
      if (result.ms <= 1200) return 'dsh-proxy-fair'
      return 'dsh-proxy-bad'
    }

    /**
     * The sidebar glyph for this panel row.
     * @param props - requested edge length and whether the panel is selected.
     * @returns the glyph.
     */
    function PanelGlyph(props) {
      const edge = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', {
        d: 'M4 7.5h4.2M15.8 7.5H20M4 16.5h5.2M16.8 16.5H20',
        stroke: 'currentColor',
        'stroke-width': 1.6,
        'stroke-linecap': 'round',
      }),
      h('rect', { x: 9.2, y: 4.2, width: 5.6, height: 6.6, rx: 1.6, stroke: 'currentColor', 'stroke-width': 1.6 }),
      h('rect', { x: 10.2, y: 13.2, width: 5.6, height: 6.6, rx: 1.6, stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-dasharray': '2.4 2' }),
      )
    }

    /**
     * The proxy page, rendered in the centre column.
     * @param props - slot props; the framework supplies `t` bound to this
     *   namespace from the registration's `locale`.
     * @returns the page element tree.
     */
    function ProxyPage({ t }) {
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)
      const [latency, setLatency] = useState(null)
      const [measuring, setMeasuring] = useState(false)
      const [latencyError, setLatencyError] = useState(null)
      const live = useRef(true)
      const optionRefs = useRef({})
      const measureRun = useRef(0)

      useEffect(() => {
        live.current = true
        return () => { live.current = false }
      }, [])

      const refresh = useCallback(() => {
        readState()
          .then(next => {
            if (!live.current) return
            setState(next)
            // A refusal recorded before this page opened — a saved mode whose
            // Windows proxy has since been switched off, say — is the state's
            // own `ok:false`, not an HTTP failure.
            if (next.ok !== true) setFailure(failureText({ reason: next.reason, message: next.error }, t))
          })
          .catch(error => {
            if (live.current) setFailure(t('error.read', { message: String((error && error.message) || error) }))
          })
      }, [t])

      useEffect(() => { refresh() }, [refresh])

      const measure = useCallback(() => {
        // Tag this run. Switching modes bumps the tag, so a probe that was in
        // flight across a switch cannot land its old-path figures on the new
        // path — and a result always belongs to the run that is still current.
        measureRun.current += 1
        const run = measureRun.current
        setMeasuring(true)
        setLatencyError(null)
        readLatency()
          .then(results => {
            if (!live.current || run !== measureRun.current) return
            setLatency(results)
          })
          .catch(error => {
            if (!live.current || run !== measureRun.current) return
            setLatencyError(t('error.latency', { message: String((error && error.message) || error) }))
          })
          .finally(() => {
            if (!live.current || run !== measureRun.current) return
            setMeasuring(false)
          })
      }, [t])

      const select = useCallback(mode => {
        if (busy || state === null) return
        // Only a managed selection can already be in force: before the first
        // choice the Host reports a mode it did not install, and treating that
        // as the current selection would make the default option a dead button.
        if (state.managed === true && state.mode === mode) return
        setBusy(true)
        setFailure(null)
        writeMode(mode)
          .then(next => {
            if (!live.current) return
            setState(next)
            // The path just changed, so any previous figure describes the old
            // path. Clear it to `none` and stop there: switching modes and
            // measuring latency are two separate actions, and a switch must not
            // start network activity the user did not ask for.
            setLatency(null)
            setLatencyError(null)
            // Invalidate a probe still in flight from the old path.
            measureRun.current += 1
            setMeasuring(false)
          })
          .catch(error => {
            if (!live.current) return
            setFailure(failureText(error, t))
            readState().then(next => { if (live.current) setState(next) }).catch(() => undefined)
          })
          .finally(() => { if (live.current) setBusy(false) })
      }, [busy, state, t])

      const mode = state === null ? null : state.mode
      const managed = state !== null && state.managed === true
      const system = state === null ? null : state.system
      const summary = state === null
        ? t('loading')
        : managed
          ? (state.applied?.proxied === true
            ? t('state.proxied', { proxy: state.applied.proxy })
            : t('state.direct'))
          : t('state.untouched')

      const option = (id, labelKey, hintKey) => h('button', {
        key: id,
        ref: node => { optionRefs.current[id] = node },
        type: 'button',
        role: 'radio',
        className: 'dsh-proxy-option',
        'aria-checked': managed && mode === id,
        disabled: busy || state === null,
        tabIndex: (managed && mode === id) || (!managed && id === 'direct') ? 0 : -1,
        onClick: () => { select(id) },
        onKeyDown: event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault()
          const next = id === 'direct' ? 'system' : 'direct'
          // Selection and focus move together: leaving the ring on the option
          // that just became non-tabbable would strand a keyboard user.
          optionRefs.current[next]?.focus()
          select(next)
        },
      },
      h('span', { className: 'dsh-proxy-mark', 'aria-hidden': true }),
      h('span', { className: 'dsh-proxy-optionText' },
        h('span', { className: 'dsh-proxy-optionLabel', style: { display: 'block' } }, t(labelKey)),
        h('span', { className: 'dsh-proxy-optionHint', style: { display: 'block' } }, t(hintKey)),
      ))

      // Rows come from the fixed site list, so every probed site is always present;
      // an unmeasured site reads `none` rather than an empty cell. The row names
      // the site, not its URL: a host string is noise at a glance.
      const siteIds = ['github', 'google', 'youtube', 'claude']
      const siteNames = { github: 'GitHub', google: 'Google', youtube: 'YouTube', claude: 'Claude' }
      const byId = new Map((latency ?? []).map(result => [result.id, result]))
      const latencyRows = siteIds.map(id => {
        const result = byId.get(id)
        const value = result === undefined
          ? t('latency.none')
          : result.ok === true
            ? t('latency.ms', { ms: result.ms })
            : result.reason === 'timeout'
              ? t('latency.timeout')
              : t('latency.error')
        return h('div', { className: 'dsh-proxy-latencyRow', key: id },
          h('span', { className: 'dsh-proxy-latencySite' },
            h(SiteIcon, { id }),
            h('span', null, siteNames[id]),
          ),
          h('span', {
            className: `dsh-proxy-latencyValue ${result === undefined ? 'dsh-proxy-muted' : toneOf(result)}`,
          }, value),
        )
      })

      return h('section', { className: 'dsh-proxy-page', 'aria-label': t('page.title') },
        h('style', null, css),
        h('div', { className: 'dsh-proxy-scroll' },
          h('div', { className: 'dsh-proxy-content' },
            h('div', { className: 'dsh-proxy-heading' },
              h('h1', { className: 'dsh-proxy-title' }, t('page.title')),
            ),

            h('div', { className: 'dsh-proxy-group' },
              h('div', { className: 'dsh-proxy-options', role: 'radiogroup', 'aria-label': t('nav.panel'), 'aria-busy': busy },
                option('direct', 'mode.direct', 'mode.direct.hint'),
                option('system', 'mode.system', 'mode.system.hint'),
              ),
              h('div', { className: 'dsh-proxy-state' },
                busy ? t('busy') : h('strong', null, summary),
                managed ? null : ` · ${t('first.use')}`,
              ),
              h('div', { className: 'dsh-proxy-state' },
                `${t('system.title')}：${systemNote(system, t) ?? t('loading')}`,
              ),
              failure !== null
                ? h('div', { className: 'dsh-proxy-alert', role: 'alert' },
                  failure,
                  h('button', { type: 'button', className: 'dsh-proxy-retry', onClick: () => { setFailure(null); refresh() } },
                    t('error.retry')))
                : null,
            ),

            h('div', { className: 'dsh-proxy-group' },
              h('div', { className: 'dsh-proxy-latencyHead' },
                h('h2', { className: 'dsh-proxy-groupTitle' }, t('latency.title')),
                h('button', {
                  type: 'button',
                  className: 'dsh-proxy-test',
                  disabled: measuring,
                  onClick: measure,
                }, t(latency === null ? 'latency.test' : 'latency.retest')),
              ),
              h('div', { className: 'dsh-proxy-latency', 'aria-live': 'polite' }, latencyRows),
              // The rows stay mounted and read `none` until a result arrives, so
              // the in-flight state needs its own line instead of replacing them.
              measuring
                ? h('div', { className: 'dsh-proxy-state dsh-proxy-muted' }, t('latency.running'))
                : null,
              latencyError === null
                ? null
                : h('div', { className: 'dsh-proxy-alert', role: 'alert' }, latencyError),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-proxy: dictionaries')
        // The page: a `main` panel keyed by the sidebar entry id. It receives no
        // Session binding, so it stays reachable without an open conversation.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, ProxyPage))
        // The sidebar row. `sidebar.panellist` entries are built from slot
        // metadata, so `label` names the row and this component is its glyph.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          label: () => ctx.locale.bind(NS)('nav.panel'),
          locale: NS,
        }, PanelGlyph))
      },
    }
  },
})
