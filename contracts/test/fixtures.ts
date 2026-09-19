/**
 * Shared deploy + flow fixtures for the OpenLance test suite.
 *
 *  - `deployWithEoaOwner()`  — proxies owned directly by the deployer EOA, so
 *    owner-only calls (register, setFeeBps, upgrades) can be made directly.
 *  - `deployWithTimelockOwner()` — the production topology: a TimelockController
 *    owns both proxies, registry wired to escrow through the timelock.
 *
 * The default test parameters are small (min stake 0.1 ETH, dispute fee 0.05 ETH,
 * 2-minute windows) so the multi-arbiter flows are cheap and fast.
 */
import hardhat, { network } from "hardhat";
import { encodeFunctionData, parseEther, keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import type { Address } from "viem";

const ZERO32 = `0x${"00".repeat(32)}` as Address;

export const MIN_STAKE = parseEther("0.1");
export const MIN_SCORE = 50n;
export const DISPUTE_FEE = parseEther("0.05");
export const COMMIT_WINDOW = 120n;
export const REVEAL_WINDOW = 120n;
export const APPEAL_WINDOW = 600n;
/** Time-based staking rules (seconds) — short so tests can warp time cheaply. */
export const MIN_STAKE_DURATION = 3600n; // 1h
export const UNSTAKE_COOLDOWN = 1800n; // 30m

// One shared connection for the whole test run. Creating a new connection per
// fixture (or per call) spawns an independent EDR instance, so reads against a
// contract deployed on another connection see stale/empty state.
export const connection = await network.create();

async function upgradesApi() {
  const { upgrades } = await import("@openzeppelin/hardhat-upgrades/viem");
  return upgrades(hardhat as never, connection as never);
}

export async function deployWithEoaOwner() {
  const { viem, networkHelpers } = connection;
  // 10 wallet clients available by default on EDR; we grab as many as we can.
  const wallets = await viem.getWalletClients();
  const [deployer, client, freelancer, ...rest] = wallets;
  const owner = deployer.account.address;
  const treasury = deployer.account.address;

  const up = await upgradesApi();
  const registry = await up.deployProxy(
    "ArbiterRegistry",
    ["OpenLance Arbiter", "OLANCE", owner, MIN_STAKE, MIN_SCORE, treasury, MIN_STAKE_DURATION, UNSTAKE_COOLDOWN],
    { kind: "uups" },
  );
  const escrow = await up.deployProxy(
    "Escrow",
    [registry.address, owner, 250, DISPUTE_FEE, treasury, COMMIT_WINDOW, REVEAL_WINDOW, APPEAL_WINDOW],
    { kind: "uups" },
  );

  await registry.write.setEscrow([escrow.address], { account: deployer.account });

  return {
    viem,
    networkHelpers,
    registry: registry as any,
    escrow: escrow as any,
    deployer,
    client,
    freelancer,
    arbiters: rest, // candidate arbiter wallets
    outsider: rest[rest.length - 1],
    owner,
    treasury,
    up,
  };
}

export async function deployWithTimelockOwner() {
  const { viem, networkHelpers } = connection;
  const wallets = await viem.getWalletClients();
  const [deployer, client, freelancer, ...rest] = wallets;
  const owner = deployer.account.address;
  const treasury = deployer.account.address;

  const timelock = await viem.deployContract("OpenLanceTimelock", [0n, [owner], [owner], owner]);

  const up = await upgradesApi();
  const registry = await up.deployProxy(
    "ArbiterRegistry",
    ["OpenLance Arbiter", "OLANCE", timelock.address, MIN_STAKE, MIN_SCORE, treasury, MIN_STAKE_DURATION, UNSTAKE_COOLDOWN],
    { kind: "uups" },
  );
  const escrow = await up.deployProxy(
    "Escrow",
    [registry.address, timelock.address, 250, DISPUTE_FEE, treasury, COMMIT_WINDOW, REVEAL_WINDOW, APPEAL_WINDOW],
    { kind: "uups" },
  );

  const calldata = encodeFunctionData({
    abi: registry.abi,
    functionName: "setEscrow",
    args: [escrow.address],
  });
  await timelock.write.schedule([registry.address, 0n, calldata, ZERO32, ZERO32, 0n]);
  await timelock.write.execute([registry.address, 0n, calldata, ZERO32, ZERO32]);

  return {
    viem,
    networkHelpers,
    timelock,
    registry: registry as any,
    escrow: escrow as any,
    deployer,
    client,
    freelancer,
    arbiters: rest,
    outsider: rest[rest.length - 1],
    owner,
    treasury,
    up,
  };
}

/** Execute an onlyOwner call via the timelock (delay 0 in tests). */
export async function viaTimelock(
  timelock: any,
  target: Address,
  abi: readonly unknown[],
  functionName: string,
  args: unknown[],
) {
  const calldata = encodeFunctionData({ abi: abi as never, functionName, args } as never);
  await timelock.write.schedule([target, 0n, calldata, ZERO32, ZERO32, 0n]);
  await timelock.write.execute([target, 0n, calldata, ZERO32, ZERO32]);
}

/** Register `n` arbiters (self-register with stake) and return their addresses.
 *  Also advances chain time past `minStakeDuration` so the freshly-registered
 *  arbiters are immediately selectable — most tests care about dispute flows,
 *  not the cooldown delay itself (that has dedicated coverage in registry.ts). */
export async function registerArbiters(
  registry: any,
  wallets: { account: { address: `0x${string}` } }[],
  n: number,
  stake: bigint = MIN_STAKE,
  { warp = true }: { warp?: boolean } = {},
): Promise<`0x${string}`[]> {
  const addrs: `0x${string}`[] = [];
  for (let i = 0; i < n; i++) {
    const w = wallets[i]!;
    await registry.write.registerArbiter({ value: stake, account: w.account });
    addrs.push(w.account.address);
  }
  if (warp && n > 0) await connection.networkHelpers.time.increase(Number(MIN_STAKE_DURATION) + 1);
  return addrs;
}

/** keccak256(abi.encode(outcome, salt, arbiter, milestoneId, round)) */
export function commitHash(outcome: number, salt: `0x${string}`, arbiter: `0x${string}`, milestoneId: bigint, round: number) {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint8,bytes32,address,uint256,uint8"), [
      outcome,
      salt,
      arbiter,
      milestoneId,
      round,
    ]),
  );
}

