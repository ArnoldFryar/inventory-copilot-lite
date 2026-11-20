'use strict';

const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { gzip, gunzip } = require('node:zlib');

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const snapshots = new Map();
const MAX_BYTES = 64 * 1024 * 1024;
const TTL_MS = 30 * 60 * 1000;
let usedBytes = 0;

function remove(id) {
  const entry = snapshots.get(id);
  if (!entry) return;
  usedBytes -= entry.payload.length;
  snapshots.delete(id);
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of snapshots) if (entry.expires <= now) remove(id);
}, 60_000);
cleanup.unref();

async function retain(owner, analysis) {
  const id = randomUUID();
  const payload = await compress(JSON.stringify(analysis), { level: 3 });
  if (payload.length > MAX_BYTES) return null;
  while (usedBytes + payload.length > MAX_BYTES || snapshots.size >= 128) {
    remove(snapshots.keys().next().value);
  }
  snapshots.set(id, { owner, payload, expires: Date.now() + TTL_MS });
  usedBytes += payload.length;
  return id;
}

async function read(owner, id) {
  const entry = snapshots.get(id);
  if (!entry || entry.owner !== owner) return null;
  if (entry.expires <= Date.now()) {
    remove(id);
    return null;
  }
  return JSON.parse(await decompress(entry.payload));
}

function forget(owner, id) {
  if (snapshots.get(id)?.owner === owner) remove(id);
}

module.exports = { retain, read, forget };
