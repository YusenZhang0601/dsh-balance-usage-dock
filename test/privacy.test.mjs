/**
 * Privacy + packaging invariants (docs/contract-v2.md "Privacy invariants").
 *
 * Static scan only: the shipped files must not reach browser storage, the
 * filesystem, credential/profile services or non-local origins.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['test', 'docs', 'node_modules', '.git', '.github'])
const SCAN_EXTENSIONS = new Set(['.js', '.json', '.yml', '.yaml'])

function listShippedFiles(dir = ROOT) {
  const files = []
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      files.push(...listShippedFiles(full))
      continue
    }
    const dot = name.lastIndexOf('.')
    const ext = dot >= 0 ? name.slice(dot) : ''
    if (SCAN_EXTENSIONS.has(ext)) files.push(full)
  }
  return files
}

const SHIPPED = listShippedFiles()
const rel = (file) => relative(ROOT, file).replaceAll('\\', '/')

function read(file) {
  return readFileSync(file, 'utf8')
}

/** Strip block/line comments so a "we never use localStorage" comment cannot fail the scan. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

const FORBIDDEN_APIS =
  /\b(localStorage|sessionStorage|indexedDB|document\.cookie|writeFile|appendFile|createWriteStream|storageDomain)\b/

const CREDENTIAL_LITERALS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
]

const pkg = JSON.parse(read(join(ROOT, 'package.json')))

test('privacy: no browser storage / file-write / storage-domain APIs in shipped files', () => {
  assert.ok(SHIPPED.length > 5, 'the shipped-file walk must find the plugin files')
  for (const file of SHIPPED) {
    const text = file.endsWith('.js') ? stripComments(read(file)) : read(file)
    const match = FORBIDDEN_APIS.exec(text)
    assert.equal(match, null, `${rel(file)} uses forbidden API "${match?.[1]}"`)
  }
})

test('privacy: no credential/profile service is read by the shipped code', () => {
  for (const file of SHIPPED) {
    const text = file.endsWith('.js') ? stripComments(read(file)) : read(file)
    assert.doesNotMatch(text, /\bgetProfile\b/, `${rel(file)} must not call getProfile`)
  }
})

test('privacy: no obvious credential literal is committed', () => {
  for (const file of SHIPPED) {
    const text = read(file)
    for (const pattern of CREDENTIAL_LITERALS) {
      const match = pattern.exec(text)
      assert.equal(match, null, `${rel(file)} contains what looks like a credential: ${match?.[0]?.slice(0, 8)}…`)
    }
  }
})

// ------------------------------------------------------------ client bundle

const client = read(join(ROOT, 'client.js'))

test('client bundle: standard module-loader shape, id matches the package name', () => {
  assert.match(client, /^\s*window\.__ModuleLoader__\.load\(/)
  const id = new RegExp(`id:\\s*['"]${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`)
  assert.match(client, id, `the module id must be "${pkg.name}"`)
  assert.match(client, /factory\s*\(\s*require\s*\)/, 'the loader factory takes require')
})

test('client bundle: only require("react"), no @deepseek-ai packages or node builtins', () => {
  const required = [...client.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2])
  assert.ok(required.length > 0)
  assert.deepEqual([...new Set(required)], ['react'])
  assert.doesNotMatch(client, /@deepseek-ai\//)
  assert.doesNotMatch(client, /require\(\s*['"]node:/)
})

test('client bundle: no non-GET request, no non-local fetch, no alternate transports', () => {
  assert.doesNotMatch(client, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i)
  assert.doesNotMatch(client, /XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  for (const match of client.matchAll(/fetch\s*\(([^)]*)/g)) {
    const args = match[1]
    assert.doesNotMatch(args, /['"`]https?:\/\//i, `client fetches a non-local origin: ${args.slice(0, 80)}`)
  }
  // Every fetch is against the plugin's own route (directly or through a URL var).
  const fetches = [...client.matchAll(/fetch\s*\(([^)]*)/g)]
  assert.ok(fetches.length > 0, 'the client must fetch the local API')
  for (const match of fetches) {
    assert.match(match[1], /API_PATH|balance-usage-api/, 'client fetches must target the local API route')
  }
})

// ------------------------------------------------------------------- locale

test('locale: en/zh keep meta.title + meta.description and identical key sets', () => {
  const names = readdirSync(join(ROOT, 'locale')).filter((name) => name.endsWith('.json')).sort()
  assert.ok(names.includes('en.json'), 'en.json must ship')
  assert.ok(names.includes('zh.json'), 'zh.json must ship')

  const dictionaries = new Map()
  for (const name of names) {
    const json = JSON.parse(read(join(ROOT, 'locale', name)))
    const meta = json.meta ?? {}
    assert.equal(typeof meta.title, 'string', `${name} meta.title must be a string`)
    assert.ok(meta.title.trim() !== '', `${name} meta.title must not be empty`)
    assert.equal(typeof meta.description, 'string', `${name} meta.description must be a string`)
    assert.ok(meta.description.trim() !== '', `${name} meta.description must not be empty`)
    dictionaries.set(name, keySet(json))
  }

  const keys = new Map([...dictionaries].map(([name, set]) => [name, [...set].sort()]))
  const [referenceName, reference] = [...keys][0]
  for (const [name, list] of keys) {
    assert.deepEqual(list, reference, `${name} must have exactly the same keys as ${referenceName}`)
  }
})

function keySet(value, prefix = '') {
  const keys = []
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) keys.push(...keySet(child, `${prefix}${key}.`))
    else keys.push(`${prefix}${key}`)
  }
  return new Set(keys)
}
