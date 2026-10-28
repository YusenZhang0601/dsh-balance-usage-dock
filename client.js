window.__ModuleLoader__.load({
  id: 'dsh-balance-usage-dock',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = React

    const NS = 'balance-usage'
    const API_PATH = '/balance-usage-api'
    const SCHEDULER_TICK_MS = 1000
    const CONFIG_TTL_MS = 5 * 60 * 1000
    const PRICING_TTL_MS = 5 * 60 * 1000
    const BACKOFF_BASE_MS = 2000
    const BACKOFF_CAP_MS = 60000
    const RETRY_DELAYS_MS = [400, 1200]
    const CELL_STEP_PX = 15

    // ---------------------------------------------------------------------
    // Localised copy. Flat keys are what the locale service resolves; the
    // bundled dictionaries are also the offline fallback when the locale
    // service (or its snapshot) is unavailable.
    // ---------------------------------------------------------------------
    const ZH = Object.freeze({
      'dock.balance': '余额',
      'dock.session': '本会话',
      'dock.loading': '加载中',
      'dock.unavailable': '不可用',
      'dock.noPrice': '未找到价格',
      'dock.openTitle': '点击查看用量与余额详情',
      'dock.subagentTitle': '（含 {count} 个子智能体）',
      'panel.title': '余额与用量',
      'panel.close': '关闭',
      'panel.refresh': '刷新',
      'panel.refreshing': '刷新中…',
      'panel.providers': '供应商',
      'panel.summary': '用量汇总',
      'panel.today': '今日',
      'panel.last7': '近 7 天',
      'panel.last30': '近 30 天',
      'panel.last90': '近 90 天',
      'panel.tokens': 'tokens',
      'panel.estimated': '估算',
      'panel.heatmap': '近 90 天用量热力图',
      'panel.none': '暂无数据',
      'panel.error': '读取失败',
      'panel.retry': '重试',
      'panel.footer': '金额为按运行时价格计算的估算值，不是官方账单；已跳过会话 fork 继承的历史事件。',
      'panel.priceSource': '价格来源',
      'panel.priceUpdated': '价格更新时间',
      'panel.priceStale': '价格缓存已过期',
      'panel.priceMissing': '未找到价格来源，可在插件配置的 priceOverrides 中填写。',
      'panel.truncated': '仅统计最近 {count} 个会话。',
      'panel.scanned': '已扫描 {count} 个会话',
      'panel.active': '当前使用',
      'panel.noCredential': '未配置凭据',
      'panel.unsupported': '无余额接口',
      'panel.noSubscription': '无有效订阅',
      'panel.reauthRequired': '需要重新登录',
      'panel.stale': '数据可能过期',
      'panel.loading': '加载中…',
      'panel.less': '少',
      'panel.more': '多',
      'panel.amountUnavailable': '金额不可用',
      'panel.statusOk': '正常',
      'panel.statusError': '错误',
      'panel.missingAuthorization': '需要授权',
      'panel.reset': '重置',
      'panel.sessions': '会话',
      'panel.balance': '余额',
      'panel.usage': '额度',
      'panel.sourceOverride': '手动覆盖',
      'panel.sourceProvider': '供应商接口',
      'panel.sourceOfficial': '官方价格页',
      'panel.sourceModelsDev': 'models.dev',
      'panel.sourceNone': '未获取价格',
      'panel.subagent': '其中子智能体：',
      'panel.subagentLine': '{count} 个 · {amount}（含 tokens {tokens}）',
      'panel.retrying': '取不到最新数据，正在重试（{n}/{m}）…',
      'panel.loadingRetry': '加载中，正在重试（{n}/{m}）…',
      'panel.degraded': '部分供应商数据不可用',
      'panel.mixedProviders': '跨供应商累计',
      'panel.byModel': '本会话模型分布',
      'panel.confidence': '价格置信度',
      'panel.confidenceExact': '精确',
      'panel.confidenceFamily': '同系列',
      'panel.confidenceCommunity': '社区目录',
      'panel.confidenceOverride': '手动覆盖',
      'panel.confidenceNone': '未获取',
      'panel.errorHint': '请稍后重试；若持续失败，请检查网络与插件配置。',
      'panel.share': '占比',
      'panel.retryable': '可重试',
    })

    const EN = Object.freeze({
      'dock.balance': 'Balance',
      'dock.session': 'Session',
      'dock.loading': 'loading',
      'dock.unavailable': 'n/a',
      'dock.noPrice': 'no price',
      'dock.openTitle': 'Open balance and usage details',
      'dock.subagentTitle': ' (incl. {count} subagents)',
      'panel.title': 'Balance & Usage',
      'panel.close': 'Close',
      'panel.refresh': 'Refresh',
      'panel.refreshing': 'Refreshing…',
      'panel.providers': 'Providers',
      'panel.summary': 'Usage summary',
      'panel.today': 'Today',
      'panel.last7': 'Last 7 days',
      'panel.last30': 'Last 30 days',
      'panel.last90': 'Last 90 days',
      'panel.tokens': 'tokens',
      'panel.estimated': 'estimated',
      'panel.heatmap': '90-day usage heatmap',
      'panel.none': 'No data',
      'panel.error': 'Failed to load',
      'panel.retry': 'Retry',
      'panel.footer': 'Amounts are estimates computed from runtime-fetched prices, not an official bill; forked session history is excluded.',
      'panel.priceSource': 'Price source',
      'panel.priceUpdated': 'Prices updated',
      'panel.priceStale': 'Price cache is stale',
      'panel.priceMissing': 'No price source found. Add one under priceOverrides in the plugin config.',
      'panel.truncated': 'Only the most recent {count} sessions were scanned.',
      'panel.scanned': '{count} sessions scanned',
      'panel.active': 'in use',
      'panel.noCredential': 'No credential configured',
      'panel.unsupported': 'No balance API',
      'panel.noSubscription': 'No active subscription',
      'panel.reauthRequired': 'Sign-in required',
      'panel.stale': 'Data may be stale',
      'panel.loading': 'Loading…',
      'panel.less': 'Less',
      'panel.more': 'More',
      'panel.amountUnavailable': 'Amount unavailable',
      'panel.statusOk': 'OK',
      'panel.statusError': 'Error',
      'panel.missingAuthorization': 'Authorization required',
      'panel.reset': 'Resets',
      'panel.sessions': 'sessions',
      'panel.balance': 'Balance',
      'panel.usage': 'Usage',
      'panel.sourceOverride': 'Override',
      'panel.sourceProvider': 'Provider catalog',
      'panel.sourceOfficial': 'Official price page',
      'panel.sourceModelsDev': 'models.dev',
      'panel.sourceNone': 'No price source',
      'panel.subagent': 'Subagents in this session: ',
      'panel.subagentLine': '{count} · {amount} ({tokens} tokens)',
      'panel.retrying': 'Could not refresh; retrying ({n}/{m})…',
      'panel.loadingRetry': 'Loading; retrying ({n}/{m})…',
      'panel.degraded': 'Some provider data is unavailable',
      'panel.mixedProviders': 'Mixed providers',
      'panel.byModel': 'Models in this session',
      'panel.confidence': 'Pricing confidence',
      'panel.confidenceExact': 'Exact',
      'panel.confidenceFamily': 'Family match',
      'panel.confidenceCommunity': 'Community',
      'panel.confidenceOverride': 'Override',
      'panel.confidenceNone': 'Unknown',
      'panel.errorHint': 'Try again in a moment; if it keeps failing, check the network and plugin configuration.',
      'panel.share': 'Share',
      'panel.retryable': 'Retryable',
    })

    const DICTS = { zh: ZH, en: EN }
    const FALLBACK_LOCALE_SNAPSHOT = Object.freeze({ active: '', locales: [], revision: 0 })

    const REASON_STATUSES = [
      'missing-credential',
      'missing-authorization',
      'reauth-required',
      'unsupported',
      'no-subscription',
    ]

    const STATUS_KEYS = {
      ok: 'panel.statusOk',
      error: 'panel.statusError',
      'missing-credential': 'panel.noCredential',
      'missing-authorization': 'panel.missingAuthorization',
      'reauth-required': 'panel.reauthRequired',
      unsupported: 'panel.unsupported',
      'no-subscription': 'panel.noSubscription',
    }

    const SOURCE_KEYS = {
      override: 'panel.sourceOverride',
      'provider-catalog': 'panel.sourceProvider',
      'official-page': 'panel.sourceOfficial',
      'models.dev': 'panel.sourceModelsDev',
      none: 'panel.sourceNone',
    }

    // ---------------------------------------------------------------------
    // Small shape-tolerant helpers. Every server payload is treated as
    // untrusted: a missing or malformed field must never throw a render.
    // ---------------------------------------------------------------------
    function arr(value) {
      return Array.isArray(value) ? value : []
    }

    function obj(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function str(value) {
      return typeof value === 'string' ? value : ''
    }

    function toNum(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value.replace(/,/g, ''))
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }

    function firstPositiveNum(values) {
      for (const value of values) {
        const parsed = toNum(value)
        if (parsed !== null && parsed > 0) return parsed
      }
      return null
    }

    function clampPercent(value) {
      const parsed = toNum(value)
      if (parsed === null) return null
      return Math.max(0, Math.min(100, parsed))
    }

    function isAbort(error) {
      return !!error && (error.name === 'AbortError' || error.aborted === true)
    }

    function errorMessage(error) {
      if (!error) return 'request failed'
      if (typeof error.message === 'string' && error.message) return error.message
      return String(error)
    }

    function browserLocale() {
      try {
        if (typeof navigator === 'undefined') return 'en'
        if (Array.isArray(navigator.languages)) {
          for (const candidate of navigator.languages) {
            if (typeof candidate === 'string' && candidate) return candidate
          }
        }
        if (typeof navigator.language === 'string' && navigator.language) return navigator.language
      } catch {
        // navigator can be restricted in exotic embeddings
      }
      return 'en'
    }

    function pickDict(active) {
      return /^zh/i.test(active) ? ZH : EN
    }

    function tr(dict, key, params) {
      let text = dict && typeof dict[key] === 'string' ? dict[key] : EN[key] !== undefined ? EN[key] : key
      if (params && typeof text === 'string') {
        text = text.replace(/\{(\w+)\}/g, (match, name) =>
          Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
        )
      }
      return text
    }

    function formatInt(value, localeId) {
      const parsed = toNum(value)
      if (parsed === null) return '—'
      try {
        return new Intl.NumberFormat(localeId || 'en', { maximumFractionDigits: 0 }).format(parsed)
      } catch {
        return String(Math.round(parsed))
      }
    }

    function formatTokens(value, localeId) {
      const parsed = toNum(value)
      if (parsed === null) return '—'
      const abs = Math.abs(parsed)
      try {
        if (abs >= 1000) {
          return new Intl.NumberFormat(localeId || 'en', {
            notation: 'compact',
            maximumFractionDigits: 1,
          }).format(parsed)
        }
        return new Intl.NumberFormat(localeId || 'en', { maximumFractionDigits: 0 }).format(parsed)
      } catch {
        if (abs >= 1e9) return Math.round((parsed / 1e9) * 10) / 10 + 'B'
        if (abs >= 1e6) return Math.round((parsed / 1e6) * 10) / 10 + 'M'
        if (abs >= 1e3) return Math.round((parsed / 1e3) * 10) / 10 + 'K'
        return String(Math.round(parsed))
      }
    }

    function currencyPrefix(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      if (typeof currency === 'string' && currency) return currency
      return ''
    }

    function formatMoney(amount, currency) {
      const parsed = toNum(amount)
      if (parsed === null) return '—'
      const text = parsed.toFixed(2)
      const prefix = currencyPrefix(currency)
      if (prefix === '¥' || prefix === '$') return prefix + text
      if (prefix) return prefix + ' ' + text
      return text
    }

    function formatCostNumber(value) {
      const parsed = toNum(value)
      if (parsed === null) return null
      if (parsed === 0) return '0.00'
      if (Math.abs(parsed) >= 1) return parsed.toFixed(2)
      let text = parsed.toFixed(4)
      text = text.replace(/0+$/, '')
      const dot = text.indexOf('.')
      if (dot >= 0 && text.length - dot - 1 < 2) text = text.padEnd(dot + 3, '0')
      return text
    }

    function formatSessionCost(value, currency) {
      const text = formatCostNumber(value)
      if (text === null) return null
      const prefix = currencyPrefix(currency)
      if (prefix === '¥' || prefix === '$') return prefix + text
      if (prefix) return prefix + ' ' + text
      return text
    }

    // Subagent rollups keep more precision than balances (4 decimals under 100).
    function formatSubagentMoney(value, currency) {
      const parsed = toNum(value)
      if (parsed === null) return null
      let text
      if (Math.abs(parsed) > 0 && Math.abs(parsed) < 100) {
        text = parsed.toFixed(4).replace(/0+$/, '')
        const dot = text.indexOf('.')
        if (dot >= 0 && text.length - dot - 1 < 2) text = text.padEnd(dot + 3, '0')
      } else {
        text = parsed.toFixed(2)
      }
      const prefix = currencyPrefix(currency)
      if (prefix === '¥' || prefix === '$') return prefix + text
      if (prefix) return prefix + ' ' + text
      return text
    }

    // Sum the four disjoint token buckets of a usage payload; null when absent.
    function sumTokenFields(tokens) {
      const direct = toNum(tokens)
      if (direct !== null) return direct
      const source = obj(tokens)
      let total = 0
      let found = false
      for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) {
        const value = toNum(source[key])
        if (value !== null) {
          total += value
          found = true
        }
      }
      return found ? total : null
    }

    function relativeTime(targetMs, localeId) {
      const diff = targetMs - Date.now()
      const abs = Math.abs(diff)
      let unit = 'second'
      let value = Math.round(diff / 1000)
      if (abs >= 86400000) {
        unit = 'day'
        value = Math.round(diff / 86400000)
      } else if (abs >= 3600000) {
        unit = 'hour'
        value = Math.round(diff / 3600000)
      } else if (abs >= 60000) {
        unit = 'minute'
        value = Math.round(diff / 60000)
      }
      try {
        return new Intl.RelativeTimeFormat(localeId || 'en', { numeric: 'auto' }).format(value, unit)
      } catch {
        return value + ' ' + unit
      }
    }

    function toMillis(value) {
      const parsed = toNum(value)
      if (parsed === null || parsed <= 0) return null
      return parsed < 1e12 ? parsed * 1000 : parsed
    }

    function formatWhen(value, localeId) {
      const millis = toMillis(value)
      if (millis === null) return '—'
      const diff = Date.now() - millis
      if (diff >= 0 && diff < 7 * 86400000) return relativeTime(millis, localeId)
      try {
        return new Intl.DateTimeFormat(localeId || 'en', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(millis))
      } catch {
        return new Date(millis).toLocaleString()
      }
    }

    function formatReset(value, localeId) {
      const millis = toMillis(value)
      if (millis === null) return null
      if (millis - Date.now() <= 0) return null
      return relativeTime(millis, localeId)
    }

    function statusLabel(dict, status) {
      const key = STATUS_KEYS[status]
      return key ? tr(dict, key) : status
    }

    function statusTone(status) {
      if (status === 'ok') return 'ok'
      if (status === 'error') return 'error'
      if (status === 'unsupported' || status === 'no-subscription') return 'idle'
      return 'warn'
    }

    function sourceLabel(dict, source) {
      if (!source) return tr(dict, 'panel.sourceNone')
      const key = SOURCE_KEYS[source]
      return key ? tr(dict, key) : String(source)
    }

    function fallbackCurrencyFromSource(source) {
      if (source === 'official-page') return 'CNY'
      if (source === 'models.dev') return 'USD'
      return ''
    }

    function isActiveProvider(provider, activeId) {
      if (!provider || typeof provider !== 'object') return false
      if (provider.active === true) return true
      return !!(activeId && provider.id === activeId)
    }

    function shortProviderName(provider) {
      if (!provider || typeof provider !== 'object') return ''
      const displayName = str(provider.displayName)
      if (displayName) return displayName
      return str(provider.id)
    }

    function firstBalance(provider) {
      const balances = arr(provider && provider.balances).filter(
        (entry) => entry && typeof entry === 'object',
      )
      if (balances.length === 0) return null
      return balances[0]
    }

    // Amount payloads are allowed to arrive as one number or as several
    // currencies. Currencies are always rendered separately and never summed.
    function entryAmounts(entry, fallbackCurrency) {
      if (!entry || typeof entry !== 'object') return []
      const output = []
      if (Array.isArray(entry.costs)) {
        for (const cost of entry.costs) {
          if (!cost || typeof cost !== 'object') continue
          if (toNum(cost.amount) !== null) {
            output.push({ amount: cost.amount, currency: str(cost.currency) || fallbackCurrency || '' })
          }
        }
        if (output.length > 0) return output
      }
      const costMap = entry.costs && typeof entry.costs === 'object' && !Array.isArray(entry.costs) ? entry.costs : null
      const byCurrency = entry.byCurrency && typeof entry.byCurrency === 'object' ? entry.byCurrency : null
      const map = costMap || byCurrency
      if (map) {
        for (const key of Object.keys(map)) {
          if (toNum(map[key]) !== null) output.push({ amount: map[key], currency: key })
        }
        if (output.length > 0) return output
      }
      if (toNum(entry.cost) !== null) {
        output.push({
          amount: entry.cost,
          currency: str(entry.currency) || fallbackCurrency || '',
        })
      }
      return output
    }

    // ---------------------------------------------------------------------
    // Module-level state shared by the dock trigger and the overlay panel.
    // ---------------------------------------------------------------------
    const localeRef = { current: null }

    function createOpenStore() {
      let snapshot = Object.freeze({ open: false, trigger: null })
      const listeners = new Set()
      function setOpen(nextOpen, trigger) {
        const next = Object.freeze({
          open: !!nextOpen,
          trigger: nextOpen ? trigger || snapshot.trigger || null : null,
        })
        if (next.open === snapshot.open && next.trigger === snapshot.trigger) return
        snapshot = next
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            try {
              console.error('[balance-usage] store listener failed', error)
            } catch {
              // nothing else to do
            }
          }
        }
      }
      return {
        getSnapshot() {
          return snapshot
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        setOpen,
        close() {
          setOpen(false, null)
        },
      }
    }

    const openStore = createOpenStore()

    // ---------------------------------------------------------------------
    // Locale adapter: prefers the Client locale service, falls back to the
    // browser language and the bundled dictionaries.
    // ---------------------------------------------------------------------
    function useLocale() {
      const locale = localeRef.current
      const subscribe = useCallback(
        (callback) => {
          if (locale && typeof locale.subscribe === 'function') {
            try {
              const dispose = locale.subscribe(callback)
              return typeof dispose === 'function' ? dispose : () => {}
            } catch {
              return () => {}
            }
          }
          return () => {}
        },
        [locale],
      )
      const getSnapshot = useCallback(() => {
        if (locale && typeof locale.getSnapshot === 'function') {
          try {
            const snapshot = locale.getSnapshot()
            if (snapshot && typeof snapshot === 'object') return snapshot
          } catch {
            // fall through to the bundled dictionaries
          }
        }
        return FALLBACK_LOCALE_SNAPSHOT
      }, [locale])
      const snapshot = useSyncExternalStore(subscribe, getSnapshot)
      const active =
        snapshot && typeof snapshot.active === 'string' && snapshot.active
          ? snapshot.active
          : browserLocale()
      return { active, dict: pickDict(active) }
    }

    // ---------------------------------------------------------------------
    // HTTP access. Same-origin only; GET only; no credentials handling.
    // Retries, jittered delays, and the request deadline live here; callers
    // only see a typed ApiError.
    // ---------------------------------------------------------------------
    function clampNumber(value, fallback, min, max) {
      const parsed = toNum(value)
      if (parsed === null) return fallback
      const clamped = Math.min(max, Math.max(min, parsed))
      return Math.round(clamped)
    }

    function clientConfig() {
      const entry = dataStore.snapshot('config')
      const source = entry.data && typeof entry.data === 'object' ? entry.data : {}
      const refresh = source.refresh && typeof source.refresh === 'object' ? source.refresh : {}
      const retry = source.retry && typeof source.retry === 'object' ? source.retry : {}
      return {
        refresh: {
          overviewSec: clampNumber(refresh.overviewSec, 60, 1, 86400),
          sessionRunningSec: clampNumber(refresh.sessionRunningSec, 3, 1, 3600),
          sessionIdleSec: clampNumber(refresh.sessionIdleSec, 15, 1, 86400),
          statsSec: clampNumber(refresh.statsSec, 60, 1, 86400),
        },
        retry: {
          maxRetries: clampNumber(retry.maxRetries, 2, 0, 5),
          requestTimeoutMs: clampNumber(retry.requestTimeoutMs, 20000, 1000, 120000),
        },
        heatmapDays: clampNumber(source.heatmapDays, 90, 1, 365),
      }
    }

    function apiError(code, message, retryable, status, aborted) {
      let error
      try {
        error = new Error(str(message) || str(code) || 'request failed')
      } catch {
        error = { message: str(message) }
      }
      error.code = str(code) || 'error'
      error.retryable = retryable === true
      error.status = Number.isFinite(status) ? status : 0
      error.aborted = aborted === true
      return error
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    async function fetchOnce(kind, params, callerSignal) {
      if (callerSignal && callerSignal.aborted) throw apiError('aborted', '', false, 0, true)
      const query = new URLSearchParams()
      query.set('kind', kind)
      if (params && typeof params === 'object') {
        for (const key of Object.keys(params)) {
          if (params[key] === undefined || params[key] === null) continue
          query.set(key, String(params[key]))
        }
      }
      const timeoutMs = clientConfig().retry.requestTimeoutMs
      const controller = new AbortController()
      let timedOut = false
      const onCallerAbort = () => {
        try {
          controller.abort()
        } catch {
          // already aborted
        }
      }
      if (callerSignal) callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        try {
          controller.abort()
        } catch {
          // already aborted
        }
      }, timeoutMs)
      try {
        let response
        try {
          response = await fetch(API_PATH + '?' + query.toString(), {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
          })
        } catch (networkError) {
          if (timedOut) throw apiError('timeout', '', true, 0, false)
          if (callerSignal && callerSignal.aborted) throw apiError('aborted', '', false, 0, true)
          if (isAbort(networkError)) throw apiError('aborted', '', false, 0, true)
          throw apiError('network', '', true, 0, false)
        }
        const status = response && Number.isFinite(response.status) ? response.status : 0
        if (!response || response.ok !== true) {
          let failure = {}
          try {
            const body = await response.json()
            if (body && body.error && typeof body.error === 'object') failure = body.error
          } catch {
            failure = {}
          }
          const retryByStatus = status === 408 || status === 425 || status === 429 || status >= 500
          const otherClientError =
            status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429
          throw apiError(
            str(failure.code) || 'http-' + String(status || 'error'),
            str(failure.message),
            otherClientError ? false : retryByStatus || failure.retryable === true,
            status,
            false,
          )
        }
        let body
        try {
          body = await response.json()
        } catch {
          throw apiError('invalid-json', '', true, status, false)
        }
        if (!body || body.ok !== true) {
          const failure = body && body.error && typeof body.error === 'object' ? body.error : {}
          const otherClientError =
            status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429
          const retryable =
            !otherClientError &&
            (failure.retryable === true || failure.code === 'unavailable' || failure.code === 'internal')
          throw apiError(
            str(failure.code) || 'request-failed',
            str(failure.message),
            retryable,
            status,
            false,
          )
        }
        return body.data === undefined ? null : body.data
      } catch (error) {
        if (timedOut) throw apiError('timeout', '', true, 0, false)
        if (callerSignal && callerSignal.aborted) throw apiError('aborted', '', false, 0, true)
        if (error && typeof error.code === 'string') throw error
        if (isAbort(error)) throw apiError('aborted', '', false, 0, true)
        throw apiError('network', '', true, 0, false)
      } finally {
        clearTimeout(timer)
        if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort)
      }
    }

    async function fetchKind(kind, params, callerSignal) {
      const maxRetries = clientConfig().retry.maxRetries
      let attempt = 0
      while (true) {
        try {
          return await fetchOnce(kind, params, callerSignal)
        } catch (error) {
          const aborted = !!(error && error.aborted)
          const retryable = !!(error && error.retryable)
          if (aborted || !retryable || attempt >= maxRetries) throw error
          const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
          const jitter = 0.8 + Math.random() * 0.4
          await sleep(Math.round(base * jitter))
          if (callerSignal && callerSignal.aborted) throw apiError('aborted', '', false, 0, true)
          attempt += 1
        }
      }
    }

    // ---------------------------------------------------------------------
    // Shared in-memory data store + one scheduler. No persistence; keys are
    // config | overview | session:<id> | stats | pricing | selection.
    // ---------------------------------------------------------------------
    const EMPTY_ENTRY = Object.freeze({
      key: null,
      data: null,
      at: 0,
      inflight: false,
      error: null,
      retryable: null,
      retrying: false,
      backoff: 0,
      failures: 0,
      nextAt: 0,
    })

    function createDataStore() {
      const entries = new Map()
      const listeners = new Map()
      const counts = new Map()
      let total = 0

      function snapshot(key) {
        if (!key) return EMPTY_ENTRY
        let entry = entries.get(key)
        if (!entry) {
          entry = { ...EMPTY_ENTRY, key }
          entries.set(key, entry)
        }
        return entry
      }

      function update(key, patch) {
        if (!key) return
        const entry = snapshot(key)
        const next = { ...entry, ...patch, key }
        entries.set(key, next)
        const set = listeners.get(key)
        if (!set) return
        for (const listener of Array.from(set)) {
          try {
            listener()
          } catch (error) {
            try {
              console.warn('[balance-usage] data listener failed', error)
            } catch {
              // logging is best effort
            }
          }
        }
      }

      function subscribe(key, listener) {
        if (!key) return () => {}
        let set = listeners.get(key)
        if (!set) {
          set = new Set()
          listeners.set(key, set)
        }
        set.add(listener)
        counts.set(key, (counts.get(key) || 0) + 1)
        const wasIdle = total === 0
        total += 1
        if (wasIdle) scheduler.onFirstSubscriber()
        let active = true
        return () => {
          if (!active) return
          active = false
          const owner = listeners.get(key)
          if (!owner || !owner.delete(listener)) return
          if (owner.size === 0) listeners.delete(key)
          counts.set(key, Math.max(0, (counts.get(key) || 0) - 1))
          total = Math.max(0, total - 1)
          if (total === 0) scheduler.onLastSubscriber()
        }
      }

      function subscribedKeys() {
        const keys = []
        for (const [key, count] of counts) if (count > 0) keys.push(key)
        return keys
      }

      return {
        snapshot,
        update,
        subscribe,
        subscribedKeys,
        subscriberCount() {
          return total
        },
      }
    }

    const dataStore = createDataStore()

    // The overlay panel is root-scoped while session data is session-scoped:
    // the dock publishes its current Session id here for the panel to read.
    const activeSessionRef = { id: null }
    const services = { modelDirectories: null }
    const activityState = { sessionId: null, running: false }
    const selectionState = { sessionId: null, dispose: null }

    function specFor(key) {
      if (key === 'config') return { kind: 'config', params: () => ({}) }
      if (key === 'overview') return { kind: 'overview', params: () => ({}) }
      if (key === 'stats') {
        return {
          kind: 'stats',
          params: (options) => (options && options.refresh === true ? { refresh: '1' } : {}),
        }
      }
      if (key === 'pricing') return { kind: 'pricing', params: () => ({}) }
      if (typeof key === 'string' && key.indexOf('session:') === 0) {
        const sessionId = key.slice(8)
        if (!sessionId) return null
        return { kind: 'session', params: () => ({ session: sessionId }) }
      }
      return null
    }

    function ttlFor(key) {
      const config = clientConfig()
      if (key === 'config') return CONFIG_TTL_MS
      if (key === 'overview') return config.refresh.overviewSec * 1000
      if (key === 'stats') return config.refresh.statsSec * 1000
      if (key === 'pricing') return PRICING_TTL_MS
      if (typeof key === 'string' && key.indexOf('session:') === 0) {
        const sessionId = key.slice(8)
        const running = activityState.sessionId === sessionId && activityState.running === true
        const seconds = running ? config.refresh.sessionRunningSec : config.refresh.sessionIdleSec
        return seconds * 1000
      }
      return 0
    }

    const scheduler = (() => {
      let timer = null
      let disposed = false
      let bound = false
      const pending = new Map()
      const controllers = new Set()

      function isDue(key, now) {
        const entry = dataStore.snapshot(key)
        if (entry.inflight) return false
        if (entry.nextAt && now < entry.nextAt) return false
        const ttl = ttlFor(key)
        if (entry.data !== null && ttl > 0 && now - entry.at < ttl) return false
        return true
      }

      function ensure(key, options) {
        const spec = specFor(key)
        if (!spec) return null
        if (pending.has(key)) return pending.get(key)
        const controller = new AbortController()
        controllers.add(controller)
        const entry = dataStore.snapshot(key)
        dataStore.update(key, {
          inflight: true,
          retrying: !!(entry.error || entry.failures > 0),
        })
        const promise = fetchKind(spec.kind, spec.params(options), controller.signal).then(
          (data) => {
            controllers.delete(controller)
            dataStore.update(key, {
              data: data && typeof data === 'object' ? data : {},
              at: Date.now(),
              inflight: false,
              error: null,
              retryable: null,
              retrying: false,
              backoff: 0,
              failures: 0,
              nextAt: 0,
            })
          },
          (error) => {
            controllers.delete(controller)
            if (disposed && error && error.aborted) return
            const current = dataStore.snapshot(key)
            const failures = (current.failures || 0) + 1
            const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, failures - 1))
            dataStore.update(key, {
              inflight: false,
              retrying: false,
              error: {
                code: str(error && error.code) || 'error',
                message: str(error && error.message),
                retryable: !(error && error.retryable === false),
              },
              retryable: !(error && error.retryable === false),
              failures,
              backoff,
              nextAt: Date.now() + backoff,
            })
          },
        )
        pending.set(key, promise)
        promise.then(() => {
          if (pending.get(key) === promise) pending.delete(key)
        })
        return promise
      }

      function ensureConfig(now) {
        const entry = dataStore.snapshot('config')
        if (entry.inflight) return
        if (entry.nextAt && now < entry.nextAt) return
        if (entry.data !== null && now - entry.at < CONFIG_TTL_MS) return
        ensure('config')
      }

      function tick() {
        if (disposed) return
        try {
          if (typeof document !== 'undefined' && document.hidden) return
          if (dataStore.subscriberCount() === 0) return
          const now = Date.now()
          ensureConfig(now)
          for (const key of dataStore.subscribedKeys()) {
            if (key === 'selection' || key === 'config') continue
            if (!isDue(key, now)) continue
            ensure(key)
          }
        } catch (error) {
          try {
            console.warn('[balance-usage] scheduler tick failed', error)
          } catch {
            // logging is best effort
          }
        }
      }

      function revalidateAll() {
        if (disposed) return
        for (const key of dataStore.subscribedKeys()) {
          if (key === 'selection') continue
          dataStore.update(key, { nextAt: 0 })
        }
        tick()
      }

      function onFocus() {
        revalidateAll()
      }

      function onVisibility() {
        try {
          if (typeof document !== 'undefined' && document.hidden) return
        } catch {
          return
        }
        revalidateAll()
      }

      function bind() {
        if (bound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
        bound = true
        try {
          window.addEventListener('focus', onFocus)
        } catch {
          // no window listeners in this embedding
        }
        try {
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibility)
          }
        } catch {
          // no document listeners in this embedding
        }
      }

      function unbind() {
        if (!bound) return
        bound = false
        try {
          window.removeEventListener('focus', onFocus)
        } catch {
          // ignore
        }
        try {
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        } catch {
          // ignore
        }
      }

      function start() {
        if (disposed || timer !== null) return
        bind()
        timer = setInterval(tick, SCHEDULER_TICK_MS)
        // Defer the first pass: the store may be notifying inside subscribe().
        try {
          if (typeof queueMicrotask === 'function') queueMicrotask(tick)
          else setTimeout(tick, 0)
        } catch {
          tick()
        }
      }

      function stop() {
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
        unbind()
      }

      return {
        tick,
        ensure,
        requestNow(key, options) {
          dataStore.update(key, { nextAt: 0 })
          return ensure(key, options)
        },
        markDue(key) {
          dataStore.update(key, { nextAt: 0 })
        },
        revalidateAll,
        onFirstSubscriber() {
          start()
        },
        onLastSubscriber() {
          stop()
        },
        dispose() {
          disposed = true
          stop()
          for (const controller of Array.from(controllers)) {
            try {
              controller.abort()
            } catch {
              // already aborted
            }
          }
          controllers.clear()
          pending.clear()
        },
      }
    })()

    function useEntry(key) {
      const subscribe = useCallback((listener) => dataStore.subscribe(key, listener), [key])
      const getSnapshot = useCallback(() => dataStore.snapshot(key), [key])
      return useSyncExternalStore(subscribe, getSnapshot)
    }

    // ---------------------------------------------------------------------
    // Model-selection following: the directory snapshot's pending ?? current
    // selection changes the balance target instantly, without resetting the
    // server-side cumulative session cost.
    // ---------------------------------------------------------------------
    function resolveService(scope, name) {
      try {
        if (scope && typeof scope.get === 'function') {
          const found = scope.get(name)
          if (found) return found
        }
      } catch {
        // service access can throw without inject
      }
      try {
        return scope && scope[name] ? scope[name] : null
      } catch {
        return null
      }
    }

    function selectionData() {
      const data = dataStore.snapshot('selection').data
      return data && typeof data === 'object' ? data : {}
    }

    function publishSelection(provider, model, sessionId) {
      const previous = selectionData()
      const next = {
        provider: provider || null,
        model: model || null,
        sessionId: sessionId || null,
      }
      if (
        (previous.provider || null) === next.provider &&
        (previous.model || null) === next.model &&
        (previous.sessionId || null) === next.sessionId
      ) {
        return
      }
      dataStore.update('selection', { data: next, at: Date.now() })
      if ((previous.provider || null) !== next.provider && next.sessionId) {
        // Soft refresh: stale payloads stay on screen until the new ones land.
        scheduler.markDue('overview')
        scheduler.markDue('session:' + next.sessionId)
        scheduler.tick()
      }
    }

    function disposeSelectionSubscription() {
      if (!selectionState.dispose) return
      try {
        selectionState.dispose()
      } catch {
        // owner already disposed
      }
      selectionState.dispose = null
    }

    function syncSelection() {
      const sessionId = selectionState.sessionId
      disposeSelectionSubscription()
      if (!sessionId) {
        const previous = selectionData()
        if (previous.sessionId || previous.provider) {
          dataStore.update('selection', { data: { provider: null, model: null, sessionId: null } })
        }
        return
      }
      const service = services.modelDirectories
      let directoryStore = null
      if (service && typeof service.directoryFor === 'function') {
        try {
          const directory = service.directoryFor(sessionId)
          directoryStore = directory && directory.store ? directory.store : null
        } catch {
          directoryStore = null
        }
      }
      if (
        !directoryStore ||
        typeof directoryStore.getSnapshot !== 'function' ||
        typeof directoryStore.subscribe !== 'function'
      ) {
        publishSelection(null, null, sessionId)
        return
      }
      const read = () => {
        try {
          const snapshot = directoryStore.getSnapshot()
          const pending = snapshot && snapshot.pending ? snapshot.pending : null
          const current = snapshot && snapshot.current ? snapshot.current : null
          const chosen = pending && pending.provider && pending.model ? pending : current
          publishSelection(
            chosen && typeof chosen.provider === 'string' ? chosen.provider : null,
            chosen && typeof chosen.model === 'string' ? chosen.model : null,
            sessionId,
          )
        } catch {
          publishSelection(null, null, sessionId)
        }
      }
      read()
      try {
        const dispose = directoryStore.subscribe(read)
        if (typeof dispose === 'function') selectionState.dispose = dispose
      } catch {
        selectionState.dispose = null
      }
    }

    function useOptionalRunning(props, sessionId) {
      const hasHookRef = useRef(typeof props.useSessionStatus === 'function')
      const hook = hasHookRef.current ? props.useSessionStatus : null
      const selector = useCallback(
        (snapshot) => {
          try {
            if (!sessionId || !snapshot || typeof snapshot.get !== 'function') return undefined
            const entry = snapshot.get(sessionId)
            if (!entry || typeof entry !== 'object') return undefined
            if (entry.running === true) return true
            if (entry.running === false) return false
            return undefined
          } catch {
            return undefined
          }
        },
        [sessionId],
      )
      if (hook) return hook(selector)
      return undefined
    }

    // ---------------------------------------------------------------------
    // Dock cell (compact, inline, sibling of the activity/usage pills).
    // ---------------------------------------------------------------------
    function WalletIcon() {
      return h(
        'svg',
        {
          className: 'dshbu-dock-icon',
          viewBox: '0 0 16 16',
          width: 13,
          height: 13,
          fill: 'none',
          'aria-hidden': true,
        },
        h('rect', {
          x: 1.6,
          y: 3.4,
          width: 12.8,
          height: 9.4,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('path', { d: 'M9.4 6.4h5', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 11.1, cy: 8.1, r: 1.2, fill: 'currentColor' }),
      )
    }

    function sessionCumulativeText(session) {
      if (!session || typeof session !== 'object') return null
      if (session.priced === false || str(session.priceSource) === 'none') return null
      const amounts = entryAmounts(session, str(session.currency))
      const parts = []
      for (const amount of amounts) {
        const text = formatSessionCost(amount.amount, amount.currency)
        if (text) parts.push(text)
      }
      if (parts.length > 0) return parts.join(' · ')
      return formatSessionCost(session.cost, session.currency)
    }

    function DockCell(props) {
      const { active: localeId, dict } = useLocale()
      const sessionId = typeof props.sessionId === 'string' && props.sessionId ? props.sessionId : null
      const running = useOptionalRunning(props, sessionId)
      const sessionKey = sessionId ? 'session:' + sessionId : null
      const overviewEntry = useEntry('overview')
      const sessionEntry = useEntry(sessionKey)
      const selectionEntry = useEntry('selection')
      const openSnapshot = useSyncExternalStore(openStore.subscribe, openStore.getSnapshot)
      const previousRunningRef = useRef(null)

      // Follow the model-selection directory for this Session; a switch changes
      // the balance target immediately while the server cost stays cumulative.
      useEffect(() => {
        activeSessionRef.id = sessionId
        selectionState.sessionId = sessionId
        syncSelection()
        return () => {
          if (activeSessionRef.id === sessionId) activeSessionRef.id = null
          if (selectionState.sessionId === sessionId) {
            selectionState.sessionId = null
            syncSelection()
          }
        }
      }, [sessionId])

      useEffect(() => {
        activityState.sessionId = sessionId
        activityState.running = running === true
        const previous = previousRunningRef.current
        previousRunningRef.current = sessionId ? { sessionId, running: running === true } : null
        if (sessionKey && previous && previous.sessionId === sessionId && previous.running && running === false) {
          scheduler.markDue(sessionKey)
          scheduler.tick()
        }
        return () => {
          if (activityState.sessionId === sessionId) {
            activityState.sessionId = null
            activityState.running = false
          }
        }
      }, [sessionId, running, sessionKey])

      const overview = overviewEntry.data
      const rawSession = sessionEntry.data
      const session =
        rawSession &&
        (!str(rawSession.sessionId) || str(rawSession.sessionId) === sessionId)
          ? rawSession
          : null
      const selection =
        selectionEntry.data && typeof selectionEntry.data === 'object' ? selectionEntry.data : {}
      const providers = arr(overview && overview.providers).filter(
        (provider) => provider && typeof provider === 'object',
      )
      const selectionProviderId = str(selection.provider)
      const fallbackProviderId = str(session && session.provider) || str(overview && overview.active)
      const targetId = selectionProviderId || fallbackProviderId
      const targetProvider = targetId
        ? providers.find((provider) => provider && provider.id === targetId) || null
        : null
      const targetStatus = targetProvider ? str(targetProvider.status) : ''
      const balance = targetProvider ? firstBalance(targetProvider) : null
      const targetName = targetProvider ? shortProviderName(targetProvider) : targetId
      const overviewInitialLoad = !overview && (overviewEntry.inflight || !overviewEntry.error)

      let balanceText
      if (overviewInitialLoad) {
        balanceText = tr(dict, 'dock.balance') + ' …'
      } else if (!targetId) {
        balanceText = tr(dict, 'dock.balance') + ' —'
      } else if (
        !targetProvider ||
        !balance ||
        toNum(balance.total) === null ||
        (targetStatus && targetStatus !== 'ok')
      ) {
        balanceText = targetName + ' ' + tr(dict, 'dock.balance') + ' —'
      } else {
        balanceText = targetName + ' ' + formatMoney(balance.total, balance.currency)
      }

      const sessionInitialLoad =
        !!sessionId && !session && (sessionEntry.inflight || !sessionEntry.error)
      const costText = sessionCumulativeText(session)
      let sessionText
      if (!sessionId) {
        sessionText = tr(dict, 'dock.session') + ' —'
      } else if (sessionInitialLoad) {
        sessionText = tr(dict, 'dock.session') + ' …'
      } else if (!costText) {
        sessionText = tr(dict, 'dock.session') + ' ≈ —'
      } else {
        sessionText = tr(dict, 'dock.session') + ' ' + costText
      }

      const problem = !!(overviewEntry.error || sessionEntry.error)
      const problemTitle = tr(dict, 'panel.error')

      // Subagent children are already folded into sessionText; the title only
      // discloses their count, so the compact pill never grows a second row.
      const subagent = obj(session && session.subagent)
      const subagentCount = subagent.unavailable === true ? null : toNum(subagent.sessions)
      const buttonTitle =
        subagentCount !== null && subagentCount > 0
          ? sessionText + tr(dict, 'dock.subagentTitle', { count: formatInt(subagentCount, localeId) })
          : tr(dict, 'dock.openTitle')

      return h(
        'span',
        { className: 'dshbu-dock-anchor' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshbu-dock-btn',
            title: buttonTitle,
            'aria-label': subagentCount !== null && subagentCount > 0 ? buttonTitle : undefined,
            'aria-haspopup': 'dialog',
            'aria-expanded': openSnapshot.open ? 'true' : 'false',
            onClick: (event) => {
              openStore.setOpen(true, event.currentTarget)
            },
          },
          h(
            'span',
            { className: 'dshbu-dock-seg' },
            h(WalletIcon),
            h('span', { className: 'dshbu-dock-txt' }, balanceText),
          ),
          h('span', { className: 'dshbu-sep', 'aria-hidden': true }, '·'),
          h('span', { className: 'dshbu-dock-seg' }, h('span', { className: 'dshbu-dock-txt' }, sessionText)),
          problem
            ? h('span', {
                className: 'dshbu-err-dot',
                role: 'img',
                'aria-label': problemTitle,
                title: problemTitle,
              })
            : null,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Panel sections. These are plain render helpers (no hooks) so the data
    // panel keeps one stable hook order.
    // ---------------------------------------------------------------------
    function renderUsageRow(dict, usage, index, localeId) {
      const percent = clampPercent(usage.percent)
      const reset = formatReset(usage.resetAt, localeId)
      return h(
        'div',
        { className: 'dshbu-usage', key: 'usage-' + index },
        h(
          'div',
          { className: 'dshbu-usage-head' },
          h('span', { className: 'dshbu-usage-label' }, str(usage.label) || tr(dict, 'panel.usage')),
          h('span', { className: 'dshbu-usage-percent' }, percent === null ? '—' : Math.round(percent) + '%'),
        ),
        h(
          'div',
          { className: 'dshbu-bar' },
          h('div', {
            className: 'dshbu-bar-fill',
            style: { width: (percent === null ? 0 : percent) + '%' },
          }),
        ),
        reset ? h('div', { className: 'dshbu-muted dshbu-usage-reset' }, tr(dict, 'panel.reset') + ' ' + reset) : null,
      )
    }

    function ProviderRow({ dict, provider, activeId, localeId }) {
      const active = isActiveProvider(provider, activeId)
      const status = str(provider.status)
      const balances = arr(provider.balances).filter((entry) => entry && typeof entry === 'object')
      const usages = arr(provider.usages).filter((entry) => entry && typeof entry === 'object')
      const spend = provider.spend && typeof provider.spend === 'object' ? provider.spend : null
      const message = str(provider.message)
      const reason =
        REASON_STATUSES.indexOf(status) !== -1 || (status === 'error' && message !== '')

      return h(
        'div',
        { className: 'dshbu-provider', 'data-active': active ? 'true' : undefined },
        h(
          'div',
          { className: 'dshbu-provider-head' },
          h('span', { className: 'dshbu-provider-name' }, shortProviderName(provider) || '—'),
          active ? h('span', { className: 'dshbu-badge dshbu-badge--active' }, tr(dict, 'panel.active')) : null,
          status
            ? h(
                'span',
                { className: 'dshbu-badge dshbu-badge--' + statusTone(status), title: message || undefined },
                statusLabel(dict, status),
              )
            : null,
          provider.stale
            ? h('span', { className: 'dshbu-chip dshbu-chip--warn' }, tr(dict, 'panel.stale'))
            : null,
          provider.retryable === true
            ? h('span', { className: 'dshbu-chip dshbu-chip--muted' }, tr(dict, 'panel.retryable'))
            : null,
        ),
        balances.map((entry, index) =>
          h(
            'div',
            { className: 'dshbu-line', key: 'balance-' + index },
            h('span', { className: 'dshbu-line-label' }, tr(dict, 'panel.balance')),
            h('span', { className: 'dshbu-line-value' }, formatMoney(entry.total, entry.currency)),
          ),
        ),
        usages.map((usage, index) => renderUsageRow(dict, usage, index, localeId)),
        spend
          ? h(
              'div',
              { className: 'dshbu-line' },
              h('span', { className: 'dshbu-line-label' }, str(spend.label) || tr(dict, 'panel.estimated')),
              h(
                'span',
                { className: 'dshbu-line-value' },
                formatMoney(spend.amount, spend.currency),
                spend.source
                  ? h('span', { className: 'dshbu-muted' }, ' · ' + str(spend.source))
                  : null,
              ),
            )
          : null,
        reason
          ? h(
              'div',
              { className: 'dshbu-muted dshbu-reason' },
              message ? statusLabel(dict, status) + ' · ' + message : statusLabel(dict, status),
            )
          : null,
      )
    }

    function ProvidersSection({ dict, providers, activeId, localeId, degraded }) {
      const ordered = providers
        .map((provider, index) => ({ provider, index }))
        .sort((left, right) => {
          const leftActive = isActiveProvider(left.provider, activeId) ? 1 : 0
          const rightActive = isActiveProvider(right.provider, activeId) ? 1 : 0
          return rightActive - leftActive || left.index - right.index
        })
      return h(
        'section',
        { className: 'dshbu-section' },
        h(
          'div',
          { className: 'dshbu-section-head' },
          h('h3', { className: 'dshbu-section-title' }, tr(dict, 'panel.providers')),
          degraded
            ? h('span', { className: 'dshbu-chip dshbu-chip--warn' }, tr(dict, 'panel.degraded'))
            : null,
        ),
        ordered.map((entry) =>
          h(ProviderRow, {
            key: 'provider-' + (str(entry.provider.id) || entry.index),
            dict,
            provider: entry.provider,
            activeId,
            localeId,
          }),
        ),
      )
    }

    function SummaryCell({ dict, labelKey, entry, priceSource, priced, localeId }) {
      const totals = entry && typeof entry === 'object' ? entry : {}
      const tokens = toNum(totals.tokens)
      const fallbackCurrency = fallbackCurrencyFromSource(priceSource)
      const amounts = priced ? entryAmounts(totals, fallbackCurrency) : []
      let amountContent
      if (!priced) {
        amountContent = h(
          'span',
          null,
          '— ',
          h('span', { className: 'dshbu-muted' }, tr(dict, 'panel.amountUnavailable')),
        )
      } else if (amounts.length === 0) {
        amountContent = '—'
      } else {
        amountContent = amounts.map((amount, index) =>
          h(
            'div',
            { className: 'dshbu-summary-amount', key: 'amount-' + index },
            formatMoney(amount.amount, amount.currency),
          ),
        )
      }
      return h(
        'div',
        { className: 'dshbu-summary-cell' },
        h('div', { className: 'dshbu-summary-label' }, tr(dict, labelKey)),
        h(
          'div',
          { className: 'dshbu-summary-tokens' },
          formatTokens(tokens, localeId),
          h('span', { className: 'dshbu-summary-unit' }, ' ' + tr(dict, 'panel.tokens')),
        ),
        h('div', { className: 'dshbu-summary-amount-line' }, amountContent),
      )
    }

    function SummarySection({ dict, totals, priceSource, priced, localeId }) {
      const rows = [
        ['panel.today', totals.today],
        ['panel.last7', totals.d7],
        ['panel.last30', totals.d30],
        ['panel.last90', totals.d90],
      ]
      return h(
        'section',
        { className: 'dshbu-section' },
        h('h3', { className: 'dshbu-section-title' }, tr(dict, 'panel.summary')),
        h(
          'div',
          { className: 'dshbu-summary-grid' },
          rows.map(([labelKey, entry]) =>
            h(SummaryCell, {
              key: labelKey,
              dict,
              labelKey,
              entry,
              priceSource,
              priced,
              localeId,
            }),
          ),
        ),
      )
    }

    // Rolled-up subagent sessions are already inside every summary amount; this
    // single muted line only isolates the child part. Hidden when unavailable.
    function SubagentLine({ dict, subagent, localeId }) {
      const payload = obj(subagent)
      const count = toNum(payload.sessions)
      if (payload.unavailable === true || count === null || count <= 0) return null
      const priced = payload.priced !== false
      const tokens = sumTokenFields(payload.tokens)
      const fallbackCurrency = str(payload.currency)
      const amounts = entryAmounts(payload, fallbackCurrency)
      const amountText =
        amounts.length > 0
          ? amounts
              .map((entry) => {
                const money = formatSubagentMoney(entry.amount, entry.currency)
                if (money === null) return tr(dict, 'panel.amountUnavailable')
                return priced ? money : '≈' + money
              })
              .join(' · ')
          : tr(dict, 'panel.amountUnavailable')
      const line = tr(dict, 'panel.subagentLine', {
        count: formatInt(count, localeId),
        amount: amountText,
        tokens: tokens === null ? '—' : formatInt(tokens, localeId),
      })
      return h(
        'div',
        { className: 'dshbu-subagent dshbu-muted' },
        h('span', { className: 'dshbu-subagent-label' }, tr(dict, 'panel.subagent')),
        h('span', { className: 'dshbu-subagent-value' }, line),
        priced ? null : h('span', { className: 'dshbu-subagent-est' }, ' · ' + tr(dict, 'panel.estimated')),
      )
    }

    function weekdayOffset(dateText) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return 0
      const parsed = new Date(dateText + 'T00:00:00Z')
      if (Number.isNaN(parsed.getTime())) return 0
      return (parsed.getUTCDay() + 6) % 7
    }

    function monthText(year, month, localeId) {
      try {
        return new Intl.DateTimeFormat(localeId || 'en', { month: 'short' }).format(
          new Date(Date.UTC(year, month - 1, 1)),
        )
      } catch {
        return year + '-' + month
      }
    }

    function heatLevel(tokens, maxTokens) {
      if (tokens <= 0 || maxTokens <= 0) return 0
      const ratio = tokens / maxTokens
      if (ratio <= 0.25) return 1
      if (ratio <= 0.5) return 2
      if (ratio <= 0.75) return 3
      return 4
    }

    function buildHeatmap(days, localeId, limit) {
      const valid = arr(days).filter((day) => day && typeof day === 'object').slice(-(limit || 90))
      if (valid.length === 0) return { cells: [], months: [], maxTokens: 0 }
      const firstDate = str(valid[0].date).slice(0, 10)
      const offset = weekdayOffset(firstDate)
      const cells = []
      for (let index = 0; index < offset; index += 1) cells.push(null)
      for (const day of valid) cells.push(day)
      let maxTokens = 0
      for (const day of valid) {
        const tokens = toNum(day.tokens)
        if (tokens !== null && tokens > maxTokens) maxTokens = tokens
      }
      const columns = Math.max(1, Math.ceil(cells.length / 7))
      const months = []
      let previousMonth = ''
      for (let column = 0; column < columns; column += 1) {
        let monthKey = ''
        for (let row = 0; row < 7; row += 1) {
          const cell = cells[column * 7 + row]
          const dateText = cell ? str(cell.date).slice(0, 10) : ''
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
            monthKey = dateText.slice(0, 7)
            break
          }
        }
        if (monthKey && monthKey !== previousMonth) {
          const parts = monthKey.split('-')
          months.push({ column, text: monthText(Number(parts[0]), Number(parts[1]), localeId) })
          previousMonth = monthKey
        }
      }
      return { cells, months, maxTokens }
    }

    function renderHeatCell(dict, day, maxTokens, index, localeId, priceSource) {
      const tokens = toNum(day.tokens)
      const safeTokens = tokens === null ? 0 : tokens
      const level = heatLevel(safeTokens, maxTokens)
      const dateText = str(day.date)
      const amountParts = entryAmounts(day, fallbackCurrencyFromSource(priceSource)).map((amount) =>
        formatMoney(amount.amount, amount.currency),
      )
      const amountText = amountParts.length > 0 ? amountParts.join(' · ') : tr(dict, 'panel.amountUnavailable')
      const sessions = toNum(day.sessions)
      const sessionsText =
        sessions === null ? '' : ' · ' + formatInt(sessions, localeId) + ' ' + tr(dict, 'panel.sessions')
      const ariaLabel =
        dateText +
        ', ' +
        formatInt(safeTokens, localeId) +
        ' ' +
        tr(dict, 'panel.tokens') +
        ', ' +
        amountText +
        sessionsText
      return h(
        'button',
        {
          type: 'button',
          key: 'cell-' + index,
          className: 'dshbu-cell',
          'data-level': String(level),
          'aria-label': ariaLabel,
        },
        h(
          'span',
          { className: 'dshbu-tip', role: 'tooltip' },
          dateText +
            ' · ' +
            formatInt(safeTokens, localeId) +
            ' ' +
            tr(dict, 'panel.tokens') +
            ' · ' +
            amountText +
            sessionsText,
        ),
      )
    }

    function HeatmapLegend({ dict }) {
      return h(
        'div',
        { className: 'dshbu-legend' },
        h('span', null, tr(dict, 'panel.less')),
        [0, 1, 2, 3, 4].map((level) =>
          h('span', {
            key: 'legend-' + level,
            className: 'dshbu-legend-swatch',
            'data-level': String(level),
            'aria-hidden': true,
          }),
        ),
        h('span', null, tr(dict, 'panel.more')),
      )
    }

    function HeatmapSection({ dict, days, localeId, priceSource, daysLimit }) {
      const model = buildHeatmap(days, localeId, daysLimit)
      if (model.cells.length === 0) return null
      return h(
        'section',
        { className: 'dshbu-section' },
        h('h3', { className: 'dshbu-section-title' }, tr(dict, 'panel.heatmap')),
        h(
          'div',
          { className: 'dshbu-heatmap' },
          h(
            'div',
            { className: 'dshbu-heatmap-inner' },
            h(
              'div',
              { className: 'dshbu-months' },
              model.months.map((month) =>
                h(
                  'span',
                  {
                    key: 'month-' + month.column,
                    className: 'dshbu-month',
                    style: { left: month.column * CELL_STEP_PX + 'px' },
                  },
                  month.text,
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshbu-grid' },
              model.cells.map((cell, index) =>
                cell
                  ? renderHeatCell(dict, cell, model.maxTokens, index, localeId, priceSource)
                  : h('span', {
                      key: 'blank-' + index,
                      className: 'dshbu-cell dshbu-cell--blank',
                      'aria-hidden': true,
                    }),
              ),
            ),
          ),
        ),
        h(HeatmapLegend, { dict }),
      )
    }

    function closeIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4 4l8 8M12 4l-8 8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    // ---------------------------------------------------------------------
    // Overlay panel.
    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // Failure presentation, confidence, by-model breakdown, error boundary.
    // ---------------------------------------------------------------------
    function retryState(entries, maxRetries) {
      let failures = 0
      let anyError = false
      let anyInflight = false
      for (const entry of entries) {
        if (!entry) continue
        if (entry.error) {
          anyError = true
          failures = Math.max(failures, entry.failures || 0)
        }
        if (entry.inflight) anyInflight = true
      }
      const max = Math.max(1, maxRetries)
      return { anyError, anyInflight, n: Math.max(1, Math.min(failures, max)), m: max }
    }

    const CONFIDENCE_KEYS = {
      exact: 'panel.confidenceExact',
      family: 'panel.confidenceFamily',
      community: 'panel.confidenceCommunity',
      override: 'panel.confidenceOverride',
      none: 'panel.confidenceNone',
    }

    function ConfidenceBadge({ dict, confidence }) {
      const value = str(confidence)
      if (!value) return null
      const key = CONFIDENCE_KEYS[value]
      const label = key ? tr(dict, key) : value
      const approximate = value !== 'exact'
      return h(
        'span',
        { className: 'dshbu-badge dshbu-confidence', title: tr(dict, 'panel.confidence') },
        approximate ? '≈' : '',
        label,
      )
    }

    function ModelRow({ dict, row, totalTokens, localeId }) {
      const provider = str(row.provider) || '—'
      const model = str(row.model) || '—'
      const tokens = sumTokenFields(row.tokens)
      const share =
        totalTokens > 0 && tokens !== null
          ? Math.max(0, Math.min(100, (tokens / totalTokens) * 100))
          : 0
      const fallbackCurrency = str(row.currency) || fallbackCurrencyFromSource(str(row.priceSource))
      const amounts = entryAmounts(row, fallbackCurrency)
      const priced = row.priced !== false && amounts.length > 0
      const amountText =
        amounts.length > 0
          ? amounts
              .map((amount) => formatSubagentMoney(amount.amount, amount.currency) || tr(dict, 'panel.amountUnavailable'))
              .join(' · ')
          : tr(dict, 'panel.amountUnavailable')
      return h(
        'div',
        { className: 'dshbu-model' },
        h(
          'div',
          { className: 'dshbu-model-head' },
          h('span', { className: 'dshbu-model-name', title: provider + '/' + model }, provider + ' / ' + model),
          h(ConfidenceBadge, { dict, confidence: row.pricingConfidence }),
          h(
            'span',
            { className: 'dshbu-model-tokens' },
            formatTokens(tokens, localeId) + ' ' + tr(dict, 'panel.tokens'),
          ),
        ),
        h(
          'div',
          { className: 'dshbu-model-amounts' },
          (priced ? '' : '≈ ') + amountText,
        ),
        h(
          'div',
          { className: 'dshbu-model-share' },
          h(
            'div',
            {
              className: 'dshbu-bar',
              role: 'img',
              'aria-label': tr(dict, 'panel.share') + ' ' + Math.round(share) + '%',
            },
            h('div', { className: 'dshbu-bar-fill', style: { width: share + '%' } }),
          ),
          h('span', { className: 'dshbu-model-percent' }, Math.round(share) + '%'),
        ),
      )
    }

    function ByModelSection({ dict, session, localeId }) {
      const rows = arr(session && session.byModel).filter((row) => row && typeof row === 'object')
      if (rows.length === 0) return null
      let totalTokens = 0
      for (const row of rows) {
        const tokens = sumTokenFields(row.tokens)
        if (tokens !== null) totalTokens += tokens
      }
      return h(
        'section',
        { className: 'dshbu-section' },
        h(
          'div',
          { className: 'dshbu-section-head' },
          h('h3', { className: 'dshbu-section-title' }, tr(dict, 'panel.byModel')),
          session && session.mixedProviders
            ? h('span', { className: 'dshbu-chip dshbu-chip--muted' }, tr(dict, 'panel.mixedProviders'))
            : null,
        ),
        rows.map((row, index) =>
          h(ModelRow, { key: 'model-' + index, dict, row, totalTokens, localeId }),
        ),
      )
    }

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error) {
        try {
          console.warn('[balance-usage] component crashed in a slot', error)
        } catch {
          // logging is best effort
        }
      }
      render() {
        if (this.state.failed) return this.props.fallback === undefined ? null : this.props.fallback
        return this.props.children
      }
    }

    // ---------------------------------------------------------------------
    // Overlay panel.
    // ---------------------------------------------------------------------
    function Panel() {
      const { active: localeId, dict } = useLocale()
      const openSnapshot = useSyncExternalStore(openStore.subscribe, openStore.getSnapshot)
      const open = openSnapshot.open === true
      const cardRef = useRef(null)
      const closeRef = useRef(null)
      const selectionEntry = useEntry('selection')
      const selection =
        selectionEntry.data && typeof selectionEntry.data === 'object' ? selectionEntry.data : {}
      const currentSessionId = str(selection.sessionId) || activeSessionRef.id || null
      const overviewEntry = useEntry(open ? 'overview' : null)
      const statsEntry = useEntry(open ? 'stats' : null)
      const pricingEntry = useEntry(open ? 'pricing' : null)
      const configEntry = useEntry(open ? 'config' : null)
      const sessionKey = open && currentSessionId ? 'session:' + currentSessionId : null
      const sessionEntry = useEntry(sessionKey)

      const close = useCallback(() => {
        openStore.close()
      }, [])

      const refresh = useCallback(() => {
        scheduler.requestNow('overview')
        scheduler.requestNow('stats', { refresh: true })
        scheduler.requestNow('pricing')
        if (sessionKey) scheduler.requestNow(sessionKey)
      }, [sessionKey])

      // Opening revalidates behind whatever is already cached: the panel never
      // blanks on reopen and shared requests are never aborted by a close.
      useEffect(() => {
        if (!open) return undefined
        scheduler.markDue('overview')
        scheduler.markDue('stats')
        scheduler.markDue('pricing')
        if (sessionKey) scheduler.markDue(sessionKey)
        scheduler.tick()
        return undefined
      }, [open, sessionKey])

      useEffect(() => {
        if (!open) return undefined
        const restoreTarget = openStore.getSnapshot().trigger || document.activeElement
        if (closeRef.current && typeof closeRef.current.focus === 'function') closeRef.current.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
            return
          }
          if (event.key !== 'Tab') return
          const card = cardRef.current
          if (!card) return
          let nodes = []
          try {
            nodes = Array.prototype.slice.call(
              card.querySelectorAll(
                'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
              ),
            )
          } catch {
            nodes = []
          }
          const focusable = nodes.filter((node) => node && (node.offsetParent !== null || node === document.activeElement))
          if (focusable.length === 0) {
            event.preventDefault()
            card.focus()
            return
          }
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const current = document.activeElement
          if (event.shiftKey) {
            if (current === first || !card.contains(current)) {
              event.preventDefault()
              last.focus()
            }
          } else if (current === last || !card.contains(current)) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (restoreTarget && restoreTarget !== document.body && typeof restoreTarget.focus === 'function') {
            try {
              restoreTarget.focus()
            } catch {
              // the dock trigger may have unmounted with its session
            }
          }
        }
      }, [open, close])

      if (!open) return null

      const config = clientConfig()
      const overview = overviewEntry.data
      const stats = statsEntry.data
      const pricing = pricingEntry.data
      const rawSession = sessionEntry.data
      const session =
        rawSession &&
        (!str(rawSession.sessionId) || str(rawSession.sessionId) === currentSessionId)
          ? rawSession
          : null
      const providers = arr(overview && overview.providers).filter(
        (provider) => provider && typeof provider === 'object',
      )
      const days = arr(stats && stats.days).filter((day) => day && typeof day === 'object')
      const totals = obj(stats && stats.totals)
      const priceSource =
        (stats && str(stats.priceSource)) || (pricing && str(pricing.source)) || ''
      const confidence =
        (stats && str(stats.pricingConfidence)) || (session && str(session.pricingConfidence)) || ''
      const pricingAsOf = firstPositiveNum([
        stats && stats.pricingAsOf,
        pricing && pricing.fetchedAt,
      ])
      const stale = !!(stats && stats.pricingStale) || !!(pricing && pricing.stale)
      const pricingWarning = pricing ? str(pricing.warning) : ''
      const missingPrice = !priceSource || priceSource === 'none'
      const warning = pricingWarning || (missingPrice ? tr(dict, 'panel.priceMissing') : '')
      const priced = !(stats && stats.priced === false) && !missingPrice
      const hasAny = !!(overview || stats)
      const showNone = hasAny && providers.length === 0 && days.length === 0
      const scanned = stats ? toNum(stats.scannedSessions) : null
      const truncated = !!(stats && stats.truncated)
      const subagent = session ? obj(session.subagent) : {}
      const activeId =
        str(selection.provider) ||
        str(session && session.provider) ||
        str(overview && overview.active)
      const retry = retryState([overviewEntry, statsEntry, sessionEntry], config.retry.maxRetries)
      const anyInflight = !!(
        overviewEntry.inflight ||
        statsEntry.inflight ||
        pricingEntry.inflight ||
        (sessionEntry && sessionEntry.inflight)
      )
      const refreshing = anyInflight && hasAny
      const degraded = !!(overview && overview.degraded)

      const header = h(
        'div',
        { className: 'dshbu-head' },
        h(
          'div',
          { className: 'dshbu-head-main' },
          h('div', { className: 'dshbu-title' }, tr(dict, 'panel.title')),
          h(
            'div',
            { className: 'dshbu-provenance' },
            h(
              'span',
              { className: 'dshbu-prov' },
              tr(dict, 'panel.priceSource') + ': ' + sourceLabel(dict, priceSource),
            ),
            h(
              'span',
              { className: 'dshbu-prov' },
              tr(dict, 'panel.priceUpdated') + ': ' + formatWhen(pricingAsOf, localeId),
            ),
            h(ConfidenceBadge, { dict, confidence }),
            session && session.mixedProviders
              ? h('span', { className: 'dshbu-chip dshbu-chip--muted' }, tr(dict, 'panel.mixedProviders'))
              : null,
            stale ? h('span', { className: 'dshbu-chip dshbu-chip--warn' }, tr(dict, 'panel.priceStale')) : null,
            warning
              ? h('span', { className: 'dshbu-chip dshbu-chip--warn', title: warning }, warning)
              : null,
          ),
        ),
        h(
          'div',
          { className: 'dshbu-head-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshbu-textbtn',
              onClick: refresh,
              disabled: anyInflight,
            },
            refreshing || (!hasAny && anyInflight)
              ? tr(dict, 'panel.refreshing')
              : tr(dict, 'panel.refresh'),
          ),
          h(
            'button',
            {
              type: 'button',
              ref: closeRef,
              className: 'dshbu-iconbtn',
              onClick: close,
              'aria-label': tr(dict, 'panel.close'),
              title: tr(dict, 'panel.close'),
            },
            closeIcon(),
          ),
        ),
      )

      let bodyChildren
      if (!hasAny) {
        if (anyInflight) {
          bodyChildren = h(
            'div',
            { className: 'dshbu-state' },
            h('div', { className: 'dshbu-state-title' }, tr(dict, 'panel.loading')),
            retry.anyError
              ? h('div', { className: 'dshbu-state-hint' }, tr(dict, 'panel.loadingRetry', { n: retry.n, m: retry.m }))
              : null,
          )
        } else if (retry.anyError) {
          bodyChildren = h(
            'div',
            { className: 'dshbu-state' },
            h('div', { className: 'dshbu-state-title' }, tr(dict, 'panel.error')),
            h('div', { className: 'dshbu-err-msg' }, tr(dict, 'panel.errorHint')),
            h(
              'button',
              { type: 'button', className: 'dshbu-retry', onClick: refresh },
              tr(dict, 'panel.retry'),
            ),
          )
        } else {
          bodyChildren = h('div', { className: 'dshbu-state' }, tr(dict, 'panel.loading'))
        }
      } else if (showNone) {
        bodyChildren = h('div', { className: 'dshbu-state' }, tr(dict, 'panel.none'))
      } else {
        bodyChildren = [
          retry.anyError
            ? h(
                'div',
                { className: 'dshbu-banner dshbu-banner--thin', key: 'banner' },
                h(
                  'span',
                  { className: 'dshbu-banner-text' },
                  tr(dict, 'panel.retrying', { n: retry.n, m: retry.m }),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dshbu-retry', onClick: refresh, key: 'retry' },
                  tr(dict, 'panel.retry'),
                ),
              )
            : null,
          providers.length > 0
            ? h(ProvidersSection, {
                key: 'providers',
                dict,
                providers,
                activeId,
                localeId,
                degraded,
              })
            : null,
          stats
            ? h(SummarySection, {
                key: 'summary',
                dict,
                totals,
                priceSource,
                priced,
                localeId,
              })
            : null,
          session ? h(SubagentLine, { key: 'subagent', dict, subagent, localeId }) : null,
          session ? h(ByModelSection, { key: 'byModel', dict, session, localeId }) : null,
          days.length > 0
            ? h(HeatmapSection, {
                key: 'heatmap',
                dict,
                days,
                localeId,
                priceSource,
                daysLimit: config.heatmapDays,
              })
            : null,
        ]
      }

      const footer = h(
        'div',
        { className: 'dshbu-foot' },
        h('span', { className: 'dshbu-foot-text' }, tr(dict, 'panel.footer')),
        scanned !== null || truncated
          ? h(
              'span',
              { className: 'dshbu-foot-meta' },
              scanned !== null
                ? tr(dict, 'panel.scanned', { count: formatInt(scanned, localeId) })
                : '',
              truncated
                ? ' ' + tr(dict, 'panel.truncated', {
                    count: scanned === null ? '—' : formatInt(scanned, localeId),
                  })
                : '',
            )
          : null,
      )

      return h(
        'div',
        { className: 'dshbu-layer' },
        h('div', {
          className: 'dshbu-scrim',
          'aria-hidden': true,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        }),
        h(
          'div',
          {
            className: 'dshbu-card',
            ref: cardRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tr(dict, 'panel.title'),
            tabIndex: -1,
          },
          header,
          h('div', { className: 'dshbu-body' }, bodyChildren),
          footer,
        ),
      )
    }

    const GuardedDockCell = function GuardedDockCell(props) {
      return h(
        ErrorBoundary,
        { fallback: h('span', { className: 'dshbu-dock-anchor dshbu-dock-fallback' }, '—') },
        h(DockCell, props),
      )
    }

    const GuardedPanel = function GuardedPanel(props) {
      return h(ErrorBoundary, { fallback: null }, h(Panel, props))
    }

    // ---------------------------------------------------------------------
    // Styles: one owned <style> element, removed by the owning effect.
    // ---------------------------------------------------------------------
    const STYLE_TEXT = `
.dshbu-dock-anchor{display:inline-flex;min-width:0;font:inherit;font-size:12px;line-height:18px;vertical-align:middle}
.dshbu-dock-btn{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;min-width:0;max-width:100%;transition:background-color .12s ease,color .12s ease}
.dshbu-dock-btn:hover,.dshbu-dock-btn[aria-expanded="true"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.dshbu-dock-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshbu-dock-seg{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden}
.dshbu-dock-txt{overflow:hidden;text-overflow:ellipsis;max-width:200px}
.dshbu-dock-icon{flex:none;width:13px;height:13px;opacity:.9}
.dshbu-sep{color:var(--dsw-alias-label-secondary);opacity:.55;margin:0 1px}
.dshbu-err-dot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-warn-primary);display:inline-block}

.dshbu-layer{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:auto;padding:16px;box-sizing:border-box}
.dshbu-scrim{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 62%,transparent)}
.dshbu-card{position:relative;display:flex;flex-direction:column;width:calc(100vw - 32px);max-width:840px;max-height:80vh;min-height:180px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 16px 48px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);overflow:hidden;text-align:left;outline:none}
.dshbu-head{flex:none;display:flex;align-items:flex-start;gap:12px;padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshbu-head-main{flex:1 1 auto;min-width:0}
.dshbu-title{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}
.dshbu-provenance{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshbu-prov{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dshbu-chip{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 40%,transparent);font-size:11px;line-height:16px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshbu-chip--warn{color:var(--dsw-alias-state-warn-primary)}
.dshbu-head-actions{flex:none;display:flex;align-items:center;gap:6px}
.dshbu-textbtn{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;cursor:pointer}
.dshbu-textbtn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.dshbu-textbtn:disabled{opacity:.55;cursor:default}
.dshbu-iconbtn{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshbu-iconbtn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.dshbu-iconbtn:focus-visible,.dshbu-textbtn:focus-visible,.dshbu-cell:focus-visible,.dshbu-retry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshbu-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:4px 20px 16px}
.dshbu-banner{margin:8px 0 0;padding:6px 10px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshbu-banner .dshbu-retry{margin-left:auto;flex:none}
.dshbu-section{margin-top:16px}
.dshbu-section-title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}
.dshbu-provider{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;margin-bottom:8px}
.dshbu-provider[data-active="true"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary)}
.dshbu-provider-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshbu-provider-name{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshbu-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 40%,transparent);white-space:nowrap}
.dshbu-badge--active{color:var(--dsw-alias-brand-primary)}
.dshbu-badge--ok{color:var(--dsw-alias-state-success-primary)}
.dshbu-badge--warn{color:var(--dsw-alias-state-warn-primary)}
.dshbu-badge--error{color:var(--dsw-alias-state-error-primary)}
.dshbu-badge--idle{color:var(--dsw-alias-state-idle-primary)}
.dshbu-line{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:13px;line-height:20px;margin-top:6px}
.dshbu-line-label{color:var(--dsw-alias-label-secondary);min-width:0}
.dshbu-line-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dshbu-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshbu-reason{margin-top:6px}
.dshbu-usage{margin-top:10px}
.dshbu-usage-head{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshbu-usage-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshbu-usage-percent{flex:none;font-variant-numeric:tabular-nums}
.dshbu-bar{height:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);margin-top:4px;overflow:hidden}
.dshbu-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .2s ease}
.dshbu-usage-reset{margin-top:2px}
.dshbu-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.dshbu-summary-cell{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px;min-width:0}
.dshbu-summary-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dshbu-summary-tokens{font-size:18px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshbu-summary-unit{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.dshbu-summary-amount-line{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;margin-top:2px}
.dshbu-summary-amount{word-break:break-word}
.dshbu-subagent{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;margin-top:10px;padding:0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dshbu-subagent-label{flex:none;color:var(--dsw-alias-label-secondary)}
.dshbu-subagent-value{min-width:0;word-break:break-word}
.dshbu-subagent-est{flex:none;color:var(--dsw-alias-label-secondary);opacity:.85}
.dshbu-heatmap{overflow-x:auto;padding:16px 0 6px}
.dshbu-heatmap-inner{width:max-content}
.dshbu-months{position:relative;height:14px;margin-bottom:4px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary)}
.dshbu-month{position:absolute;top:0;white-space:nowrap}
.dshbu-grid{display:grid;grid-template-rows:repeat(7,12px);grid-auto-flow:column;grid-auto-columns:12px;gap:3px}
.dshbu-cell{position:relative;width:12px;height:12px;padding:0;border:0;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);cursor:default;display:block}
.dshbu-cell--blank{background:transparent}
.dshbu-cell[data-level="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dshbu-cell[data-level="2"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.dshbu-cell[data-level="3"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 62%,transparent)}
.dshbu-cell[data-level="4"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,transparent)}
.dshbu-cell:hover,.dshbu-cell:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:0}
.dshbu-tip{display:none;position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);z-index:8;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;white-space:nowrap;pointer-events:none;box-shadow:0 4px 14px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}
.dshbu-cell:hover .dshbu-tip,.dshbu-cell:focus-visible .dshbu-tip{display:block}
.dshbu-legend{display:flex;align-items:center;gap:4px;margin-top:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dshbu-legend-swatch{width:10px;height:10px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}
.dshbu-legend-swatch[data-level="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dshbu-legend-swatch[data-level="2"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.dshbu-legend-swatch[data-level="3"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 62%,transparent)}
.dshbu-legend-swatch[data-level="4"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,transparent)}
.dshbu-foot{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:10px 20px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-2)}
.dshbu-foot-text{flex:1 1 240px;min-width:0}
.dshbu-foot-meta{flex:none;font-variant-numeric:tabular-nums}
.dshbu-state{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center}
.dshbu-state-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshbu-err-msg{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word;max-width:480px}
.dshbu-retry{border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);border-radius:6px;font:inherit;font-size:12px;line-height:18px;padding:3px 12px;cursor:pointer}
.dshbu-retry:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
.dshbu-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px}
.dshbu-section-head .dshbu-section-title{margin:0}
.dshbu-chip--muted{color:var(--dsw-alias-label-secondary)}
.dshbu-confidence{color:var(--dsw-alias-label-secondary)}
.dshbu-banner--thin{padding:4px 10px;font-size:11px;line-height:16px}
.dshbu-banner-text{min-width:0;flex:1 1 240px}
.dshbu-state-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshbu-model{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px;margin-bottom:8px}
.dshbu-model-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px}
.dshbu-model-name{font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshbu-model-tokens{margin-left:auto;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none}
.dshbu-model-amounts{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;word-break:break-word}
.dshbu-model-share{display:flex;align-items:center;gap:8px;margin-top:6px}
.dshbu-model-share .dshbu-bar{flex:1 1 auto;margin-top:0}
.dshbu-model-percent{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshbu-dock-fallback{color:var(--dsw-alias-label-secondary);font-size:12px;padding:1px 8px}
@media (max-width:620px){.dshbu-summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (prefers-reduced-motion:reduce){.dshbu-dock-btn,.dshbu-bar-fill{transition:none}}
`

    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const selector = 'style[data-plugin="dsh-balance-usage-dock"]'
      let style = null
      try {
        style = document.querySelector(selector)
      } catch {
        style = null
      }
      const created = !style
      if (!style) {
        style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-balance-usage-dock')
        document.head.appendChild(style)
      }
      style.textContent = STYLE_TEXT
      return () => {
        if (!created) return
        try {
          style.remove()
        } catch {
          // already detached
        }
      }
    }

    function probeLocale(ctx) {
      try {
        const direct = ctx.locale
        if (direct && typeof direct.register === 'function') return direct
      } catch {
        // service access can throw before the service is ready
      }
      try {
        if (typeof ctx.get === 'function') {
          const found = ctx.get('locale')
          if (found && typeof found === 'object') return found
        }
      } catch {
        // absent locale service
      }
      return null
    }

    function registerLocaleDictionary(locale) {
      if (!locale || typeof locale.register !== 'function') return null
      try {
        const dispose = locale.register(NS, { zh: ZH, en: EN, 'zh-CN': ZH, 'en-US': EN })
        return typeof dispose === 'function' ? dispose : null
      } catch (error) {
        try {
          console.warn('[balance-usage] locale dictionary registration failed:', error)
        } catch {
          // logging is best effort
        }
        return null
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = probeLocale(ctx)
        localeRef.current = locale

        try {
          const direct = resolveService(ctx, 'modelDirectories')
          if (direct) services.modelDirectories = direct
        } catch {
          // optional service
        }

        ctx.effect(() => {
          const disposeStyles = installStyles()
          const disposeDictionary = registerLocaleDictionary(localeRef.current)
          return () => {
            try {
              if (typeof disposeDictionary === 'function') disposeDictionary()
            } catch {
              // dictionary owner already disposed
            }
            disposeStyles()
            scheduler.dispose()
          }
        })

        // Late-arriving service: re-resolve the current Session's selection.
        if (typeof ctx.inject === 'function') {
          try {
            ctx.inject(['modelDirectories'], (scope) => {
              try {
                const service = resolveService(scope, 'modelDirectories')
                if (!service) return
                services.modelDirectories = service
                syncSelection()
              } catch {
                // keep the session.provider fallback
              }
            })
          } catch {
            // ctx.inject unavailable
          }
        }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'balance-usage',
              order: 2,
            },
            GuardedDockCell,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'balance-usage-panel',
              order: 100,
            },
            GuardedPanel,
          ),
        )
      },
    }
  },
})
