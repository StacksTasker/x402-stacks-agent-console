#!/usr/bin/env node
/**
 * Claim STX from the Hiro testnet faucet for agent wallets.
 *
 * Usage:
 *   node claim-faucet.js              # claim faucet for all 3 agents
 *   node claim-faucet.js --distribute # claim for LOBSTER only, then transfer 50 STX each to MONKEY & OCTOPUS
 */

const fs = require('fs');
const path = require('path');
const {
  makeSTXTokenTransfer,
  broadcastTransaction,
  AnchorMode,
} = require('@stacks/transactions');

const WALLETS_DIR = path.join(__dirname, 'wallets');
const HIRO_API = 'https://api.testnet.hiro.so';
const FAUCET_URL = `${HIRO_API}/extended/v1/faucets/stx`;
const TRANSFER_AMOUNT = 50; // STX to send to each secondary agent
const WAIT_SECS = 30;

// ── Wallet Loading ──────────────────────────────────────────

function loadWallets() {
  const files = fs.readdirSync(WALLETS_DIR).filter(f => f.endsWith('.json'));
  const wallets = {};
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(WALLETS_DIR, file), 'utf-8'));
    if (!data.address || !data.privateKey) continue;
    const label = (data.label || '').toUpperCase();
    if (label.includes('LOBSTER')) wallets.LOBSTER = data;
    else if (label.includes('MONKEY')) wallets.MONKEY = data;
    else if (label.includes('OCTOPUS')) wallets.OCTOPUS = data;
  }
  for (const name of ['LOBSTER', 'MONKEY', 'OCTOPUS']) {
    if (!wallets[name]) throw new Error(`Missing wallet for ${name} in ${WALLETS_DIR}`);
  }
  return wallets;
}

// ── Faucet & Balance ────────────────────────────────────────

async function claimFaucet(address) {
  const url = `${FAUCET_URL}?address=${address}`;
  const res = await fetch(url, { method: 'POST' });
  const body = await res.text();
  if (!res.ok) throw new Error(`Faucet ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  console.log(`    Faucet claimed — txid: ${data.txId || data.tx_id || '(pending)'}`);
  return data;
}

async function checkBalance(address) {
  const url = `${HIRO_API}/extended/v1/address/${address}/stx`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Balance check ${res.status}`);
  const data = await res.json();
  const balanceSTX = parseInt(data.balance, 10) / 1_000_000;
  return balanceSTX;
}

// ── STX Transfer ────────────────────────────────────────────

async function transferSTX(senderKey, recipientAddress, amountSTX) {
  const amountMicro = BigInt(amountSTX) * 1_000_000n;
  const txOptions = {
    recipient: recipientAddress,
    amount: amountMicro,
    senderKey,
    network: 'testnet',
    memo: 'agent-console fund',
    anchorMode: AnchorMode.Any,
  };
  const tx = await makeSTXTokenTransfer(txOptions);
  const result = await broadcastTransaction({ transaction: tx, network: 'testnet' });
  const txid = result.txid || result.txId || result;
  console.log(`    Transfer broadcast — txid: ${txid}`);
  return txid;
}

// ── Helpers ─────────────────────────────────────────────────

function delay(s) {
  return new Promise(r => {
    process.stdout.write(`    Waiting ${s}s for confirmation`);
    let elapsed = 0;
    const iv = setInterval(() => {
      elapsed++;
      process.stdout.write('.');
      if (elapsed >= s) { clearInterval(iv); console.log(' done'); r(); }
    }, 1000);
  });
}

async function printBalances(wallets) {
  console.log('\n  --- Balances ---');
  for (const [name, w] of Object.entries(wallets)) {
    const bal = await checkBalance(w.address);
    console.log(`    ${name}: ${bal.toFixed(2)} STX  (${w.address})`);
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const distribute = process.argv.includes('--distribute');
  const W = loadWallets();

  console.log('═══════════════════════════════════════════');
  console.log('  STX Faucet Claim' + (distribute ? ' + Distribute' : ''));
  console.log('═══════════════════════════════════════════');

  if (distribute) {
    // Claim for LOBSTER only, then transfer to MONKEY & OCTOPUS
    console.log('\n  [1] Claiming faucet for LOBSTER...');
    await claimFaucet(W.LOBSTER.address);
    await delay(WAIT_SECS);

    console.log(`\n  [2] Transferring ${TRANSFER_AMOUNT} STX to MONKEY...`);
    await transferSTX(W.LOBSTER.privateKey, W.MONKEY.address, TRANSFER_AMOUNT);

    console.log(`\n  [3] Transferring ${TRANSFER_AMOUNT} STX to OCTOPUS...`);
    await transferSTX(W.LOBSTER.privateKey, W.OCTOPUS.address, TRANSFER_AMOUNT);

    await delay(WAIT_SECS);
  } else {
    // Claim for all 3 agents
    for (const [name, w] of Object.entries(W)) {
      console.log(`\n  Claiming faucet for ${name}...`);
      try {
        await claimFaucet(w.address);
      } catch (e) {
        console.log(`    ⚠ ${e.message}`);
      }
    }
    await delay(WAIT_SECS);
  }

  await printBalances(W);
  console.log('\n  Done.\n');
}

main().catch(e => {
  console.error(`\n  Error: ${e.message}\n`);
  process.exit(1);
});
