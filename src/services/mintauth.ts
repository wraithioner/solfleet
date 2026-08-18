import { PublicKey } from '@solana/web3.js';
import { rpc } from '../chains/solana.js';
import { retry } from '../util.js';

/**
 * The two authorities on an SPL mint, and what they mean for someone holding
 * the token.
 *
 * These are the first things worth knowing about a Solana token and the bot was
 * not reading them:
 *
 *  - **Freeze authority.** Whoever holds it can freeze any token account for
 *    this mint, including yours. A frozen account cannot transfer, which means
 *    you cannot sell — you watch the chart and can do nothing about it. There
 *    is no market signal for this; the price looks fine right up until it is
 *    used.
 *  - **Mint authority.** Whoever holds it can mint more supply at will and sell
 *    it into your liquidity. Concentration figures say nothing about supply
 *    that does not exist yet.
 *
 * A legitimate launch revokes both, which is why "revoked" is the reassuring
 * answer and "unknown" must never be shown as if it were.
 */
export interface MintAuthorities {
  /** Base58 address, or null when the authority has been revoked. */
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supplyRaw: bigint;
}

/**
 * Parse the 82-byte SPL mint account.
 *
 * Layout: mintAuthorityOption(4) || mintAuthority(32) || supply(8) ||
 * decimals(1) || isInitialized(1) || freezeAuthorityOption(4) ||
 * freezeAuthority(32). Token-2022 keeps these same 82 bytes and appends its
 * extensions after them, so the offsets hold for both programs.
 *
 * The `option` fields are the important subtlety: a zeroed option means the
 * authority is revoked, and the 32 bytes that follow are stale padding rather
 * than a real address. Reading the pubkey without checking the option first
 * reports a revoked mint as controlled by whoever launched it.
 */
export function parseMintAccount(data: Uint8Array): MintAuthorities | null {
  if (data.length < 82) return null;

  const buf = Buffer.from(data);
  const mintAuthorityOption = buf.readUInt32LE(0);
  const freezeAuthorityOption = buf.readUInt32LE(46);

  return {
    mintAuthority:
      mintAuthorityOption === 1 ? new PublicKey(buf.subarray(4, 36)).toBase58() : null,
    supplyRaw: buf.readBigUInt64LE(36),
    decimals: buf.readUInt8(44),
    freezeAuthority:
      freezeAuthorityOption === 1 ? new PublicKey(buf.subarray(50, 82)).toBase58() : null,
  };
}

/** Returns null when the account cannot be read — never a false "revoked". */
export async function getMintAuthorities(mint: string): Promise<MintAuthorities | null> {
  try {
    const info = await retry(() => rpc().getAccountInfo(new PublicKey(mint)), { attempts: 2 });
    if (!info) return null;
    return parseMintAccount(info.data);
  } catch {
    return null;
  }
}
