import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  unpackMint,
  getExtensionTypes,
  getTransferFeeConfig,
  getTransferHook,
  getPermanentDelegate,
  getDefaultAccountState,
} from '@solana/spl-token';
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
  /** True when the mint belongs to Token-2022 rather than the classic program. */
  token2022?: boolean;
  /**
   * Token-2022 extensions that can stop or tax a sale.
   *
   * The two authorities above are the whole story for a classic SPL mint, and
   * only half of it for a Token-2022 one: that program lets a deployer attach
   * behaviour to the mint itself. A transfer hook runs arbitrary code on every
   * transfer and can simply refuse yours; a transfer fee is the sell tax people
   * associate with EVM honeypots; a permanent delegate can move tokens out of
   * your wallet without asking. A mint carrying any of these can show both
   * authorities revoked and still be a trap.
   */
  traps?: string[];
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

/**
 * Read the Token-2022 extensions that can prevent or tax a sale.
 *
 * Only the ones a holder can be hurt by. Metadata pointers and group
 * membership are extensions too and are nobody's problem.
 */
export function parseTrapExtensions(data: Uint8Array, owner: string): string[] {
  if (owner !== TOKEN_2022_PROGRAM_ID.toBase58()) return [];

  const traps: string[] = [];
  try {
    const mint = unpackMint(PublicKey.default, { data: Buffer.from(data), owner: TOKEN_2022_PROGRAM_ID } as never, TOKEN_2022_PROGRAM_ID);

    const fee = getTransferFeeConfig(mint);
    if (fee) {
      const bps = Math.max(
        fee.newerTransferFee.transferFeeBasisPoints,
        fee.olderTransferFee.transferFeeBasisPoints,
      );
      // a fee of zero is declared but harmless; the authority to raise it is not
      traps.push(
        bps > 0
          ? `Transfer fee of ${(bps / 100).toFixed(2)}% is taken on every trade`
          : 'A transfer fee is configured at 0% and can be raised at any time',
      );
    }

    if (getTransferHook(mint)) {
      traps.push('A transfer hook runs on every trade and can refuse yours');
    }
    if (getPermanentDelegate(mint)) {
      traps.push('A permanent delegate can move these tokens out of your wallet');
    }

    const state = getDefaultAccountState(mint);
    // 2 is AccountState::Frozen — new holders start unable to transfer
    if (state && state.state === 2) {
      traps.push('New token accounts are created frozen by default');
    }

    if (getExtensionTypes(mint.tlvData).includes(ExtensionType.NonTransferable)) {
      traps.push('This token is non-transferable and can never be sold');
    }
  } catch {
    // an unparseable extension block is itself worth saying out loud
    return ['Token-2022 extensions could not be read'];
  }

  return traps;
}

/** Returns null when the account cannot be read — never a false "revoked". */
export async function getMintAuthorities(mint: string): Promise<MintAuthorities | null> {
  try {
    const info = await retry(() => rpc().getAccountInfo(new PublicKey(mint)), { attempts: 2 });
    if (!info) return null;

    const base = parseMintAccount(info.data);
    if (!base) return null;

    const owner = info.owner.toBase58();
    const token2022 = owner === TOKEN_2022_PROGRAM_ID.toBase58();
    return { ...base, token2022, traps: parseTrapExtensions(info.data, owner) };
  } catch {
    return null;
  }
}
