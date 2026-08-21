import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';

// subscribe to brand-new tokens, then race trades on them (guaranteed on-curve)
const pp = new Map<string, number>(); const hel = new Map<string, number>();
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_KEY}`, { commitment: 'confirmed' });
const ids: number[] = [];
const tracked = new Set<string>();
const traders = new Set<string>();

const ws = new WebSocket('wss://pumpportal.fun/api/data');
ws.on('open', () => ws.send(JSON.stringify({ method: 'subscribeNewToken' })));
ws.on('message', async (d) => {
  try {
    const m = JSON.parse(d.toString());
    if (m.txType === 'create' && m.mint && tracked.size < 6) {
      tracked.add(m.mint);
      ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [m.mint] }));
      ids.push(await conn.onLogs(new PublicKey(m.mint), (l) => { if (!l.err && !hel.has(l.signature)) hel.set(l.signature, Date.now()); }, 'confirmed'));
    } else if (m.signature && m.txType && m.txType !== 'create') {
      if (!pp.has(m.signature)) pp.set(m.signature, Date.now());
      if (m.traderPublicKey) traders.add(m.traderPublicKey);
    }
  } catch {}
});

console.log('watching new launches for 40s…');
await new Promise(r => setTimeout(r, 40000));
ws.close(); for (const id of ids) await conn.removeOnLogsListener(id).catch(()=>{});

console.log(`tracked ${tracked.size} new tokens; pumpportal ${pp.size} trades, helius ${hel.size}, distinct traders seen: ${traders.size}`);
const both = [...pp.keys()].filter(s => hel.has(s));
console.log(`both saw ${both.length}`);
if (both.length) {
  const deltas = both.map(s => hel.get(s)! - pp.get(s)!).sort((a,b)=>a-b);
  console.log(`pumpportal earlier: ${deltas.filter(d=>d>0).length}/${both.length}`);
  console.log(`median gap: ${deltas[Math.floor(deltas.length/2)]}ms (positive = pumpportal earlier)`);
}
// fields available per trade event — matters for skipping the getParsedTransactions read
process.exit(0);
