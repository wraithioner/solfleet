process.env.BOT_TOKEN='123:TEST'; process.env.OWNER_IDS='1'; process.env.DATA_DIR='./.netcheck-data';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
const { rpc, parseTokenAccountAmount } = await import('./src/chains/solana.js');
const { bondingCurvePda } = await import('./src/trade/curve.js');

const mint = 'DcYns4mN1A'; // placeholder replaced below
const profiles: any = await fetch('https://api.dexscreener.com/token-profiles/latest/v1').then(r=>r.json());
const live = profiles.filter((p:any)=>p.chainId==='solana' && p.tokenAddress?.endsWith('pump')).map((p:any)=>p.tokenAddress);

for (const m of live.slice(0,3)) {
  const mi = await rpc().getAccountInfo(new PublicKey(m));
  console.log(`${m.slice(0,10)}… mint owner program: ${mi?.owner.toBase58()}`);
  console.log(`   classic=${TOKEN_PROGRAM_ID.toBase58()}`);
  console.log(`   token22=${TOKEN_2022_PROGRAM_ID.toBase58()}`);
  const prog = mi?.owner ?? TOKEN_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(new PublicKey(m), bondingCurvePda(m), true, prog);
  const info = await rpc().getAccountInfo(ata);
  console.log(`   curve ATA under mint's own program: ${info ? `${info.data.length}B, amount=${parseTokenAccountAmount(info.data)}` : 'missing'}`);
  if (info) {
    const theirs = await rpc().getTokenAccountBalance(ata);
    console.log(`   rpc says ${theirs.value.amount} -> ${parseTokenAccountAmount(info.data).toString()===theirs.value.amount?'MATCH ✓':'MISMATCH ✗'}`);
  }
  break;
}
