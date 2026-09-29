/**
 * Self-check for the KV string contract (run: pnpm check:kv).
 *
 * `Kv.get` returns a raw string and its callers own serialization (cache.ts and
 * sponsorship.ts JSON.parse what they stored). Upstash auto-deserializes by
 * default, so the Redis client must be built with that off — otherwise a
 * stored object comes back as an object and the caller's parse throws.
 *
 * No network: the client's transport is stubbed, so the real Upstash
 * deserializer runs against a fixed stored value.
 */
import { Redis } from '@upstash/redis'

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  if (!ok) { console.error(`✗ ${name} ${extra}`); failures++ }
  else console.log(`✓ ${name}`)
}

/**
 * GET of `stored` through a real Upstash client with a stub transport. The
 * client auto-pipelines reads, so the stub answers the pipeline path with the
 * batch shape Upstash returns.
 */
async function redisGet(stored: string, opts: Record<string, unknown> = {}): Promise<unknown> {
  const redis = new Redis({ url: 'https://stub.invalid', token: 'stub', ...opts })
  const client = (redis as unknown as { client: { request: (req: { path?: string[] }) => Promise<unknown> } }).client
  client.request = async (req) =>
    req.path?.[0] === 'pipeline' ? [{ result: stored, error: null }] : { result: stored, error: null }
  return redis.get('read:overview')
}

// The config kv.ts builds its client with.
const KV_CLIENT_OPTS = { automaticDeserialization: false }

// 1. Object payload (the `read:overview` "…[object Object]…" bypass) round-trips
//    as text, so cache.ts's JSON.parse gets its string back.
const objHit = await redisGet('{"jobs":3,"gigs":1}', KV_CLIENT_OPTS)
check('object payload stays a string', typeof objHit === 'string', `got ${typeof objHit}`)
check('object payload re-parses', safe(() => JSON.parse(objHit as string)) && (JSON.parse(objHit as string) as { jobs: number }).jobs === 3)

// 2. Empty array payload (the `read:arbiters:list` "Unexpected end of JSON input"
//    bypass, where JSON.parse([]) stringifies to ""). Same payload, different
//    reported error — one root cause.
const arrHit = await redisGet('[]', KV_CLIENT_OPTS)
check('empty array payload stays a string', typeof arrHit === 'string', `got ${typeof arrHit}`)
check('empty array payload re-parses', Array.isArray(JSON.parse(arrHit as string)))

// 3. Non-JSON values (SIWE nonce timestamps, addresses, block numbers) are
//    unaffected — they always came back verbatim.
check('plain string round-trips', (await redisGet('2026-09-28T15:18:45.651Z', KV_CLIENT_OPTS)) === '2026-09-28T15:18:45.651Z')

// 4. The flag is load-bearing: Upstash's default hands back parsed objects,
//    which is exactly what made the double parse throw.
check('default config would break the contract', typeof (await redisGet('{"jobs":3}')) !== 'string')

function safe(fn: () => unknown): boolean {
  try { fn(); return true } catch { return false }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll KV checks passed')
