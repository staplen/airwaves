import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, utimes } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawLog, hourKey } from '../src/rawlog.ts';

test('writes hourly files, gzips finished hours and deletes old ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rawlog-'));
  const log = new RawLog(dir, 72 * 3600_000);
  const h0 = Date.parse('2026-11-20T14:59:59Z');
  const h1 = Date.parse('2026-11-20T15:00:01Z');
  assert.equal(hourKey(h0), '20261120-14');
  log.write('vdl2', 'acars H1', '{"a":1}', h0);
  log.write('vdl2', 'frame S', '{"b":2}', h1);
  log.write('sonde', 'Y1', '{"c":3}', h1);
  log.flush();
  assert.deepEqual((await readdir(join(dir, 'vdl2'))).sort(), ['20261120-14.jsonl', '20261120-15.jsonl']);
  const r = await log.rotate(h1 + 1000);
  assert.equal(r.zipped, 1);
  const lines = gunzipSync(await readFile(join(dir, 'vdl2', '20261120-14.jsonl.gz'))).toString().trim().split('\n');
  assert.deepEqual(JSON.parse(lines[0]), { ts: h0, kind: 'acars H1', text: '{"a":1}' });
  // Past the window: deleted.
  const old = new Date(Date.now() - 80 * 3600_000);
  await utimes(join(dir, 'sonde', '20261120-15.jsonl'), old, old);
  assert.equal((await log.rotate(h1 + 2000)).deleted, 1);
  assert.deepEqual((await log.list()).map((f) => f.path), ['vdl2/20261120-15.jsonl', 'vdl2/20261120-14.jsonl.gz']);
});
