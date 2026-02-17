#!/usr/bin/env node
/**
 * E2E Test — Full StacksTasker Task Lifecycle via Relay
 *
 * Requires: relay server running (npm start) + browser open at localhost:3402 with auto-bid ON.
 *
 * Flow:
 *   1. Verify relay server is running
 *   2. LOBSTER posts a task
 *   3. Wait for relay to push task → browser auto-bids (poll API for bids)
 *   4. LOBSTER accepts MONKEY's bid
 *   5. Wait for browser to auto-start → AI-complete → submit (autonomous)
 *   6. LOBSTER approves → reviews MONKEY
 *
 * Usage:
 *   node test-e2e.js                          # default API url
 *   API_URL=https://... node test-e2e.js      # custom API url
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const {
  makeSTXTokenTransfer,
  broadcastTransaction,
  AnchorMode,
} = require('@stacks/transactions');

const API_URL = (process.env.API_URL || 'https://stackstasker.com').replace(/\/+$/, '');
const RELAY_URL = process.env.RELAY_URL || 'http://localhost:3402';
const RELAY_WS = RELAY_URL.replace(/^http/, 'ws');
const WALLETS_DIR = path.join(__dirname, 'wallets');
const DELAY_MS = parseInt(process.env.DELAY_MS, 10) || 1500;
const BID_TIMEOUT_MS = 30000; // max wait for auto-bids
const BID_POLL_MS = 2000;     // poll interval for bids

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

// ── Auth Headers (mirrors index.html API._headers) ──────────

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

// ── Main Test Flow ──────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  StacksTasker E2E Test — Relay Auto-Bid');
  console.log('═══════════════════════════════════════════');
  console.log(`  API:   ${API_URL}`);
  console.log(`  Relay: ${RELAY_URL}`);

  const W = loadWallets();
  console.log(`  LOBSTER:  ${W.LOBSTER.address}`);
  console.log(`  MONKEY:   ${W.MONKEY.address}`);
  console.log(`  OCTOPUS:  ${W.OCTOPUS.address}`);

  // 0. Verify relay server is running
  step('Verify relay server');
  try {
    const res = await fetch(RELAY_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ok(`Relay server reachable at ${RELAY_URL}`);
  } catch (e) {
    throw new Error(`Relay server not running at ${RELAY_URL} — run "npm start" first. (${e.message})`);
  }

  // Also verify WebSocket connectivity
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_WS);
    const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket connection timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timer); ok('WebSocket connected to relay'); ws.close(); resolve(); });
    ws.on('error', (e) => { clearTimeout(timer); reject(new Error(`WebSocket error: ${e.message}`)); });
  });

  // 1. Skip registration — browser auto-registers agents on startup.
  //    The E2E test only needs LOBSTER's wallet to post the task.
  step('Verify agents (browser handles registration)');
  ok(`LOBSTER wallet: ${W.LOBSTER.address} (task poster)`);
  ok(`MONKEY wallet: ${W.MONKEY.address} (auto-bidder via browser)`);
  ok(`OCTOPUS wallet: ${W.OCTOPUS.address} (auto-bidder via browser)`);

  // 2. LOBSTER creates a task
  step('LOBSTER creates a task');
  const taskData = {
    title: `E2E Relay Test ${Date.now()}`,
    description: 'Automated E2E test — summarize the benefits of decentralized task markets.',
    category: 'coding',
    bounty: 5,
    posterAddress: W.LOBSTER.address,
    network: 'testnet',
  };
  const created = await api('POST', '/tasks', W.LOBSTER, taskData);
  const taskId = created.id || created.taskId || created._id;
  if (!taskId) throw new Error('No task ID returned: ' + JSON.stringify(created));
  ok(`Task created: ${taskId} — "${taskData.title}"`);

  // 3. Wait for relay to push task and browser to auto-bid
  step('Waiting for relay auto-bids (up to 30s)');
  info('Relay should detect task within ~5s, browser auto-bids immediately');

  let bids = [];
  const deadline = Date.now() + BID_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await delay(BID_POLL_MS);
    try {
      const task = await api('GET', `/tasks/${taskId}`, W.LOBSTER);
      const bidCount = task.bidCount || (task.bids || []).length;
      const elapsed = Math.round((Date.now() - (deadline - BID_TIMEOUT_MS)) / 1000);
      if (bidCount > 0) {
        // Fetch bids from dedicated endpoint
        const bidData = await api('GET', `/tasks/${taskId}/bids`, W.LOBSTER);
        bids = bidData.bids || bidData || [];
        ok(`${bids.length} auto-bid(s) received after ${elapsed}s`);
        for (const b of bids) {
          const name = b.agentName || b.agentId || 'unknown';
          info(`${name}: ${b.amount} STX — "${b.message || ''}"`);
        }
        break;
      }
      info(`${elapsed}s — no bids yet (bidCount: ${bidCount}), polling...`);
    } catch (e) {
      info(`Poll error: ${e.message}`);
    }
  }

  if (bids.length === 0) {
    throw new Error('No auto-bids received within timeout. Is the browser open at localhost:3402 with auto-bid enabled?');
  }

  // Find first bid to accept
  const winBid = bids[0];
  const winBidId = winBid.bidId || winBid.id || winBid._id;
  const winnerId = winBid.agentId;
  const winnerName = winBid.agentName || winnerId;
  // Match winner to a wallet — look up from registered agents list
  const agentsResp = await api('GET', '/agents', W.LOBSTER);
  const agentsList = agentsResp.agents || agentsResp || [];
  const winnerAgent = agentsList.find(a => (a.id || a.agentId) === winnerId);
  const winnerWalletAddr = winnerAgent ? winnerAgent.walletAddress : null;
  const winnerWallet = winnerWalletAddr === W.MONKEY.address ? W.MONKEY
    : winnerWalletAddr === W.OCTOPUS.address ? W.OCTOPUS
    : W.MONKEY; // fallback
  ok(`Selecting ${winnerName}'s bid: ${winBidId} (wallet: ${winnerWallet === W.MONKEY ? 'MONKEY' : 'OCTOPUS'})`);
  await delay(DELAY_MS);

  // 4. LOBSTER accepts the bid
  step(`LOBSTER accepts ${winnerName}'s bid`);
  await api('POST', `/tasks/${taskId}/bids/${winBidId}/accept`, W.LOBSTER, {
    posterAddress: W.LOBSTER.address,
  });
  ok('Bid accepted — browser will auto-start, AI-complete, and submit');

  // Nudge browser to poll watched tasks immediately (defeats background-tab throttling)
  try { await fetch(`${RELAY_URL}/api/trigger-poll`, { method: 'POST' }); } catch(e) {}

  // 5. Wait for browser to auto-complete the task (start → AI → submit)
  step(`Waiting for ${winnerName} to auto-complete (up to 90s)`);
  const submitDeadline = Date.now() + 90000;
  let submitted = false;
  while (Date.now() < submitDeadline) {
    await delay(BID_POLL_MS);
    // Keep nudging in case the first one arrived before the status changed
    try { await fetch(`${RELAY_URL}/api/trigger-poll`, { method: 'POST' }); } catch(e) {}
    try {
      const t = await api('GET', `/tasks/${taskId}`, W.LOBSTER);
      const elapsed = Math.round((Date.now() - (submitDeadline - 90000)) / 1000);
      if (t.status === 'submitted') {
        ok(`Task auto-submitted after ${elapsed}s`);
        submitted = true;
        break;
      }
      info(`${elapsed}s — status: ${t.status}, waiting for submitted...`);
    } catch (e) {
      info(`Poll error: ${e.message}`);
    }
  }
  if (!submitted) {
    throw new Error('Task was not auto-submitted within timeout. Is the AI provider configured in the browser?');
  }
  await delay(DELAY_MS);

  // 7. LOBSTER pays the winner on-chain (before approve so we can attach real txId)
  step(`LOBSTER pays ${winnerName} — ${taskData.bounty} STX on-chain`);
  let paymentTxId = null;
  try {
    paymentTxId = await transferSTX(W.LOBSTER.privateKey, winnerWallet.address, taskData.bounty);
    ok(`STX transfer broadcast — txid: ${paymentTxId}`);
    info(`${taskData.bounty} STX sent to ${winnerWallet.address}`);
    info(`Explorer: https://explorer.hiro.so/txid/${paymentTxId}?chain=testnet`);
  } catch (e) {
    info(`On-chain payment failed: ${e.message}`);
    info('(LOBSTER may need testnet STX — run: node claim-faucet.js)');
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
      await fetch(`${RELAY_URL}/api/payment-tx`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, txId: paymentTxId }),
      });
      ok('Real txId stored on relay');
    } catch(e) { info(`Relay store skipped: ${e.message}`); }
  }
  await delay(DELAY_MS);

  // 9. LOBSTER reviews the winner (browser auto-review may have already done this)
  step(`LOBSTER reviews ${winnerName}`);
  try {
    await api('POST', `/agents/${encodeURIComponent(winnerId)}/review`, W.LOBSTER, {
      taskId,
      rating: 5,
      comment: `Excellent work by ${winnerName} — fast, accurate, and thorough.`,
      reviewerAddress: W.LOBSTER.address,
    });
    ok('Review submitted');
  } catch(e) {
    if (e.message.includes('Already reviewed')) {
      ok('Already auto-reviewed by browser');
    } else { throw e; }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  E2E TEST PASSED — Full relay lifecycle');
  console.log('═══════════════════════════════════════════\n');
}

main().catch(e => {
  console.error(`\n  E2E TEST FAILED: ${e.message}\n`);
  process.exit(1);
});
