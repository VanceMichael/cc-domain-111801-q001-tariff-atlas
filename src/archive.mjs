import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function claimRow(row) {
  return { scope: row.scope, procurement_code: row.procurement_code, edition: row.edition, claim_digest: row.claim_digest, decided_at: row.decided_at, claim: JSON.parse(row.payload) };
}

export class Archive {
  constructor(directory) { this.directory = directory; }
  async start() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    this.database = new DatabaseSync(join(this.directory, 'receipts.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS evidence (
      digest TEXT PRIMARY KEY, location TEXT NOT NULL, observed_at TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY(scope,business_key,digest));
      CREATE TABLE IF NOT EXISTS claims (
      scope TEXT NOT NULL, procurement_code TEXT NOT NULL, edition TEXT NOT NULL,
      claim_digest TEXT NOT NULL, payload TEXT NOT NULL, decided_at TEXT NOT NULL,
      PRIMARY KEY(scope,procurement_code,edition,claim_digest));`);
    return this;
  }
  async preserve(document) {
    const digest = createHash('sha256').update(document.bytes).digest('hex');
    const destination = join(this.directory, 'objects', digest);
    const temporary = destination + '.' + process.pid + '.' + crypto.randomUUID();
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(document.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
    this.database.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?)').run(digest, document.location, document.observedAt, document.bytes.length);
    return digest;
  }
  put(scope, key, digest, record, decision) {
    if (!this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest)) throw new Error('原文尚未保存');
    this.database.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?)').run(scope, key, digest, JSON.stringify(record), JSON.stringify(decision));
  }
  records(scope) {
    return this.database.prepare('SELECT * FROM receipts WHERE scope=? ORDER BY business_key,digest').all(scope).map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }
  putClaim(scope, code, edition, claim, decidedAt) {
    const payload = canonical(claim);
    const digest = createHash('sha256').update(payload).digest('hex');
    this.database.prepare(`INSERT INTO claims VALUES(?,?,?,?,?,?)
      ON CONFLICT(scope,procurement_code,edition,claim_digest) DO UPDATE SET decided_at=excluded.decided_at`)
      .run(scope, code, edition, digest, payload, decidedAt);
    return digest;
  }
  claims(scope) {
    return this.database.prepare('SELECT * FROM claims WHERE scope=? ORDER BY procurement_code,edition,decided_at').all(scope).map(claimRow);
  }
  currentClaims(scope) {
    return this.database.prepare(`SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY procurement_code,edition ORDER BY decided_at DESC, rowid DESC) AS rn
      FROM claims WHERE scope=?) WHERE rn=1 ORDER BY procurement_code,edition`).all(scope).map(claimRow);
  }
  evidenceOf(digest) {
    return this.database.prepare('SELECT * FROM evidence WHERE digest=?').get(digest);
  }
  async original(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('原文摘要无效');
    const content = await readFile(join(this.directory, 'objects', digest));
    if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('原文完整性校验失败');
    return content;
  }
  close() { this.database?.close(); }
}
