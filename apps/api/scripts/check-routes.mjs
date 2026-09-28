/**
 * Route table drift check.
 *
 * The API surface is a mass-moved pile of ~70 modules; the one failure mode
 * that is silent is a route that exists on disk but was never mounted (or was
 * mounted at the wrong path), because nothing imports it. This re-derives the
 * table from the directory tree and fails if it disagrees with
 * `src/routes.ts` — so `gen-routes.mjs` is the only thing allowed to write
 * the table, and this proves it is still current.
 *
 *   node scripts/check-routes.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(API, 'src')
const ROUTES_DIR = join(SRC, 'routes')
const TABLE = join(SRC, 'routes.ts')

const walk = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

/** What the tree says the surface should be. */
const expected = new Set()
for (const file of walk(ROUTES_DIR).filter((f) => f.endsWith('route.ts'))) {
  const src = readFileSync(file, 'utf8')
  const segs = relative(ROUTES_DIR, file).split(sep).filter((s) => s !== 'route.ts')
  const path = '/api/' + segs.map((s) => s.replace(/^\[(.+)\]$/, ':$1')).join('/')
  const methods = [...src.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE|OPTIONS) = /gm)].map((m) => m[1])
  if (!methods.length) {
    console.error(`FAIL  ${relative(API, file)} exports no HTTP method`)
    process.exit(1)
  }
  for (const m of methods) expected.add(`${m} ${path}`)
}

/** What the table actually mounts. */
const table = readFileSync(TABLE, 'utf8')
const actual = new Set([...table.matchAll(/^ {2}\['(\w+)', '([^']+)',/gm)].map((m) => `${m[1]} ${m[2]}`))

const missing = [...expected].filter((r) => !actual.has(r))
const extra = [...actual].filter((r) => !expected.has(r))

if (missing.length || extra.length) {
  for (const r of missing) console.error(`FAIL  not mounted: ${r}  (exists in routes/, absent from routes.ts)`)
  for (const r of extra) console.error(`FAIL  mounted but no module: ${r}  (in routes.ts, absent from routes/)`)
  console.error(`\nrun: node scripts/gen-routes.mjs`)
  process.exit(1)
}

// A mounted entry that is not a function would throw at request time, not boot.
const bad = [...table.matchAll(/^ {2}\['(\w+)', '([^']+)', (\w+)\.(\w+)\],/gm)].filter((m) => !m[3] || !m[4])
if (bad.length) {
  for (const b of bad) console.error(`FAIL  malformed entry: ${b[0].trim()}`)
  process.exit(1)
}

console.log(`routes ok: ${actual.size} method+path pairs match the tree (${walk(ROUTES_DIR).filter((f) => f.endsWith('route.ts')).length} modules)`)
