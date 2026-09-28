/**
 * One-shot generator for apps/api/src/routes.ts.
 *
 * The route table must agree with the directory tree — a module at
 * `routes/projects/[id]/route.ts` exports GET/PUT/… and is mounted at
 * `/api/projects/:id`. Hand-maintaining that mapping across ~70 modules is how
 * a route silently stops existing, so it is generated once and then frozen:
 * edits belong in the table only when a module is added/removed, and
 * `check:routes` re-derives the same answer to prove they still agree.
 *
 *   node scripts/gen-routes.mjs
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(API, 'src')
const ROUTES = join(SRC, 'routes')
const OUT = join(SRC, 'routes.ts')

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

const walk = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const entries = []
for (const file of walk(ROUTES).filter((f) => f.endsWith('route.ts'))) {
  const src = readFileSync(file, 'utf8')
  const segs = relative(ROUTES, file).split(sep).filter((s) => s !== 'route.ts')
  const path = '/api/' + segs.map((s) => s.replace(/^\[(.+)\]$/, ':$1')).join('/')
  const methods = [...src.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE|OPTIONS) = /gm)].map((m) => m[1])
  if (!methods.length) throw new Error(`no method exports in ${relative(API, file)}`)
  // Unique namespace per module: `routes/projects/[id]/route.ts` → `rProjectsId`
  const ns = 'r' + segs.map((s) => s.replace(/^\[(.+)\]$/, '$1')).join('_').replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
  entries.push({ ns, path, methods, file: relative(SRC, file).split(sep).join('/') })
}

entries.sort((a, b) => a.path.localeCompare(b.path) || a.methods[0].localeCompare(b.methods[0]))

const header = `/**
 * The API surface, generated from the \`routes/\` directory tree by
 * \`scripts/gen-routes.mjs\`. A module at \`routes/projects/[id]/route.ts\` is
 * mounted at \`/api/projects/:id\`.
 *
 * Edit this only when a route module is added or removed, then regenerate;
 * \`check:routes\` fails if this table and the tree ever disagree.
 */
import type { Context } from 'hono'

export type RouteHandler = (c: Context) => Promise<Response>
`

const imports = entries.map((e) => `import * as ${e.ns} from './${e.file}'`).join('\n')
const rows = entries.map((e) => e.methods.map((m) => `  ['${m}', '${e.path}', ${e.ns}.${m}],`).join('\n')).join('\n')

writeFileSync(OUT, `${header}\n${imports}\n\nexport const ROUTES: Array<[string, string, RouteHandler]> = [\n${rows}\n]\n`)
console.error(`wrote ${relative(API, OUT)}: ${entries.length} modules, ${entries.reduce((n, e) => n + e.methods.length, 0)} method+path pairs`)
