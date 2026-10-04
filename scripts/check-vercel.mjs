/**
 * Vercel services config check.
 *
 * The root `vercel.json` turns this repo into ONE Vercel project with two
 * services (api = Hono, web = Next.js) behind one domain. Vercel only reports a
 * bad config at deploy time, and several mistakes are not reported at all:
 *
 *   - a `functions` key that is not a real source path is silently dropped, so
 *     `maxDuration` never reaches the function (docs/audit/2026-10-03.md P0-3);
 *   - a catch-all rewrite placed before `/api/(.*)` swallows every API call;
 *   - a prefix-strip `request.path` transform makes every route 404, because
 *     the API registers its routes WITH the `/api` prefix;
 *   - a per-app `vercel.json` left next to a service is dead config that drifts;
 *   - the web `build` script ends in `finalize-standalone.mjs`, which exits 1 on
 *     Vercel (output: standalone is skipped there), so the service must use
 *     `build:vercel`.
 *
 * This re-derives those rules from the files and fails on the first drift. It
 * has no dependencies on purpose (no @vercel/* packages in the lockfile) and
 * runs in a few milliseconds. The generic rules mirror what Vercel's own
 * resolver enforces (service names, roots, binding fields, rewrite shape); the
 * rules marked "repo" below are this repository's own traps, so a legitimate
 * future change is a conscious edit here.
 *
 *   node scripts/check-vercel.mjs            # check the repo root
 *   node scripts/check-vercel.mjs --root DIR # check another tree (self-test)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootArg = process.argv.indexOf('--root')
const ROOT = rootArg > -1 ? resolve(process.cwd(), process.argv[rootArg + 1] ?? '') : fileURLToPath(new URL('..', import.meta.url))

const SCHEMA = 'https://openapi.vercel.sh/vercel.json'
/** Vercel's own service-name rule (resolve-v2): lowercase, `_`/`-` inside, max 64. */
const NAME_RE = /^[a-z]([a-z_-]*[a-z])?$/
const ENV_RE = /^[A-Z][A-Z0-9_]*$/
/** Keys Vercel reads from a `services.<name>` entry. Anything else is a typo. */
const SERVICE_KEYS = new Set([
  'root', 'framework', 'runtime', 'entrypoint', 'installCommand', 'buildCommand', 'devCommand',
  'ignoreCommand', 'outputDirectory', 'bindings', 'functions', 'headers', 'redirects', 'rewrites',
  'routes', 'cleanUrls', 'trailingSlash',
])
/** Build/runtime keys that are invalid at the top level in services mode. */
const TOP_LEVEL_BUILD_KEYS = ['functions', 'installCommand', 'buildCommand', 'devCommand', 'ignoreCommand', 'outputDirectory']
/** Top-level keys this repo refuses outright (repo: the owner's policy). */
const TOP_LEVEL_FORBIDDEN = {
  experimentalServices: 'conflicts with `services` (Vercel: CONFLICTING_SERVICES_CONFIG)',
  experimentalServicesV2: 'conflicts with `services` (Vercel: CONFLICTING_SERVICES_CONFIG)',
  builds: 'legacy builder config; a service carries its own framework',
  routes: 'legacy routing; services are routed by top-level `rewrites`',
  crons: 'scheduled jobs are driven by an EXTERNAL pinger on GET /api/internal/cron (a sub-daily Vercel cron also fails a Hobby deploy)',
}
/**
 * @vercel/backends' entrypoint scan (dist/index.mjs, DEFAULT_FILENAMES x
 * entrypointExtensions): file by file in this order, first one whose source
 * matches the framework import regex wins. The regex wants the bare specifier,
 * so `from 'hono/cors'` alone does not count.
 */
