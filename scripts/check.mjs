#!/usr/bin/env node
/**
 * Static gate for the plugin: syntax, JSON, locale parity, and the privacy
 * invariants that keep this package free of persisted credentials or personal
 * data. Run with `npm run check` (also used by CI).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function fail(message) {
  failures.push(message)
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

const files = walk(ROOT).map((path) => relative(ROOT, path))
const jsFiles = files.filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))
const jsonFiles = files.filter((file) => file.endsWith('.json'))

// 1. Syntax. Host halves are ESM; the browser bundle is a classic script.
for (const file of jsFiles) {
  const path = join(ROOT, file)
  const source = readFileSync(path, 'utf8')
  const isEsm = !file.startsWith('test/') && file !== 'client.js' && file !== 'scripts/check.mjs'
  const result = isEsm
    ? spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' })
    : spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (result.status !== 0) fail(`syntax: ${file}\n${result.stderr.trim()}`)
}
notes.push(`syntax: ${jsFiles.length} js files`)

// 2. JSON parse.
for (const file of jsonFiles) {
  try {
    JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
  } catch (error) {
    fail(`json: ${file}: ${error.message}`)
  }
}
notes.push(`json: ${jsonFiles.length} files`)

// 3. Locale parity + metadata.
try {
  const zh = JSON.parse(readFileSync(join(ROOT, 'locale/zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(ROOT, 'locale/en.json'), 'utf8'))
  if (!zh?.meta?.title || !zh?.meta?.description) fail('locale: zh.json lost meta.title/meta.description')
  if (!en?.meta?.title || !en?.meta?.description) fail('locale: en.json lost meta.title/meta.description')
  const keys = (value, prefix = '') =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key))
      : [prefix]
  const zhKeys = new Set(keys(zh))
  const enKeys = new Set(keys(en))
  for (const key of zhKeys) if (!enKeys.has(key)) fail(`locale: en.json is missing key ${key}`)
  for (const key of enKeys) if (!zhKeys.has(key)) fail(`locale: zh.json is missing key ${key}`)
  notes.push(`locale: ${zhKeys.size} keys per language`)
} catch (error) {
  fail(`locale: ${error.message}`)
}

// 4. Privacy invariants across shipped sources (tests/docs may mention them).
const shipped = files.filter(
  (file) => !file.startsWith('test/') && !file.startsWith('docs/') && !file.endsWith('.md') && file !== 'scripts/check.mjs',
)
const forbidden = [
  ['localStorage', /localStorage/],
  ['sessionStorage', /sessionStorage/],
  ['indexedDB', /indexedDB/],
  ['cookie', /document\.cookie/],
  ['file write', /\b(writeFile|appendFile|createWriteStream|writeFileSync|appendFileSync)\b/],
  ['storage service', /\bstorageDomain\b/],
  ['account profile', /\bgetProfile\b/],
  ['child process', /\b(child_process|execSync|spawnSync)\b/],
]
for (const file of shipped) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  for (const [name, pattern] of forbidden) {
    if (pattern.test(source)) fail(`privacy: ${file} contains ${name}`)
  }
}
notes.push(`privacy: ${shipped.length} shipped files scanned`)

// 5. Browser bundle shape.
try {
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  if (!/window\.__ModuleLoader__\.load\(/.test(client)) fail('client: missing window.__ModuleLoader__.load')
  if (!/id:\s*'dsh-balance-usage-dock'/.test(client)) fail('client: loader id does not match package name')
  const requires = [...client.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  for (const specifier of requires) {
    if (specifier !== 'react') fail(`client: forbidden require(${JSON.stringify(specifier)})`)
  }
  if (/@deepseek-ai\//.test(client)) fail('client: imports an @deepseek-ai package')
  if (/\bfetch\([^)]*\{[^}]*method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(client)) fail('client: sends a mutating request')
  if (/document\.body\s*\.\s*(appendChild|insertBefore|append|prepend|innerHTML|outerHTML)/.test(client)) {
    fail('client: writes to document.body')
  }
  notes.push('client: loader + react-only + read-only requests')
} catch (error) {
  fail(`client: ${error.message}`)
}

// 6. Version consistency.
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const index = readFileSync(join(ROOT, 'index.js'), 'utf8')
  const match = /PLUGIN_VERSION\s*=\s*'([^']+)'/.exec(index)
  if (!match) fail('version: PLUGIN_VERSION not found in index.js')
  else if (match[1] !== pkg.version) fail(`version: package.json ${pkg.version} != index.js ${match[1]}`)
  notes.push(`version: ${pkg.version}`)
} catch (error) {
  fail(`version: ${error.message}`)
}

for (const note of notes) console.log(`ok  ${note}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
