#!/usr/bin/env node
/**
 * E2E Test — Full StacksTasker Task Lifecycle (standalone, no browser)
 *
 * Drives the entire lifecycle via API calls — no relay/browser needed.
 *
 * Flow:
 *   1. Register agents
 *   2. LOBSTER creates a task
 *   3. MONKEY bids on the task
 *   4. LOBSTER accepts MONKEY's bid
 *   5. MONKEY starts + submits result
 *   6. LOBSTER approves the task
 *   7. LOBSTER pays MONKEY on-chain (real testnet STX transfer)
 *   8. LOBSTER reviews MONKEY
 *
 * Usage:
 *   node test-e2e.js
 *   API_URL=https://... node test-e2e.js
 */

const fs = require('fs');
const path = require('path');
const {
  makeSTXTokenTransfer,
  broadcastTransaction,
  AnchorMode,
} = require('@stacks/transactions');

const API_URL = (process.env.API_URL || 'https://stackstasker.com').replace(/\/+$/, '');
const WALLETS_DIR = path.join(__dirname, 'wallets');
const DELAY_MS = parseInt(process.env.DELAY_MS, 10) || 800;

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
  for (const name of ['LOBSTER', 'MONKEY']) {
    if (!wallets[name]) throw new Error(`Missing wallet for ${name} in ${WALLETS_DIR}`);
  }
  return wallets;
}

// ── Auth Headers ────────────────────────────────────────────

function authHeaders(wallet) {
  return {
    'Content-Type': 'application/json',
    'X-Wallet-Address': wallet.address,
    'X-Wallet-Timestamp': new Date().toISOString(),
    'X-Wallet-Signature': 'agent-console-sig',
  };
}

// ── API Helper ──────────────────────────────────────────────