const ENTRY_NAMES = ['app', 'index', 'server', 'src/app', 'src/index', 'src/server', 'main', 'src/main']
const ENTRY_EXTS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts']
const HONO_IMPORT = /(?:from|require|import)\s*(?:\(\s*)?["']hono["']\s*(?:\))?/
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/
const SKIP_DIRS = new Set(['node_modules', '.next', '.vercel', 'dist', '.git'])

const errors = []
const warnings = []
const fail = (m) => errors.push(m)
const warn = (m) => warnings.push(m)

const abs = (...p) => join(ROOT, ...p)
const exists = (...p) => existsSync(abs(...p))
const text = (...p) => readFileSync(abs(...p), 'utf8')
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function json(path, what) {
  try {
    return JSON.parse(text(path))
  } catch (e) {
    fail(`${what} (${path}) is missing or not valid JSON: ${e.message}`)
    return null
  }
}

/** Every source file under `dir` (relative paths), skipping build output. */
function sourceFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(abs(dir, d), { withFileTypes: true })) {
      const rel = d ? `${d}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel)
      } else if (SOURCE_EXT.test(e.name)) out.push(rel)
    }
  }
  walk('')
  return out
}

const cfg = json('vercel.json', 'root vercel.json')
if (!cfg) finish()

// ── (a) shape ────────────────────────────────────────────────────────────────
if (cfg.$schema !== SCHEMA) fail(`vercel.json: $schema must be "${SCHEMA}"`)
if (!isObj(cfg.services) || !Object.keys(cfg.services).length) fail('vercel.json: `services` must be a non-empty object')
for (const [key, why] of Object.entries(TOP_LEVEL_FORBIDDEN)) {
  if (key in cfg) fail(`vercel.json: top-level \`${key}\` is not allowed: ${why}`)
}

// ── (b) top-level build/runtime keys ─────────────────────────────────────────
for (const key of TOP_LEVEL_BUILD_KEYS) {
  if (key in cfg) fail(`vercel.json: top-level \`${key}\` is invalid in services mode; move it into the service it belongs to`)
}
if ('framework' in cfg && cfg.framework !== 'services' && cfg.framework !== null) {
  fail('vercel.json: top-level `framework` is invalid in services mode (each service sets its own)')
}

const services = isObj(cfg.services) ? cfg.services : {}
const names = Object.keys(services)

// ── rewrites (parsed first: public/internal decides several later rules) ─────
const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : []
if ('rewrites' in cfg && !Array.isArray(cfg.rewrites)) fail('vercel.json: `rewrites` must be an array')
const CATCH_ALL = /^\/(?:\(\.\*\)\??|:\w+(?:\*|\+|\(\.\*\)))$/
/** service name → rewrite sources that make it public */
const publicVia = new Map()
rewrites.forEach((r, i) => {
  const at = `rewrites[${i}]`
  if (!isObj(r) || typeof r.source !== 'string') return fail(`vercel.json: ${at} needs a string \`source\``)
  const d = r.destination
  if (typeof d === 'string') return
  if (!isObj(d)) return fail(`vercel.json: ${at}.destination must be a string or { "service": "<name>" }`)
  const extra = Object.keys(d).filter((k) => !['service', 'type', 'path'].includes(k))
  if (extra.length) fail(`vercel.json: ${at}.destination has unknown key(s) ${extra.join(', ')} (Vercel's schema allows service, type, path only)`)
  if (typeof d.service !== 'string') return fail(`vercel.json: ${at}.destination.service must be a string`)
  if (d.type !== undefined && d.type !== 'service') fail(`vercel.json: ${at}.destination.type must be "service" when present`)
  if (d.path !== undefined) warn(`vercel.json: ${at}.destination.path is routing-only state, not a URL rewrite; the service still sees the original path`)
  if (!(d.service in services)) fail(`vercel.json: ${at} targets service "${d.service}", which is not declared in \`services\``)
  else publicVia.set(d.service, [...(publicVia.get(d.service) ?? []), r.source])
})
{
  const seen = new Set()
  rewrites.forEach((r, i) => {
    if (!isObj(r) || typeof r.source !== 'string') return
    if (seen.has(r.source)) fail(`vercel.json: rewrites[${i}] repeats source "${r.source}"; the later one never matches`)
    seen.add(r.source)
    if (CATCH_ALL.test(r.source) && i !== rewrites.length - 1) {
      fail(`vercel.json: rewrites[${i}] "${r.source}" is a catch-all but is not LAST; it shadows every rewrite after it`)
    }
  })
}

