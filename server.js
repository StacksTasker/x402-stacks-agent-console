require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3402;
const API_BASE = 'https://stackstasker.com';
const TASKS_URLS = [
  `${API_BASE}/tasks?status=open&network=testnet`,
  `${API_BASE}/tasks?status=open&network=mainnet`,
];

const { c32address, c32addressDecode } = require('c32check');

const app = express();

// List wallet files with pre-computed testnet+mainnet addresses
app.get('/api/wallet-files', (_req, res) => {
  const dir = path.join(__dirname, 'wallets');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const wallets = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (!data.address || !data.privateKey) return null;
        const result = { filename: f, label: data.label, address: data.address, network: data.network };
        try {
          const [, hash] = c32addressDecode(data.address);
          result.testnetAddress = c32address(26, hash);
          result.mainnetAddress = c32address(22, hash);
        } catch(e) { result.testnetAddress = data.address; result.mainnetAddress = data.address; }
        return result;
      } catch(e) { return null; }
    }).filter(Boolean);
    res.json({ files, wallets });
  } catch(e) { res.json({ files: [], wallets: [] }); }
});

// Convert STX address between testnet/mainnet
app.get('/api/convert-address', (req, res) => {
  const { address, network } = req.query;
  if (!address || !network) return res.status(400).json({ error: 'address and network required' });
  try {
    const [, hash] = c32addressDecode(address);
    const version = network === 'mainnet' ? 22 : 26;
    const converted = c32address(version, hash);
    res.json({ address: converted });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Trigger: push a task to browser clients as if it were newly detected
app.post('/api/push-task', express.json(), (req, res) => {
  const tasks = req.body.tasks || [req.body];
  const msg = JSON.stringify({ type: 'new_tasks', tasks });
  const active = [...wss.clients].filter(ws => ws.readyState === 1).length;
  console.log(`Manual push: ${tasks.length} task(s) to ${active} client(s)`);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  res.json({ pushed: tasks.length, clients: active });
});

// Expose AI API keys from environment to browser clients
app.get('/api/env-keys', (_req, res) => {
  res.json({
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
  });
});

// Store real on-chain payment txIds (platform only records sim_ IDs)
const paymentTxIds = new Map();
app.post('/api/payment-tx', express.json(), (req, res) => {
  const { taskId, txId } = req.body;
  if (!taskId || !txId) return res.status(400).json({ error: 'taskId and txId required' });
  paymentTxIds.set(taskId, txId);
  console.log(`Stored real payment tx for task ${taskId}: ${txId}`);
  const msg = JSON.stringify({ type: 'payment_tx', taskId, txId });
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  res.json({ stored: true });
});
app.get('/api/payment-tx/:taskId', (req, res) => {
  const txId = paymentTxIds.get(req.params.taskId);
  res.json({ txId: txId || null });
});

// Track a task for status changes (called by browser after bidding)
app.post('/api/watch-task', express.json(), (req, res) => {
  const taskId = req.body.taskId;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  if (!taskStatusCache.has(taskId)) {
    taskStatusCache.set(taskId, req.body.status || 'unknown');
    console.log(`Now watching task ${taskId}`);
  }
  res.json({ tracking: taskStatusCache.size });
});

// Trigger browser to immediately poll watched tasks
app.post('/api/trigger-poll', (_req, res) => {
  const msg = JSON.stringify({ type: 'poll_watched' });
  const active = [...wss.clients].filter(ws => ws.readyState === 1).length;
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  res.json({ clients: active });
});

// Tell connected browsers to reload
app.post('/api/reload', (_req, res) => {
  const msg = JSON.stringify({ type: 'reload' });
  const active = [...wss.clients].filter(ws => ws.readyState === 1).length;
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  console.log(`Reload signal sent to ${active} client(s)`);
  res.json({ clients: active });
});

// Query browser state for diagnostics
let _stateResolve = null;
app.get('/api/browser-state', (req, res) => {
  const active = [...wss.clients].filter(ws => ws.readyState === 1);
  if (active.length === 0) return res.json({ error: 'no clients' });
  const msg = JSON.stringify({ type: 'state_request' });
  active[0].send(msg);
  _stateResolve = (data) => res.json(data);
  setTimeout(() => { if (_stateResolve) { _stateResolve = null; res.json({ error: 'timeout' }); } }, 5000);
});

// No-cache for HTML
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Agent identity ─────────────────────────────────────────
const agentWallets = new Set();
const agentServerIds = new Set();
try {
  const dir = path.join(__dirname, 'wallets');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    if (data.address) {
      agentWallets.add(data.address);
      try {
        const [, hash] = c32addressDecode(data.address);
        agentWallets.add(c32address(26, hash));
        agentWallets.add(c32address(22, hash));
      } catch(e) {}
    }
  }
  console.log(`Loaded ${agentWallets.size} agent wallet addresses`);
} catch(e) { console.log('No wallet files found'); }

async function resolveAgentServerIds() {
  try {
    const res = await fetch(`${API_BASE}/agents`);
    if (!res.ok) return;
    const data = await res.json();
    const agents = data.agents || data || [];
    for (const a of agents) {
      if (agentWallets.has(a.walletAddress)) {
        const sid = a.id || a.agentId;
        if (sid) agentServerIds.add(sid);
      }
    }
    console.log(`Resolved ${agentServerIds.size} agent server IDs: ${[...agentServerIds].join(', ')}`);
  } catch(e) {}
}

function isOurTask(task) {
  return agentServerIds.has(task.assignedAgent) || agentServerIds.has(task.agentId) ||
         agentWallets.has(task.posterAddress) || agentWallets.has(task.assignedAgent);
}

// ── Task status cache — tracks last known status for ALL our agent tasks ──
const taskStatusCache = new Map(); // taskId -> lastKnownStatus
const seenNewIds = new Set();
let firstFetch = true;

function broadcast(msg) {
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(str); });
}

