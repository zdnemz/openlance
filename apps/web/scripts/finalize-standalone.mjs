/**
 * Next.js `output: 'standalone'` does not copy `public/` or the built static
 * assets — they must be placed inside the standalone tree by hand, or a
 * production start serves HTML with no CSS/JS and no favicon.
 *
 * The standalone root is the monorepo root (outputFileTracingRoot), so the
 * server entry lands at `.next/standalone/apps/web/server.js` and assets go
 * alongside it. Run after `next build`.
 */
import { cp, mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const STANDALONE = join(WEB, '.next', 'standalone', 'apps', 'web')

const exists = async (p) => access(p, constants.F_OK).then(() => true, () => false)

if (!(await exists(STANDALONE))) {
  console.error(`[finalize] ${STANDALONE} not found — did \`next build\` run?`)
  process.exit(1)
}

for (const [from, to] of [
  [join(WEB, '.next', 'static'), join(STANDALONE, '.next', 'static')],
  [join(WEB, 'public'), join(STANDALONE, 'public')],
]) {
  if (!(await exists(from))) {
    console.error(`[finalize] missing ${from}`)
    process.exit(1)
  }
  await mkdir(join(to, '..'), { recursive: true })
  // `recursive: true, force: true` — cp throws EEXIST on a nested target otherwise.
  await cp(from, to, { recursive: true, force: true })
  console.log(`[finalize] ${from} → ${to}`)
}
