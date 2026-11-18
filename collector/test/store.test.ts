import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.ts';

test('feed window keeps the newest N of each kind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  try {
    const store = new Store(path.join(dir, 'a.db'));
    // One old song, then lots of ATC that would push it out of a plain "newest 200".
    store.addFeed({ ts: 1000, family: 'bcast', kind: 'Radio', title: 'HOT HD1', meta: '99.5', body: 'Bye Bye Bye — *NSYNC' });
    for (let i = 0; i < 300; i++) store.addFeed({ ts: 2000 + i, family: 'air', kind: 'ATC', title: 'DCA Tower', meta: '119.1', body: '' });
    const items = store.recentFeedPerKind(60);
    assert.equal(items.filter((x) => x.kind === 'ATC').length, 60);
    assert.ok(items.some((x) => x.body.includes('NSYNC')));
    assert.ok(items.every((x, i) => i === 0 || items[i - 1].ts >= x.ts), 'newest first');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
