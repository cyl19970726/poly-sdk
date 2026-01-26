#!/usr/bin/env npx tsx
/**
 * Polymarket Deposit Tool
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/deposit/deposit.ts [command] [amount]
 *
 * Commands:
 *   check              - Check balances and allowances (default)
 *   approve            - Set up all trading approvals
 *   swap <amount>      - Swap Native USDC to USDC.e
 *   deposit <amount>   - Deposit Native USDC to Polymarket
 *   status             - Check deposit status for your wallet
 *   addresses          - Get deposit addresses for your wallet
 */

import { OnchainService, depositUsdc, BridgeClient } from '../../src/index.js';
import { Wallet, providers } from 'ethers';

const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.POLY_PRIVKEY || '';

async function main() {
  if (!PRIVATE_KEY) {
    console.log('Usage: PRIVATE_KEY=0x... npx tsx scripts/deposit/deposit.ts [check|approve|swap|deposit] [amount]');
    process.exit(1);
  }

  const [command = 'check', amountStr] = process.argv.slice(2);
  const amount = amountStr ? parseFloat(amountStr) : 0;

  const onchain = new OnchainService({ privateKey: PRIVATE_KEY });
  const provider = new providers.JsonRpcProvider('https://polygon-rpc.com');
  const wallet = new Wallet(PRIVATE_KEY, provider);

  console.log(`\nWallet: ${onchain.getAddress()}\n`);

  switch (command) {
    case 'check': {
      const balances = await onchain.getTokenBalances();
      console.log('Balances:');
      console.log(`  MATIC:       ${balances.matic}`);
      console.log(`  Native USDC: ${balances.usdc}`);
      console.log(`  USDC.e:      ${balances.usdcE}`);

      const allowances = await onchain.checkAllowances();
      console.log(`\nTrading Ready: ${allowances.tradingReady ? '✓' : '✗'}`);
      if (allowances.issues.length > 0) {
        console.log('Issues:', allowances.issues.join(', '));
      }
      break;
    }

    case 'approve': {
      console.log('Setting up trading approvals...');
      const result = await onchain.approveAll();
      console.log(`Done. ${result.summary}`);
      break;
    }

    case 'swap': {
      if (amount <= 0) {
        console.log('Usage: swap <amount>');
        process.exit(1);
      }
      console.log(`Swapping ${amount} USDC → USDC.e...`);
      const result = await onchain.swap('USDC', 'USDC_E', amount.toString());
      console.log(`TX: ${result.transactionHash}`);
      console.log(`Received: ${result.amountOut} USDC.e`);
      break;
    }

    case 'deposit': {
      if (amount < 2) {
        console.log('Minimum deposit: $2');
        process.exit(1);
      }
      console.log(`Depositing ${amount} USDC to Polymarket...`);
      const result = await depositUsdc(wallet, amount, { token: 'NATIVE_USDC' });
      if (result.success) {
        console.log(`TX: ${result.txHash}`);
        console.log('Bridge will process in 1-5 minutes.');
      } else {
        console.log(`Error: ${result.error}`);
      }
      break;
    }

    case 'addresses': {
      const bridge = new BridgeClient();
      console.log('Getting deposit addresses...');
      const addresses = await bridge.createDepositAddresses(wallet.address);
      console.log('\nDeposit Addresses (send assets here to fund your Polymarket account):');
      console.log(`  EVM (Ethereum, Polygon, etc): ${addresses.address.evm}`);
      console.log(`  Solana:                       ${addresses.address.svm}`);
      console.log(`  Bitcoin:                      ${addresses.address.btc}`);
      break;
    }

    case 'status': {
      const bridge = new BridgeClient();
      console.log('Getting deposit status...');
      const addresses = await bridge.createDepositAddresses(wallet.address);
      const transactions = await bridge.getDepositStatus(addresses.address.evm);

      if (transactions.length === 0) {
        console.log('\nNo deposits found.');
        console.log('To deposit, send assets to your deposit address.');
        console.log(`Use: npx tsx scripts/deposit/deposit.ts addresses`);
      } else {
        console.log(`\nFound ${transactions.length} deposit(s):\n`);
        for (const tx of transactions.slice(0, 10)) {
          const date = new Date(tx.createdTimeMs).toLocaleString();
          const amountUsd = parseInt(tx.fromAmountBaseUnit) / 1e6;
          console.log(`  ${tx.status.padEnd(20)} | $${amountUsd.toFixed(2).padStart(10)} | ${date}`);
          console.log(`    ${BridgeClient.getStatusDescription(tx.status)}`);
          if (tx.txHash) {
            console.log(`    TX: ${tx.txHash}`);
          }
          console.log();
        }
      }
      break;
    }

    default:
      console.log('Unknown command. Use: check, approve, swap, deposit, status, addresses');
  }
}

main().catch(console.error);
