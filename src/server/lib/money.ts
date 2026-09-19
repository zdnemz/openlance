/**
 * Money helpers. Amounts cross the API as decimal ETH strings ("0.05") and are
 * stored/transacted as wei (78-digit safe numeric columns, BigInt math).
 * wei(2^96) exceeds PG bigint, hence numeric(78,0) everywhere.
 */
import { formatEther, parseEther } from 'viem'

/** Accepts "1", "0.05", "12.345678901234567890" — rejects negatives, sci-notation, >18 decimals. */
export const ETH_AMOUNT = /^\d{1,18}(\.\d{1,18})?$/

export function isValidEthAmount(s: string): boolean {
  return ETH_AMOUNT.test(s) && BigInt(parseEther(s)) >= 0n
}

/** Decimal ETH string → wei string. Throws on invalid input. */
export function toWei(eth: string): string {
  if (!isValidEthAmount(eth)) throw new Error(`Invalid ETH amount: ${eth}`)
  return parseEther(eth).toString()
}

/** Wei string → decimal ETH string (display only; never used for math). */
export function toEth(wei: string): string {
  return formatEther(BigInt(wei))
}

export function sumWei(...amounts: string[]): string {
  return amounts.reduce((acc, a) => acc + BigInt(a), 0n).toString()
}

/** Fee in wei for a principal: floor(principal * bps / 10000). */
export function feeOf(principalWei: string, bps: number): string {
  return (BigInt(principalWei) * BigInt(bps) / 10_000n).toString()
}
