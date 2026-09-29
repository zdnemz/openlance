/**
 * Self-check for the response envelope (run: pnpm check:envelope).
 *
 * `route()` wraps handler return values in `{ data }` unless the handler built
 * a Response itself (status, cookies, 201). That branch check is invisible to
 * `app.request()`: the global `Response` is only swapped for @hono/node-server's
 * wrapper once the server boots, so a bug in it passes every in-process test and
 * only shows up on a real socket — as a `{"data":{}}` body (a Response stringifies
 * to `{}`), which is how login ended up handing the client no token.
 *
 * So this boots the real server on an ephemeral port and asserts a route that
 * returns its own Response keeps its body. No DB, no wallet, no auth.
 */
import { serve } from '@hono/node-server'
import app from '../src/app.ts'

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  if (!ok) { console.error(`✗ ${name} ${extra}`); failures++ }
  else console.log(`✓ ${name}`)
}

const address = '0x000000000000000000000000000000000000dEaD'
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, async (info) => {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/auth/voucher-challenge?address=${address}`)
    const body = (await res.json()) as { data?: { enabled?: boolean; sessionId?: string } }

    check('status is 200', res.status === 200, `got ${res.status}`)
    // The regression's exact fingerprint: body present, envelope emptied.
    check('body is not an empty envelope', Object.keys(body.data ?? {}).length > 0, JSON.stringify(body))
    check('challenge payload survived', typeof body.data?.sessionId === 'string' && body.data.sessionId.startsWith('0x'))
  } catch (err) {
    check('request completed', false, err instanceof Error ? err.message : String(err))
  } finally {
    server.close()
    process.exit(failures > 0 ? 1 : 0)
  }
})
