import { PublicKey } from '@solana/web3.js';
import { rpc } from '../chains/solana.js';
import { fetchJson, retry } from '../util.js';

/**
 * On-chain token metadata, for the window where a token exists but no indexer
 * knows about it yet — which is most of the first few minutes of a pump.fun
 * launch, and exactly when you want to look at it.
 */

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export interface TokenMetadata {
  name?: string;
  symbol?: string;
  uri?: string;
  imageUrl?: string;
  description?: string;
}

function metadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  );
  return pda;
}

/** Borsh strings here are length-prefixed but null-padded to a fixed width. */
function readString(buf: Buffer, offset: number): { value: string; next: number } {
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const raw = buf.subarray(start, start + len).toString('utf8');
  return { value: raw.replace(/\0+$/, '').trim(), next: start + len };
}

/**
 * Reads name/symbol/uri from the Metaplex metadata account.
 *
 * Retried, because this is the only name a token has in the minutes before an
 * indexer picks it up — losing it to one dropped connection leaves the card
 * showing "Unknown token" for exactly the launches worth looking at.
 */
export async function getOnChainMetadata(mint: string): Promise<TokenMetadata | null> {
  const info = await retry(() => rpc().getAccountInfo(metadataPda(new PublicKey(mint))), { attempts: 3 });
  if (!info) return null;

  const buf = Buffer.from(info.data);
  // key(1) + updateAuthority(32) + mint(32)
  let cursor = 65;
  if (buf.length < cursor + 4) return null;

  try {
    const name = readString(buf, cursor);
    const symbol = readString(buf, name.next);
    const uri = readString(buf, symbol.next);

    return { name: name.value, symbol: symbol.value, uri: uri.value };
  } catch {
    return null;
  }
}

/**
 * Follows the metadata URI to the off-chain JSON that holds the image. Most
 * pump.fun tokens host this on IPFS, which is slow and sometimes down — hence
 * the short timeout and the silent failure.
 */
export async function resolveOffChainMetadata(uri: string): Promise<{ imageUrl?: string; description?: string }> {
  if (!uri || !/^https?:\/\//i.test(uri)) return {};

  try {
    const json = await fetchJson<{ image?: string; description?: string }>(uri, { timeoutMs: 8_000 });
    const image = json.image;
    return {
      imageUrl: image && /^https?:\/\//i.test(image) ? image : undefined,
      description: json.description?.slice(0, 300),
    };
  } catch {
    return {};
  }
}

/** Full lookup: on-chain metadata plus the off-chain image behind its URI. */
export async function getTokenMetadata(mint: string): Promise<TokenMetadata | null> {
  const onChain = await getOnChainMetadata(mint).catch(() => null);
  if (!onChain) return null;

  if (onChain.uri) {
    const offChain = await resolveOffChainMetadata(onChain.uri);
    onChain.imageUrl = offChain.imageUrl;
    onChain.description = offChain.description;
  }

  return onChain;
}