export function randSalt(seed: number): `0x${string}` {
  return keccak256(encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(seed)]));
}

export { ZERO32 };

// ── Typed views (viem returns `unknown` for struct returns via the plugin) ────

export type MilestoneView = {
  ref: `0x${string}`;
  client: `0x${string}`;
  freelancer: `0x${string}`;
  amount: bigint;
  feeBps: number;
  status: number;
};

export type DisputeView = {
  openedBy: `0x${string}`;
  openedAt: bigint;
  fee: bigint;
  round: number;
  appealCount: number;
  settledArbiters: readonly `0x${string}`[];
  settledOutcome: number;
};

export type RoundView = {
  arbiters: readonly `0x${string}`[];
  arbiterCount: number;
  commitCount: number;
  revealCount: number;
  tally: readonly number[];
  commitDeadline: bigint;
  revealDeadline: bigint;
  resolved: boolean;
  winningOutcome: number;
};

export async function getMilestone(escrow: any, id: bigint): Promise<MilestoneView> {
  return (await escrow.read.getMilestone([id])) as MilestoneView;
}

export async function getDispute(escrow: any, id: bigint): Promise<DisputeView> {
  return (await escrow.read.getDispute([id])) as DisputeView;
}

export async function getRound(escrow: any, id: bigint, round: number): Promise<RoundView> {
  const r = (await escrow.read.getRound([id, round])) as readonly unknown[];
  return {
    arbiters: r[0] as `0x${string}`[],
    arbiterCount: Number(r[1]),
    commitCount: Number(r[2]),
    revealCount: Number(r[3]),
    tally: (r[4] as number[]).map(Number),
    commitDeadline: r[5] as bigint,
    revealDeadline: r[6] as bigint,
    resolved: r[7] as boolean,
    winningOutcome: Number(r[8]),
  };
}
