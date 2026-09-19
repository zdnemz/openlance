/**
 * Deploy Escrow + ArbiterRegistry to the local anvil chain (chain 31337)
 * using the forge build artifacts — no forge binary needed at deploy time.
 *
 * Boot flow (scripts/dev-real.sh): anvil up → this script → .env written
 * → migrate → API starts in CHAIN_MODE=real → demo seed.
 *
 * Output: a single JSON line on stdout:
 *   {"escrow":"0x..","arbiterRegistry":"0x..","deployer":"0x..","chainId":31337}
 */
import { createPublicClient, createWalletClient, http, type Abi, type Hex } from 'viem'
import { anvil } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RPC = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545'
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil #0

const here = dirname(fileURLToPath(import.meta.url))
const artifact = (name: string) => {
  const p = resolve(here, '../../contracts/out', `${name}.sol`, `${name}.json`)
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object }
}

async function main() {
  const escrowArt = artifact('Escrow')
  const registryArt = artifact('ArbiterRegistry')

  const account = privateKeyToAccount(DEPLOYER_KEY)
  const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) })
  const walletClient = createWalletClient({ account, chain: anvil, transport: http(RPC) })

  const chainId = await publicClient.getChainId()
  if (chainId !== 31337) throw new Error(`expected chain 31337, got ${chainId}`)

  // 1. ArbiterRegistry(name, symbol, owner)
  const registryHash = await walletClient.deployContract({
    ...registryArt,
    functionName: 'constructor',
    args: ['OpenLance Arbiter', 'OLANCE', account.address],
    account,
  })
  const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: registryHash })
  const registryAddress = registryReceipt.contractAddress
  if (!registryAddress) throw new Error('registry deploy failed — no contract address')

  // 2. Escrow(arbiterRegistry, owner)
  const escrowHash = await walletClient.deployContract({
    ...escrowArt,
    functionName: 'constructor',
    args: [registryAddress, account.address],
    account,
  })
  const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowHash })
  const escrowAddress = escrowReceipt.contractAddress
  if (!escrowAddress) throw new Error('escrow deploy failed — no contract address')

  // 3. registry.setEscrow(escrow)
  const wireHash = await walletClient.writeContract({
    address: registryAddress,
    abi: registryArt.abi,
    functionName: 'setEscrow',
    args: [escrowAddress],
    account,
  })
  await publicClient.waitForTransactionReceipt({ hash: wireHash })

  const out = { escrow: escrowAddress, arbiterRegistry: registryAddress, deployer: account.address, chainId }
  writeFileSync(resolve(here, '../.anvil-deployment.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out))
}

main().catch((err) => {
  console.error('deploy-anvil failed:', err)
  process.exit(1)
})
