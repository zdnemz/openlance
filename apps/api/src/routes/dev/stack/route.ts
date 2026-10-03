/**
 * Dev-only stack control: status + (re)spawn of the anvil chain stack.
 *
 * This route supervises *other* processes (anvil + contracts, see
 * scripts/anvil/dev-real.sh). It used to be safe by accident: it lived in the
 * Next.js dev server, which only ever runs on a developer's machine. Now that
 * the API is a service that gets deployed, that accident is gone — an
 * unauthenticated endpoint that spawns a shell is a remote-code-execution
 * hole. So it refuses to run outside development, explicitly.
 */
import { spawn } from 'node:child_process'
import { openSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { route } from '../../../lib/route.ts'
import { Errors } from '../../../lib/errors.ts'

/**
 * Repo root, derived from this file's location rather than process.cwd():
 * the service runs with cwd=apps/api, but the anvil tooling lives at the root.
 * apps/api/src/routes/dev/stack/ → 6 levels up.
 */
const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const ANVIL_DIR = resolve(ROOT, 'scripts/anvil')

/** Guard: this process is a service, so dev-only side effects must be explicit. */
function requireDev() {
  // Explicit opt-in: an unset NODE_ENV must not expose a process-spawning route.
  if (process.env.NODE_ENV !== 'development') throw Errors.notFound('Route')
}

async function status() {
  const chain = await fetch('http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
    signal: AbortSignal.timeout(1500),
  })
    .then((r) => r.ok)
    .catch(() => false)
  return { api: true, chain, anvil: existsSync(ANVIL_DIR) }
}

export const GET = route(async () => {
  requireDev()
  return Response.json(await status())
})

export const POST = route(async (request) => {
  requireDev()
  const force = new URL(request.url).searchParams.get('force') === '1'
  const current = await status()
  if (!force && current.chain) {
    return Response.json({ ...current, spawned: false, reason: 'chain healthy' })
  }
  if (force) {
    // Authoritative teardown first: concurrent orchestrators crossfire pkills.
    await new Promise<void>((resolve) => {
      const killer = spawn('bash', ['-c', "pkill -f 'dev-real.sh' 2>/dev/null; sleep 2; true"], { stdio: 'ignore' })
      killer.on('exit', () => resolve())
    })
  }
  const logPath = resolve(ANVIL_DIR, '.state', 'stack.log')
  mkdirSync(resolve(ANVIL_DIR, '.state'), { recursive: true })
  const out = openSync(logPath, 'a')
  const child = spawn('bash', [resolve(ANVIL_DIR, 'dev-real.sh')], {
    cwd: ANVIL_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PATH: `${resolve(ROOT, '.foundry/bin')}:${process.env.PATH ?? ''}` },
  })
  child.unref()
  return Response.json({ spawned: true, pid: child.pid, note: 'anvil chain stack only' })
})