function clientCount() {
  return [...wss.clients].filter(ws => ws.readyState === 1).length;
}

// ── Poll for new open tasks (pushes to browser for auto-bid) ──
async function pollNewTasks() {
  try {
    const tasks = [];
    for (const url of TASKS_URLS) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        tasks.push(...(Array.isArray(data) ? data : (data.tasks || [])));
      } catch(e) {}
    }
    if (firstFetch) {
      tasks.forEach(t => seenNewIds.add(t.id));
      firstFetch = false;
      console.log(`Seeded ${seenNewIds.size} existing open tasks`);
      return;
    }
    const newTasks = tasks.filter(t => !seenNewIds.has(t.id));
    tasks.forEach(t => seenNewIds.add(t.id));
    if (newTasks.length > 0) {
      newTasks.forEach(t => console.log(`New task: ${t.title}`));
      console.log(`Pushing ${newTasks.length} new task(s) to ${clientCount()} client(s)`);
      broadcast({ type: 'new_tasks', tasks: newTasks });
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

// ── Poll ALL statuses for our agent tasks, detect any status change ──
async function pollAllAgentTasks() {
  if (agentServerIds.size === 0) return;
  if (clientCount() === 0) return;

  const allStatuses = ['bidding', 'assigned', 'in-progress', 'submitted', 'completed'];
  const updates = [];

  for (const status of allStatuses) {
    try {
      const res = await fetch(`${API_BASE}/tasks?status=${status}`);
      if (!res.ok) continue;
      const data = await res.json();
      const tasks = Array.isArray(data) ? data : (data.tasks || []);
      for (const t of tasks) {
        if (!isOurTask(t)) continue;
        const prev = taskStatusCache.get(t.id);
        if (prev === t.status) continue;
        // New task or status changed
        if (prev) {
          console.log(`Task ${t.id} status: ${prev} → ${t.status} "${t.title}"`);
          updates.push(t);
        } else {
          console.log(`Tracking agent task: ${t.id} (${t.status}) "${t.title}"`);
          // Only push update for non-terminal tasks that we haven't seen at all
          // (don't flood browser with old completed tasks on first boot)
        }
        taskStatusCache.set(t.id, t.status);
      }
    } catch(e) {}
  }

  if (updates.length > 0) {
    console.log(`Pushing ${updates.length} status update(s) to ${clientCount()} client(s)`);
    broadcast({ type: 'task_updates', tasks: updates });
  }
}

// ── Also poll individually-watched tasks (for tasks not in list queries) ──
async function pollWatchedTasks() {
  if (taskStatusCache.size === 0) return;
  if (clientCount() === 0) return;

  const updates = [];
  for (const [taskId, lastStatus] of taskStatusCache) {
    // Skip terminal statuses
    if (['completed', 'cancelled', 'rejected', 'expired'].includes(lastStatus)) continue;
    try {
      const res = await fetch(`${API_BASE}/tasks/${taskId}`);
      if (!res.ok) continue;
      const task = await res.json();
      if (task.status !== lastStatus) {
        console.log(`Task ${taskId} status: ${lastStatus} → ${task.status}`);
        taskStatusCache.set(taskId, task.status);
        updates.push(task);
      }
    } catch(e) {}
  }

  if (updates.length > 0) {
    console.log(`Pushing ${updates.length} watched update(s) to ${clientCount()} client(s)`);
    broadcast({ type: 'task_updates', tasks: updates });
  }
}

// ── WebSocket ──────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'state_response' && _stateResolve) {
        const resolve = _stateResolve;
        _stateResolve = null;
        resolve(data);
      }
    } catch(e) {}
  });
  ws.on('close', () => console.log('Client disconnected'));
});

// ── Start ──────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`Relay server on http://localhost:${PORT}`);
  await resolveAgentServerIds();
  pollNewTasks();
  // Seed agent task statuses on first run
  await pollAllAgentTasks();
  console.log(`Tracking ${taskStatusCache.size} agent tasks`);
  // Polling intervals
  setInterval(pollNewTasks, 5000);       // new open tasks every 5s
  setInterval(pollAllAgentTasks, 10000); // all agent tasks every 10s
  setInterval(pollWatchedTasks, 10000);  // individually watched tasks every 10s
});
