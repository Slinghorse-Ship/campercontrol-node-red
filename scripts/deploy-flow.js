#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = String(process.argv[2] || '172.24.24.1').replace(/^https?:\/\//, '').replace(/\/$/, '');
const baseUrl = `http://${host}:1880`;
const sourcePath = path.join(root, 'flows', 'CamperControl_NodeRED.json');
const backupRoot = path.resolve(root, '..', 'backups', 'node-red-live');

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return { text }; }
}

async function main() {
  const candidate = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (!Array.isArray(candidate) || candidate.length !== 372) {
    throw new Error(`Refusing deployment: expected 372 nodes, got ${Array.isArray(candidate) ? candidate.length : 'invalid JSON'}`);
  }

  const flowResponse = await fetch(`${baseUrl}/flows`, {
    headers: { 'Node-RED-API-Version': 'v2' },
    signal: AbortSignal.timeout(8000),
  });
  if (!flowResponse.ok) throw new Error(`GET /flows failed: ${flowResponse.status}`);
  const live = await flowResponse.json();
  if (!live || !Array.isArray(live.flows) || !live.rev) {
    throw new Error('Node-RED did not return the revisioned v2 flow format');
  }

  fs.mkdirSync(backupRoot, { recursive: true });
  const backupPath = path.join(backupRoot, `flows-before-v5-${timestamp()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(live, null, 2) + '\n');

  const deployResponse = await fetch(`${baseUrl}/flows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Node-RED-API-Version': 'v2',
    },
    body: JSON.stringify({ rev: live.rev, flows: candidate }),
    signal: AbortSignal.timeout(30000),
  });
  const deployBody = await responseJson(deployResponse);
  if (!deployResponse.ok) {
    throw new Error(`POST /flows failed: ${deployResponse.status} ${JSON.stringify(deployBody)}`);
  }

  let state = null;
  for (let attempt = 0; attempt < 30; ++attempt) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch(`${baseUrl}/camper/api/v2/state`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) continue;
      const packet = await response.json();
      const snapshot = packet.state || packet;
      if (Array.isArray(snapshot.ui?.quickAccessOptions) && Array.isArray(snapshot.ui?.quickAccess)) {
        state = snapshot;
        break;
      }
    } catch (_) { /* deployment may briefly restart HTTP nodes */ }
  }
  if (!state) throw new Error('Deployment completed, but generic quick-access state did not become ready');

  console.log(JSON.stringify({
    ok: true,
    host,
    previousNodes: live.flows.length,
    deployedNodes: candidate.length,
    backupPath,
    quickAccessIds: state.ui.quickAccessIds,
    quickAccessCount: state.ui.quickAccess.length,
    quickOptionCount: state.ui.quickAccessOptions.length,
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exit(1);
});
