import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedItem, Overlays, RadioStation } from '../../shared/types.ts';
import { backoffMs, deployOrder, referencedMedia, relUrl, resolveMedia, rewriteFeedItem, rewriteOverlays, rewriteStation, selectExpired } from '../src/publisher.ts';

const item: FeedItem = { id: 1, ts: 1, family: 'air', kind: 'ATC', title: 't', meta: '', body: '', clip: '/api/clips/atc/a%20b.mp3', image: '/api/art/x.jpg' };

test('relUrl rewrites only api media prefixes', () => {
  assert.equal(relUrl('/api/clips/noaa/x.mp3'), 'clips/noaa/x.mp3');
  assert.equal(relUrl('/api/maps/m.png'), 'maps/m.png');
  assert.equal(relUrl('https://example.com/api/art/x'), 'https://example.com/api/art/x');
  assert.equal(relUrl(undefined), undefined);
});

test('feed item clip and image become relative', () => {
  const out = rewriteFeedItem(item);
  assert.equal(out.clip, 'clips/atc/a%20b.mp3');
  assert.equal(out.image, 'art/x.jpg');
  assert.equal(item.clip, '/api/clips/atc/a%20b.mp3'); // input untouched
  assert.equal('image' in rewriteFeedItem({ ...item, image: undefined }), true);
});

test('radio station art, logo and clip become relative', () => {
  const r: RadioStation = { key: '97.1_0', freq: '97.1', program: 0, art: '/api/art/a.jpg', logo: '/api/art/l.png', clip: '/api/clips/radio/c.mp3', updatedAt: 1 };
  const out = rewriteStation(r);
  assert.deepEqual([out.art, out.logo, out.clip], ['art/a.jpg', 'art/l.png', 'clips/radio/c.mp3']);
  assert.equal(rewriteStation({ ...r, art: undefined }).art, undefined);
});

const overlays: Overlays = {
  traffic: { mapId: '1', updatedAt: 5, tiles: [{ url: '/api/maps/t1.png', bounds: [1, 2, 3, 4] }, { url: '/api/maps/t2.png', bounds: [3, 2, 5, 4] }], background: [0, 0, 0] },
  radar: { url: '/api/maps/r.png', updatedAt: 6, bounds: [1, 2, 3, 4] },
};

test('overlay urls become relative, rest preserved', () => {
  const out = rewriteOverlays(overlays);
  assert.deepEqual(out.traffic?.tiles.map((t) => t.url), ['maps/t1.png', 'maps/t2.png']);
  assert.deepEqual(out.traffic?.tiles[1].bounds, [3, 2, 5, 4]);
  assert.deepEqual(out.traffic?.background, [0, 0, 0]);
  assert.equal(out.radar?.url, 'maps/r.png');
  assert.deepEqual(rewriteOverlays({}), {});
});

test('referencedMedia finds media paths in rewritten data', () => {
  const found = referencedMedia({ radio: [rewriteStation({ key: 'k', freq: '1', program: 0, art: '/api/art/a.jpg', updatedAt: 1 })] }, [rewriteFeedItem(item)], rewriteOverlays(overlays));
  assert.deepEqual(found.sort(), ['art/a.jpg', 'art/x.jpg', 'clips/atc/a%20b.mp3', 'maps/r.png', 'maps/t1.png', 'maps/t2.png']);
  assert.deepEqual(referencedMedia({ body: 'clips/atc/not-a-url-key.mp3' }), []);
});

test('resolveMedia decodes names and rejects traversal', () => {
  const roots = { clips: '/c', art: '/a', maps: '/m' };
  assert.deepEqual(resolveMedia('clips/atc/a%20b.mp3', roots), { local: '/c/atc/a b.mp3', remote: 'clips/atc/a b.mp3' });
  assert.equal(resolveMedia('art/x.jpg', roots)?.local, '/a/x.jpg');
  assert.equal(resolveMedia('clips/../etc/passwd', roots), undefined);
  assert.equal(resolveMedia('clips/%2e%2e/x', roots), undefined);
  assert.equal(resolveMedia('clips/atc/x.mp3', { art: '/a', maps: '/m' }), undefined);
});

test('selectExpired keeps files up to 24 h old', () => {
  const now = 1_000_000_000_000;
  const h = 3600_000;
  const files = [
    { path: 'clips/atc/new.mp3', mtime: now - 1 * h },
    { path: 'clips/atc/edge.mp3', mtime: now - 24 * h },
    { path: 'art/old.jpg', mtime: now - 24 * h - 1 },
    { path: 'maps/older.png', mtime: now - 72 * h },
  ];
  assert.deepEqual(selectExpired(files, now), ['art/old.jpg', 'maps/older.png']);
  assert.deepEqual(selectExpired([], now), []);
});

test('deploy order puts assets first and index.html last', () => {
  assert.deepEqual(deployOrder(['index.html', 'favicon.svg', 'assets/b.js', 'assets/a.css']), ['assets/a.css', 'assets/b.js', 'favicon.svg', 'index.html']);
});

test('backoff doubles up to five minutes', () => {
  assert.deepEqual([1, 2, 3, 20].map(backoffMs), [5000, 10_000, 20_000, 300_000]);
});