async function api(method, urlPath, wallet, body) {
  const url = API_URL + urlPath;
  const opts = { method, headers: authHeaders(wallet) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ── Helpers ─────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
let stepNum = 0;
function step(msg) { console.log(`\n  [Step ${++stepNum}] ${msg}`); }
function ok(msg) { console.log(`    ✓ ${msg}`); }
function info(msg) { console.log(`    · ${msg}`); }

async function transferSTX(senderKey, recipientAddress, amountSTX) {
  const amountMicro = BigInt(Math.round(amountSTX * 1_000_000));
  const tx = await makeSTXTokenTransfer({
    recipient: recipientAddress,
    amount: amountMicro,
    senderKey,
    network: 'testnet',
    memo: 'stackstasker task payment',
    anchorMode: AnchorMode.Any,
  });
  const result = await broadcastTransaction({ transaction: tx, network: 'testnet' });
  const txid = result.txid || result.txId || result;
  return txid;
}

async function checkBalance(address) {
  const res = await fetch(`https://api.testnet.hiro.so/extended/v1/address/${address}/stx`);
  if (!res.ok) return 0;
  const d = await res.json();
  return parseInt(d.balance, 10) / 1_000_000;
}

// ── Main Test Flow ──────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('═══════════════════════════════════════════');
  console.log('  StacksTasker E2E Test — Standalone');
  console.log('═══════════════════════════════════════════');
  console.log(`  API: ${API_URL}`);

  const W = loadWallets();
  console.log(`  LOBSTER: ${W.LOBSTER.address}`);
  console.log(`  MONKEY:  ${W.MONKEY.address}`);

  // 1. Register agents
  step('Register agents on StacksTasker');
  for (const [name, w] of [['LOBSTER', W.LOBSTER], ['MONKEY', W.MONKEY]]) {
    try {
      const r = await api('POST', '/agents/register', w, {
        name: w.label || name,
        walletAddress: w.address,
        bio: `${name} test agent`,
        capabilities: ['coding', 'other'],
      });
      ok(`${name} registered (id: ${r.agentId || r.id || 'ok'})`);
    } catch (e) {
      if (e.message.includes('409') || e.message.includes('already')) {
        ok(`${name} already registered`);
      } else {
        info(`${name} registration: ${e.message}`);
      }
    }
  }

  // Look up MONKEY's serverId
  const agentsResp = await api('GET', '/agents', W.LOBSTER);
  const agentsList = agentsResp.agents || agentsResp || [];
  const monkeyAgent = agentsList.find(a => a.walletAddress === W.MONKEY.address);
  const monkeyId = monkeyAgent ? (monkeyAgent.id || monkeyAgent.agentId) : W.MONKEY.address;
  info(`MONKEY serverId: ${monkeyId}`);
  await delay(DELAY_MS);

  // 2. LOBSTER creates a task
  step('LOBSTER creates a task');
  const taskData = {
    title: `E2E Standalone Test ${Date.now()}`,
    description: 'Automated E2E test — summarize the benefits of decentralized task markets in 2-3 sentences.',
    category: 'coding',
    bounty: 5,
    posterAddress: W.LOBSTER.address,
    network: 'testnet',
  };
  const created = await api('POST', '/tasks', W.LOBSTER, taskData);
  const taskId = created.id || created.taskId || created._id;
  if (!taskId) throw new Error('No task ID returned: ' + JSON.stringify(created));
  ok(`Task created: ${taskId} — "${taskData.title}"`);
  await delay(DELAY_MS);

  // 3. MONKEY bids on the task
  step('MONKEY bids on the task');
  const estSecs = Math.floor(Math.random() * 31) + 30;
  const bidData = {
    agentId: monkeyId,
    amount: 5,
    message: 'I can complete this task efficiently.',
    estimatedTime: `${estSecs} seconds`,
  };
  await api('POST', `/tasks/${taskId}/bid`, W.MONKEY, bidData);
  ok(`Bid placed: ${bidData.amount} STX (est: ${estSecs}s)`);
  await delay(DELAY_MS);

  // Fetch bids to get the bid ID
  const bidsResp = await api('GET', `/tasks/${taskId}/bids`, W.LOBSTER);
  const bids = bidsResp.bids || bidsResp || [];
  const monkeyBid = bids.find(b => b.agentId === monkeyId) || bids[0];
  if (!monkeyBid) throw new Error('No bids found after placing bid');
  const bidId = monkeyBid.bidId || monkeyBid.id || monkeyBid._id;
  info(`Bid ID: ${bidId}`);

  // 4. LOBSTER accepts MONKEY's bid
  step("LOBSTER accepts MONKEY's bid");
  await api('POST', `/tasks/${taskId}/bids/${bidId}/accept`, W.LOBSTER, {
    posterAddress: W.LOBSTER.address,
  });
  ok('Bid accepted');
  await delay(DELAY_MS);

  // 5. MONKEY starts the task
  step('MONKEY starts the task');
  await api('POST', `/tasks/${taskId}/start`, W.MONKEY, { agentId: monkeyId });
  ok('Task started');
  await delay(DELAY_MS);

  // 6. MONKEY submits result
  step('MONKEY submits result');
  const result = 'Decentralized task markets enable trustless collaboration by matching task posters with skilled agents globally, using blockchain for transparent payments. They eliminate intermediaries, reduce fees, and create verifiable reputation systems that incentivize quality work.';
  // Post as message first
  try {
    await api('POST', `/tasks/${taskId}/messages`, W.MONKEY, { senderAddress: W.MONKEY.address, body: result });
    info('Result posted as message');
  } catch (e) { info(`Message post: ${e.message}`); }
  // Submit formally
  await api('POST', `/tasks/${taskId}/submit`, W.MONKEY, { result, agentId: monkeyId });
  ok('Result submitted');
  await delay(DELAY_MS);

  // 7. LOBSTER pays MONKEY on-chain (before approve so we can attach real txId)
  step(`LOBSTER pays MONKEY — ${taskData.bounty} STX on-chain`);
  let paymentTxId = null;
  const balBefore = await checkBalance(W.MONKEY.address);
  info(`MONKEY balance before: ${balBefore} STX`);
  try {
    paymentTxId = await transferSTX(W.LOBSTER.privateKey, W.MONKEY.address, taskData.bounty);
    ok(`STX transfer broadcast — txid: ${paymentTxId}`);
    info(`${taskData.bounty} STX → ${W.MONKEY.address}`);
    info(`Explorer: https://explorer.hiro.so/txid/${paymentTxId}?chain=testnet`);
  } catch (e) {
    info(`On-chain payment failed: ${e.message}`);
    info('(Run: node claim-faucet.js to fund LOBSTER)');
  }
  await delay(DELAY_MS);

  // 8. LOBSTER approves (with real on-chain txId if available)
  step('LOBSTER approves the task');
  const approveBody = { posterAddress: W.LOBSTER.address };
  if (paymentTxId) approveBody.paymentTxId = paymentTxId;
  await api('POST', `/tasks/${taskId}/approve`, W.LOBSTER, approveBody);
  ok('Task approved' + (paymentTxId ? ` (txId: ${paymentTxId})` : ''));
  // Store real txId on relay so browser can display it
  if (paymentTxId) {
    try {
      await fetch('http://localhost:3402/api/payment-tx', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, txId: paymentTxId }),
      });
      ok('Real txId stored on relay');
    } catch(e) { info(`Relay store skipped: ${e.message}`); }
  }
  await delay(DELAY_MS);

  // 9. LOBSTER reviews MONKEY
  step('LOBSTER reviews MONKEY');
  await api('POST', `/agents/${encodeURIComponent(monkeyId)}/review`, W.LOBSTER, {
    taskId,
    rating: 5,
    comment: 'Excellent work — fast, accurate, and thorough.',
    reviewerAddress: W.LOBSTER.address,
  });
  ok('Review submitted');

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n═══════════════════════════════════════════');
  console.log(`  E2E TEST PASSED — ${elapsed}s`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch(e => {
  console.error(`\n  E2E TEST FAILED: ${e.message}\n`);
  process.exit(1);
});
