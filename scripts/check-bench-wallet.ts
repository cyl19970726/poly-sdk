#!/usr/bin/env npx tsx
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

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

const RPC = 'https://rpc.ankr.com/polygon/0ab696dc5d079a53ee2ed5c522d272a3f6df55c2de25a4d6bd250637fec93de5';
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  console.log('Address:', wallet.address);

  // MATIC balance
  const maticBal = await provider.getBalance(wallet.address);
  console.log('MATIC:', ethers.utils.formatEther(maticBal));

  // USDC.e balance
  const erc20 = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
  const usdcBal = await erc20.balanceOf(wallet.address);
  console.log('USDC.e:', ethers.utils.formatUnits(usdcBal, 6));

  // Check CTF token balances for winning positions
  const ctf = new ethers.Contract(CTF, [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
  ], provider);

  const tokenIds = [
    { label: 'BTC 12:30AM Up', id: '83651927321852258446192394079030986561416354179345942849733851844119148065434' },
    { label: 'BTC 11:05AM Up', id: '95671777062175290166411910269806684494289536326504010755297289276804300598037' },
    { label: 'BTC 12:40AM Up', id: '60007937153206455041644632694737234306050630347418531160031964856596877256463' },
    { label: 'BTC 10:50AM Up', id: '60165666272540832895218077171148660416729758041462725036054152633889506223155' },
  ];

  console.log('\nCTF Token Balances:');
  for (const t of tokenIds) {
    const bal = await ctf.balanceOf(wallet.address, t.id);
    console.log(`  ${t.label}: ${ethers.utils.formatUnits(bal, 6)}`);
  }
}

main().catch(console.error);
