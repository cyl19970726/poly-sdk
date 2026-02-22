#!/usr/bin/env npx tsx
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Load .env
const envPath = path.resolve(import.meta.dirname || '.', '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

import { OnchainService } from '../src/services/onchain-service.js';

const RPC = 'https://rpc.ankr.com/polygon/0ab696dc5d079a53ee2ed5c522d272a3f6df55c2de25a4d6bd250637fec93de5';
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// All 4 BTC crypto markets — resolved with "Up" winning
// These are NegRisk markets
const markets = [
  {
    conditionId: '0xc5289283317c7da2ada99ff2a0609a40f3b4d9310fa4b0b164c384d49223a27b',
    label: 'BTC 12:30AM',
    tokenIds: {
      yesTokenId: '83651927321852258446192394079030986561416354179345942849733851844119148065434',
      noTokenId: '48227724425768652853897990349178719502008680507265536638706690939503419106796',
    },
  },
  {
    conditionId: '0x08e0d5787fe3bdb420029d0d6453cf593c0deb29779d23223543aa15f664d8ed',
    label: 'BTC 11:05AM',
    tokenIds: {
      yesTokenId: '95671777062175290166411910269806684494289536326504010755297289276804300598037',
      noTokenId: '43304689368085379931443305522016046059546739591718606630613650063020791263471',
    },
  },
  {
    conditionId: '0x0349e3539918bf74a67606ff9c6f51ac5f01a9df532dfbb203d43c26f2fc3ea7',
    label: 'BTC 12:40AM',
    tokenIds: {
      yesTokenId: '60007937153206455041644632694737234306050630347418531160031964856596877256463',
      noTokenId: '95563668955381646650928119476568967303474572631996104249416784034601363442415',
    },
  },
  {
    conditionId: '0xe57a17c77dba67e4665f3ad23ee177283077318b88f14a467d81e7e022ee0ac5',
    label: 'BTC 10:50AM',
    tokenIds: {
      yesTokenId: '60165666272540832895218077171148660416729758041462725036054152633889506223155',
      noTokenId: '56274213918059066171684362786753951518541462886553818332096600966043871089397',
    },
  },
];

async function main() {
  const onchain = new OnchainService({
    privateKey: process.env.PRIVATE_KEY!,
    rpcUrl: RPC,
  });

  for (const m of markets) {
    console.log(`Redeeming ${m.label} (${m.conditionId.slice(0, 12)}...)...`);
    try {
      // neg_risk=false for 15-min BTC crypto markets (confirmed via CLOB API)
      // Pass 'YES' not 'Up' — ctf-client hardcodes YES/NO for indexSet mapping
      // Up = yesTokenId = first outcome = indexSet [1] = 'YES' in ctf-client logic
      const result = await onchain.redeemByTokenIds(
        m.conditionId,
        m.tokenIds,
        'YES',     // 'YES' maps to indexSet [1] = first outcome (Up)
        false,     // NOT NegRisk — confirmed via CLOB API
      );
      console.log(`  TX: ${result.txHash}`);
      console.log(`  Redeemed: ${result.tokensRedeemed} USDC.e`);
    } catch (e: any) {
      console.log(`  Error: ${e.message?.slice(0, 120)}`);
    }
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const erc20 = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const bal = await erc20.balanceOf(wallet.address);
  console.log(`\nFinal Balance: ${ethers.utils.formatUnits(bal, 6)} USDC.e`);
}

main().catch(console.error);
