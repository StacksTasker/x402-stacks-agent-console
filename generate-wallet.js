#!/usr/bin/env node
/**
 * Generate a Stacks testnet wallet and save keypair to wallets/ folder.
 * Usage:
 *   node generate-wallet.js                    # generates 1 testnet wallet
 *   node generate-wallet.js "Agent Name"       # generates with label
 *   node generate-wallet.js --all              # generates for all 3 default agents
 *   node generate-wallet.js --mainnet          # generates 1 mainnet wallet (SP-prefix)
 *   node generate-wallet.js --all --mainnet    # generates all 3 on mainnet
 */

const { generateSecretKey, generateWallet } = require('@stacks/wallet-sdk');
const { getAddressFromPrivateKey } = require('@stacks/transactions');
const fs = require('fs');
const path = require('path');

const WALLETS_DIR = path.join(__dirname, 'wallets');

function ensureWalletsDir() {
  if (!fs.existsSync(WALLETS_DIR)) {
    fs.mkdirSync(WALLETS_DIR, { recursive: true });
  }
}

async function createWallet(label, networkName) {
  const isMainnet = networkName === 'mainnet';
  const secretKey = generateSecretKey();
  const wallet = await generateWallet({ secretKey, password: '' });
  const account = wallet.accounts[0];
  const privateKey = account.stxPrivateKey;
  const address = getAddressFromPrivateKey(privateKey, isMainnet ? 'mainnet' : 'testnet');

  const keypair = {
    label: label || 'Stacks Agent',
    network: isMainnet ? 'stacks-mainnet' : 'stacks-testnet',
    address,
    privateKey,
    secretKey,
    created: new Date().toISOString(),
  };

  ensureWalletsDir();
  const filename = `wallet-${address.slice(0, 10)}.json`;
  const filepath = path.join(WALLETS_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(keypair, null, 2));

  console.log(`  Created: ${address}`);
  console.log(`  Label:   ${label || 'Stacks Agent'}`);
  console.log(`  Saved:   wallets/${filename}`);
  console.log('');

  return keypair;
}

async function main() {
  const args = process.argv.slice(2);
  const isMainnet = args.includes('--mainnet');
  const isAll = args.includes('--all');
  const networkName = isMainnet ? 'mainnet' : 'testnet';
  const netLabel = isMainnet ? 'mainnet (SP-prefix)' : 'testnet (ST-prefix)';

  if (isAll) {
    console.log(`Generating ${netLabel} wallets for all default agents...\n`);
    const agents = [
      'LOBSTER - TASK CREATOR AGENT',
      'MONKEY - TASK COMPLETER AGENT',
      'OCTOPUS - TASK COMPLETER AGENT',
    ];
    const results = [];
    for (const name of agents) {
      console.log(`[${name}]`);
      const kp = await createWallet(name, networkName);
      results.push(kp);
    }
    const summary = results.map(r => `${r.label}: ${r.address}`).join('\n');
    console.log('--- Summary ---');
    console.log(summary);
    console.log('\nAll keypairs saved to wallets/ folder (gitignored).');
  } else {
    const label = args.find(a => !a.startsWith('--')) || 'Stacks Agent';
    console.log(`Generating Stacks ${netLabel} wallet...\n`);
    console.log(`[${label}]`);
    await createWallet(label, networkName);
    console.log('Keypair saved to wallets/ folder (gitignored).');
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