// ── workspace membership ─────────────────────────────────────────────────────
const workspaceGlobs = (() => {
  if (!exists('pnpm-workspace.yaml')) return null
  const out = []
  let inPackages = false
  for (const line of text('pnpm-workspace.yaml').split('\n')) {
    if (/^packages\s*:/.test(line)) inPackages = true
    else if (inPackages) {
      const m = line.match(/^\s+-\s+['"]?([^'"#\s]+)['"]?/)
      if (m) out.push(m[1])
      else if (/^[^\s#]/.test(line)) inPackages = false
    }
  }
  return out
})()
const inWorkspace = (rootPath) =>
  (workspaceGlobs ?? []).some((g) => {
    const gs = g.split('/')
    const ps = rootPath.split('/')
    return gs.length === ps.length && gs.every((s, i) => s === '*' || s === ps[i])
  })

// ── (c)(d)(e)(i) per service ─────────────────────────────────────────────────
const info = {} // name → { root, pkg, framework }
for (const name of names) {
  const svc = services[name]
  const at = `services.${name}`
  if (!NAME_RE.test(name) || name.length > 64) fail(`${at}: service name must match ${NAME_RE} and be at most 64 characters`)
  if (!isObj(svc)) {
    fail(`${at}: must be an object`)
    continue
  }
  for (const k of Object.keys(svc)) if (!SERVICE_KEYS.has(k)) warn(`${at}: unknown key \`${k}\` (Vercel ignores it; typo?)`)

  // root: required, relative, inside the project, a real workspace package.
  if (typeof svc.root !== 'string' || !svc.root.trim()) {
    fail(`${at}.root is required (the service directory, relative to vercel.json)`)
    continue
  }
  const root = posix.normalize(svc.root.replace(/\\/g, '/')).replace(/\/+$/, '')
  if (isAbsolute(svc.root) || root === '..' || root.startsWith('../')) {
    fail(`${at}.root "${svc.root}" must be relative and stay inside the project`)
    continue
  }
  if (!exists(root)) {
    fail(`${at}.root "${svc.root}" does not exist`)
    continue
  }
  const pkg = exists(root, 'package.json') ? json(`${root}/package.json`, `${at} package.json`) : (fail(`${at}: ${root}/package.json is missing`), null)
  if (workspaceGlobs && !inWorkspace(root)) fail(`${at}.root "${root}" is not a pnpm workspace member (pnpm-workspace.yaml: ${workspaceGlobs.join(', ')})`)
  const framework = svc.framework
  if (framework !== undefined && typeof framework !== 'string') fail(`${at}.framework must be a string slug`)
  info[name] = { root, pkg, framework }

  // (i) a nested vercel.json beside a service is dead config under services.
  if (exists(root, 'vercel.json')) fail(`${root}/vercel.json must not exist: services mode never reads it, so it only drifts from the root file (move its keys into ${at})`)

  // framework needs its package.
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  if (framework === 'nextjs' && pkg && !deps.next) fail(`${at}: framework "nextjs" but ${root}/package.json has no \`next\` dependency`)
  if (framework === 'hono' && pkg && !deps.hono) fail(`${at}: framework "hono" but ${root}/package.json has no \`hono\` dependency`)

  // Node major: a real `vercel build` (62.2.0) resolved it from the SERVICE ROOT package.json, not the repo root.
  const node = pkg?.engines?.node
  if (pkg) {
    if (typeof node !== 'string') fail(`${root}/package.json needs "engines": { "node": "24.x" }: a service build resolved Node from its own root in a real \`vercel build\`, and without it the dashboard setting decides`)
    else if (/^\s*>=\s*24(?:\.\d+){0,2}\s*$/.test(node)) warn(`${root}/package.json engines.node "${node}" selects 24 but prints Vercel's "will auto-upgrade to the next major" warning; "24.x" is exact`)
    else if (!/^\s*[~^]?24(?:\.(?:x|\*|\d+)){0,2}\s*$/.test(node)) fail(`${root}/package.json engines.node "${node}" does not select Node 24 (the repo requires >=24; use "24.x")`)
  }

  if (svc.entrypoint !== undefined && (typeof svc.entrypoint !== 'string' || !exists(root, svc.entrypoint))) {
    fail(`${at}.entrypoint "${svc.entrypoint}" is not a file under ${root}`)
  }

  // (d) repo: the Hono service must resolve to the SERVERLESS entry, never the listener.
  // Guarded on the dependency too: a service that drops `framework` still builds as Hono.
  if (framework === 'hono' || deps.hono) {
    if (framework !== 'hono') warn(`${at}: ${root}/package.json depends on hono but \`framework\` is not "hono"; set it so the builder is not left to detect it`)
    const looksLikeHono = (rel) => exists(root, rel) && HONO_IMPORT.test(text(root, rel))
    let entry = svc.entrypoint
    if (entry === undefined) {
      // No `entrypoint`: the builder scans ENTRY_NAMES x ENTRY_EXTS and takes the first file importing hono.
      const scanned = ENTRY_NAMES.flatMap((b) => ENTRY_EXTS.map((x) => `${b}.${x}`)).find(looksLikeHono)
      const main = typeof pkg?.main === 'string' && exists(root, pkg.main) ? posix.normalize(pkg.main) : undefined
      entry = scanned ?? main
      if (entry === undefined) fail(`${at}: no entrypoint set and no ${ENTRY_NAMES.join(' / ')} file (${ENTRY_EXTS.join(', ')}) imports "hono"; set "entrypoint": "src/app.ts"`)
      else if (entry !== 'src/app.ts') fail(`${at}: without an "entrypoint" Vercel would pick ${root}/${entry}, not src/app.ts (the serverless default export); set "entrypoint": "src/app.ts" or remove the file that is scanned first`)
      entry ??= 'src/app.ts'
    }
    if (/^(?:.*\/)?(?:serve|server)\.[cm]?[jt]s$/.test(entry)) {
      fail(`${at}: entrypoint "${entry}" is the long-running node listener (serve.ts calls serve()); Vercel needs src/app.ts, which default-exports the Hono app`)
    } else if (exists(root, entry) && !/export\s+default\b/.test(text(root, entry))) {
      fail(`${at}: ${root}/${entry} has no \`export default\`; the serverless entrypoint must default-export the Hono app`)
    }

    // functions: keys must be real SOURCE paths relative to the service root, and must hit the entrypoint.
    if (svc.functions !== undefined) {
      if (!isObj(svc.functions)) fail(`${at}.functions must be an object`)
      else {
        let hitsEntry = false
        for (const [key, conf] of Object.entries(svc.functions)) {
          const glob = /[*?[\]{}]/.test(key)
          if (!glob && !exists(root, key)) fail(`${at}.functions["${key}"] is not a file under ${root}; a key that is not a real source path is silently dropped (audit P0-3: "src/app.func" lost maxDuration)`)
          // `**/` is zero or more directories, `**` anything, `*` one path segment's worth.
          const re = new RegExp('^' + key.split(/(\*\*\/|\*\*|\*)/).map((t) => (t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : escapeRe(t))).join('') + '$')
          if (re.test(entry)) hitsEntry = true
          const md = conf?.maxDuration
          if (md !== undefined && !(Number.isInteger(md) && md >= 1 && md <= 900)) fail(`${at}.functions["${key}"].maxDuration must be an integer between 1 and 900 seconds, got ${JSON.stringify(md)}`)
        }
        if (!hitsEntry) fail(`${at}.functions has no key matching the entrypoint "${entry}"; the Hono service builds ONE function from the entrypoint, so this config never reaches it (same silent drop as audit P0-3)`)
      }
    }

    // repo: the browser calls this API, so it must sit behind an object-form rewrite (string
    // destinations are plain URLs, not services). A binding alone only makes it internal.
    if (!publicVia.has(name)) fail(`${at}: no rewrite with a { "service": "${name}" } destination targets it, so the API is unreachable from the browser; add { "source": "/api/(.*)", "destination": { "service": "${name}" } } before the catch-all`)

    // repo: every route is registered WITH the /api prefix, so the path the router sees must keep it.
    if (exists(root, 'src/routes.ts')) {
      const paths = [...text(root, 'src/routes.ts').matchAll(/^ {2}\['\w+', '([^']+)',/gm)].map((m) => m[1])
      const prefixes = (publicVia.get(name) ?? []).map((s) => s.split(/[(:*?]/)[0])
      if (prefixes.length) {
        const stray = paths.filter((p) => !prefixes.some((x) => p.startsWith(x)))
        if (stray.length) fail(`${at}: ${stray.length} route(s) are not under the public rewrite prefix ${prefixes.map((x) => `"${x}"`).join(' / ')}, e.g. ${stray.slice(0, 3).join(', ')}`)
      }
      const sample = paths[0]
      for (const r of Array.isArray(svc.routes) ? svc.routes : []) {
        for (const t of Array.isArray(r?.transforms) ? r.transforms : []) {
          if (t?.type !== 'request.path' || typeof r.src !== 'string' || !sample) continue
          let m = null
          try { m = sample.replace(/:\w+/g, 'x').match(new RegExp('^' + r.src + '$')) } catch { /* unparsable src: Vercel will reject it */ }
          if (!m) continue
          const seen = String(t.args).replace(/\$(\d+)/g, (_, n) => m[Number(n)] ?? '')
          if (seen !== sample.replace(/:\w+/g, 'x')) fail(`${at}.routes: the request.path transform on "${r.src}" turns "${sample.replace(/:\w+/g, 'x')}" into "${seen}", but the router registers routes WITH the prefix; every request would 404. Remove the transform (Vercel keeps the original path)`)
        }
      }
    }
  }

  // (e) repo: a Next build script that finalizes the standalone bundle cannot run on Vercel.
  if (framework === 'nextjs' && pkg) {
    const build = pkg.scripts?.build ?? ''
    if (/finalize-standalone/.test(build)) {
      const cmd = svc.buildCommand
      const m = typeof cmd === 'string' ? cmd.match(/^(?:pnpm|npm|yarn)(?:\s+run)?\s+([\w:.-]+)$/) : null
      if (typeof cmd !== 'string') fail(`${at}.buildCommand is required: ${root}/package.json "build" ends in finalize-standalone, which exits 1 on Vercel (output: standalone is skipped there). Use "pnpm run build:vercel"`)
      else if (/finalize-standalone/.test(cmd)) fail(`${at}.buildCommand runs finalize-standalone, which exits 1 on Vercel`)
      else if (m) {
        const script = pkg.scripts?.[m[1]]
        if (script === undefined) fail(`${at}.buildCommand runs script "${m[1]}", which ${root}/package.json does not define`)
        else if (/finalize-standalone/.test(script)) fail(`${at}.buildCommand runs "${m[1]}", which still ends in finalize-standalone`)
      }
    }
  }
}

// catch-all must reach the Next service; hono must be reachable.
{
  const last = rewrites.at(-1)
  const lastService = isObj(last?.destination) ? last.destination.service : undefined
  const nextServices = names.filter((n) => info[n]?.framework === 'nextjs')
  if (nextServices.length && last && CATCH_ALL.test(last.source) && !nextServices.includes(lastService)) {
    fail(`vercel.json: the catch-all "${last.source}" must target the Next.js service (${nextServices.join(', ')}), not "${lastService}"`)
  }
  if (nextServices.length && !(last && CATCH_ALL.test(last.source))) {
    fail('vercel.json: add a catch-all rewrite last ("/(.*)" to the Next.js service), or the pages are not served')
  }
}

// ── (h) bindings ─────────────────────────────────────────────────────────────
const bindingTargets = new Set()
const envOwner = new Map() // env → { caller, service }
const bindingEnvs = []
const envExamples = ['.env.example', ...names.flatMap((n) => (info[n] ? [`${info[n].root}/.env.example`] : []))].filter((p) => exists(p))
for (const name of names) {
  const svc = services[name]
  const b = isObj(svc) ? svc.bindings : undefined
  if (b === undefined) continue
  const at = `services.${name}.bindings`
  if (!Array.isArray(b)) {
    fail(`${at} must be an array`)
    continue
  }
  const seenEnv = new Set()
  b.forEach((x, i) => {
    const w = `${at}[${i}]`
    if (!isObj(x)) return fail(`${w} must be an object`)
    const keys = Object.keys(x).sort().join(',')
    if (keys !== 'env,format,service,type') return fail(`${w} needs exactly the four fields type, service, format, env (has: ${Object.keys(x).join(', ') || 'none'})`)
    if (x.type !== 'service') fail(`${w}.type must be "service"`)
    if (x.format !== 'url') fail(`${w}.format must be "url"`)
    if (typeof x.service !== 'string' || !(x.service in services)) fail(`${w}.service "${x.service}" is not declared in \`services\``)
    else if (x.service === name) fail(`${w}: a service cannot bind to itself`)
    else bindingTargets.add(x.service)
    if (typeof x.env !== 'string' || !ENV_RE.test(x.env)) return fail(`${w}.env must match ${ENV_RE}`)
    if (x.env.startsWith('NEXT_PUBLIC_')) fail(`${w}.env "${x.env}" must not start with NEXT_PUBLIC_: that prefix is inlined at BUILD time, where bindings do not resolve`)
    if (seenEnv.has(x.env)) fail(`${w}.env "${x.env}" is declared twice on "${name}"`)
    seenEnv.add(x.env)
    const prev = envOwner.get(x.env)
    if (prev && prev.service !== x.service) fail(`${w}.env "${x.env}" already points at "${prev.service}" (on "${prev.caller}"); one name cannot mean two targets`)
    envOwner.set(x.env, { caller: name, service: x.service })
    bindingEnvs.push({ env: x.env, caller: name })

    // Vercel injects the variable; setting it anywhere ourselves shadows or conflicts with it.
    for (const f of envExamples) {
      if (new RegExp(`^\\s*#?\\s*${x.env}\\s*=`, 'm').test(text(f))) fail(`${f} sets ${x.env}; Vercel injects binding variables, never set one yourself`)
    }
    for (const n of names) {
      const cfgFile = info[n] && exists(info[n].root, 'src/config.ts') ? `${info[n].root}/src/config.ts` : null
      if (cfgFile && new RegExp(`^\\s*${x.env}\\s*:`, 'm').test(text(cfgFile))) fail(`${cfgFile} declares ${x.env} in its env schema; a binding variable is injected, not configured`)
    }
    for (const k of [...Object.keys(isObj(cfg.env) ? cfg.env : {}), ...Object.keys(isObj(cfg.build?.env) ? cfg.build.env : {})]) {
      if (k === x.env) fail(`vercel.json sets ${k} in \`env\`/\`build.env\`; Vercel injects binding variables, never set one yourself`)
    }

    // A binding nobody reads is dead config; one read in middleware does not resolve there.
    const callerRoot = info[name]?.root
    if (callerRoot) {
      const files = sourceFiles(callerRoot)
      const reads = new RegExp(`\\b${x.env}\\b`)
      if (!files.some((f) => reads.test(text(callerRoot, f)))) warn(`${w}: ${x.env} is never read in ${callerRoot}; a binding with no consumer is dead config`)
      const middleware = files.filter((f) => /^(?:src\/)?(?:proxy|middleware)\.[cm]?[jt]s$/.test(f))
      for (const f of middleware) {
        if (reads.test(text(callerRoot, f))) fail(`${callerRoot}/${f} reads ${x.env}, but bindings do not resolve in middleware / the Next proxy; read the public origin instead`)
      }
    }
  })
}
for (const k of Object.keys(isObj(cfg.env) ? cfg.env : {}).concat(Object.keys(isObj(cfg.build?.env) ? cfg.build.env : {}))) {
  if (k === 'NEXT_PUBLIC_API_BASE' || k === 'COOKIE_DOMAIN') {
    fail(`vercel.json sets ${k}: leave it UNSET on Vercel (single origin: next.config.ts defaults NEXT_PUBLIC_API_BASE to "", and gate cookies must stay host-only)`)
  }
}

// ── (g) reachability ─────────────────────────────────────────────────────────
for (const n of names) {
  if (!publicVia.has(n) && !bindingTargets.has(n)) warn(`services.${n} is neither the target of a rewrite (public) nor of a binding (internal); it is dead`)
}

// ── report ───────────────────────────────────────────────────────────────────
function finish() {
  for (const w of warnings) console.warn(`WARN  ${w}`)
  if (errors.length) {
    for (const e of errors) console.error(`FAIL  ${e}`)
    console.error(`\n${errors.length} problem(s) in vercel.json (docs: https://vercel.com/docs/services)`)
    process.exit(1)
  }
  const svcs = names
    .map((n) => `${n}: ${info[n]?.framework ?? '?'} @ ${info[n]?.root ?? '?'}, ${publicVia.has(n) ? `public via ${publicVia.get(n).join(' ')}` : 'internal'}`)
    .join('; ')
  console.log(`vercel config ok: ${names.length} services (${svcs}), ${rewrites.length} rewrites, ${bindingEnvs.length} bindings`)
}
finish()
