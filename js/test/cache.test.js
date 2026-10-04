import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BandwidthEstimator } from '../chronozarr/bandwidth.js';
import { ChunkCache, SpeculativeBudget } from '../chronozarr/cache.js';
import { RequestLimiter } from '../chronozarr/limiter.js';

const meta = (t, extra = {}) => ({ kind: 'data', lod: 0, row: 0, col: 0, t, ...extra });
const decoded = (n) => new Uint16Array(n / 2);
const compressed = (n) => new Uint8Array(n);
const farFrom = (center) => (entry) => Math.abs(entry.t - center);

function cache({ decodedBytes = 100, compressedBytes = 100, score = (e) => -e.used } = {}) {
  return new ChunkCache({ decodedBytes, compressedBytes, score });
}

// ---- tiers ----

test('an entry holds decoded data, compressed bytes, or both; each tier has its own byte count', () => {
  const c = cache();
  c.insert('a', meta(0), { data: decoded(40), compressed: compressed(25) });
  c.insert('b', meta(1), { compressed: compressed(30) });
  assert.equal(c.decodedBytes, 40);
  assert.equal(c.compressedBytes, 55);
  assert.ok(c.decoded('a'));
  assert.equal(c.decoded('b'), undefined, 'a compressed-only chunk is not a decoded hit');
  assert.ok(c.get('b').compressed);
  assert.deepEqual(c.info(), { entries: 1, bytes: 40, compressedEntries: 2, compressedBytes: 55 });
});

test('over the decoded budget the worst resident loses its array but keeps its compressed bytes', () => {
  const c = cache({ decodedBytes: 100, compressedBytes: 1000, score: farFrom(0) });
  for (const t of [0, 1, 2]) c.insert(`k${t}`, meta(t), { data: decoded(40), compressed: compressed(25) });
  assert.equal(c.decodedBytes, 80, 'two arrays fit');
  assert.equal(c.decoded('k1'), undefined, 'the farther of the two earlier chunks was demoted; a demand insert always gets in');
  assert.ok(c.get('k1').compressed, 'but it is still held compressed');
  assert.ok(c.decoded('k0') && c.decoded('k2'));
  assert.equal(c.evictions.decoded, 1);
  assert.equal(c.compressedBytes, 75);
});

test('over the compressed budget the worst compressed copy goes; an entry with nothing left disappears', () => {
  const c = cache({ decodedBytes: 0, compressedBytes: 60, score: farFrom(0) });
  for (const t of [0, 1, 2, 3]) c.insert(`k${t}`, meta(t), { compressed: compressed(25) });
  assert.equal(c.compressedBytes, 50);
  assert.equal(c.has('k1'), false, 'a compressed-only entry that loses its bytes is gone entirely');
  assert.equal(c.has('k2'), false);
  assert.equal(c.has('k0') && c.has('k3'), true);
  assert.equal(c.evictions.compressed, 2);
  assert.equal(c.evictions.decoded, 0);
});

test('a chunk dropped from the decoded tier that has no compressed copy is forgotten', () => {
  const c = cache({ decodedBytes: 80, compressedBytes: 0, score: farFrom(0) });
  for (const t of [0, 1, 2]) c.insert(`k${t}`, meta(t), { data: decoded(40) });
  assert.equal(c.has('k1'), false);
  assert.equal(c.has('k0') && c.has('k2'), true);
});

test('a background chunk never displaces a better one: it loses its own copy instead', () => {
  const c = cache({ decodedBytes: 80, compressedBytes: 1000, score: farFrom(0) });
  c.insert('near0', meta(0), { data: decoded(40), compressed: compressed(20) });
  c.insert('near1', meta(1), { data: decoded(40), compressed: compressed(20) });
  c.insert('far9', meta(9), { data: decoded(40), compressed: compressed(20) }, { background: true });
  assert.ok(c.decoded('near0') && c.decoded('near1'), 'the near chunks keep their arrays');
  assert.equal(c.decoded('far9'), undefined);
  assert.ok(c.get('far9').compressed, 'the far chunk is kept compressed');
  assert.equal(c.evictions.decoded, 0, 'nothing was evicted');
  c.insert('mid', meta(0.5), { data: decoded(40), compressed: compressed(20) }, { background: true });
  assert.ok(c.decoded('mid'), 'a background chunk that beats the worst resident does get in');
  assert.equal(c.decoded('near1'), undefined, 'and the worst one is demoted');
});

test('under compressed pressure the copies of decoded chunks go before chunks that exist nowhere else', () => {
  const c = cache({ decodedBytes: 1000, compressedBytes: 75, score: farFrom(0) });
  c.insert('near0', meta(0), { data: decoded(40), compressed: compressed(25) });
  c.insert('near1', meta(1), { data: decoded(40), compressed: compressed(25) });
  c.insert('far9', meta(9), { compressed: compressed(25) });
  assert.equal(c.compressedBytes, 75);
  c.insert('far8', meta(8), { compressed: compressed(25) });
  assert.equal(c.get('far9')?.compressed?.length, 25, 'the far compressed-only chunks stay');
  assert.equal(c.get('far8')?.compressed?.length, 25);
  assert.equal(c.get('near1').compressed, null, 'the copy of the worse-scoring decoded chunk was dropped');
  assert.ok(c.decoded('near0') && c.decoded('near1'), 'the decoded arrays are untouched');
  assert.equal(c.compressedBytes, 75);
  assert.equal(c.evictions.compressed, 1);
});

test('a background chunk may take the place of a decoded chunk\'s copy but not of a better compressed-only chunk', () => {
  const c = cache({ decodedBytes: 1000, compressedBytes: 50, score: farFrom(0) });
  c.insert('near', meta(0), { data: decoded(40), compressed: compressed(25) });
  c.insert('mid', meta(3), { compressed: compressed(25) });
  c.insert('far', meta(9), { compressed: compressed(25) }, { background: true });
  assert.equal(c.get('near').compressed, null, 'the duplicate copy made room');
  assert.ok(c.get('far').compressed && c.get('mid').compressed);
  c.insert('farther', meta(20), { compressed: compressed(25) }, { background: true });
  assert.equal(c.get('farther'), undefined, 'worse than everything compressed-only it would evict: it does not get in');
  assert.ok(c.get('far').compressed && c.get('mid').compressed);
  assert.equal(c.canHoldCompressed(meta(20), 25), false);
  assert.equal(c.canHoldCompressed(meta(1), 25), true);
});

test('pinned keys are never evicted', () => {
  const c = cache({ decodedBytes: 80, compressedBytes: 0, score: farFrom(0) });
  c.insert('k5', meta(5), { data: decoded(40) });
  c.pin(['k5']);
  for (const t of [0, 1, 2]) c.insert(`k${t}`, meta(t), { data: decoded(40) });
  assert.ok(c.decoded('k5'), 'the pinned far chunk survives while nearer ones are evicted');
  assert.equal(c.decoded('k2') && c.decoded('k1') && c.decoded('k0'), undefined, 'only one of the nearer chunks fits beside it');
  c.unpin(['k5']);
  c.insert('k3', meta(3), { data: decoded(40) });
  assert.equal(c.decoded('k5'), undefined, 'released, it is the worst again');
});

test('canHoldDecoded and canHoldCompressed: room, or beating the worst, and false when the tier is off', () => {
  const c = cache({ decodedBytes: 80, compressedBytes: 0, score: farFrom(0) });
  assert.equal(c.canHoldCompressed(meta(1), 10), false, 'budget 0 turns the compressed tier off');
  assert.equal(c.canHoldDecoded(meta(3), 40), true, 'room left');
  c.insert('k2', meta(2), { data: decoded(40) });
  c.insert('k4', meta(4), { data: decoded(40) });
  assert.equal(c.canHoldDecoded(meta(9), 40), false, 'full, and worse than everything');
  assert.equal(c.canHoldDecoded(meta(1), 40), true, 'full, but better than the worst');
});

test('setBudgets shrinks both tiers at once', () => {
  const c = cache({ decodedBytes: 400, compressedBytes: 400, score: farFrom(0) });
  for (const t of [0, 1, 2, 3]) c.insert(`k${t}`, meta(t), { data: decoded(40), compressed: compressed(30) });
  c.setBudgets({ decodedBytes: 80 });
  assert.equal(c.decodedBytes, 80);
  assert.equal(c.compressedBytes, 120, 'untouched');
  c.setBudgets({ compressedBytes: 60 });
  assert.equal(c.compressedBytes, 60);
  assert.ok(c.decoded('k0') && c.decoded('k1'));
});

// ---- speculative allowance ----

function clockAt(start = 0) {
  const clock = { now: start, read: () => clock.now };
  return clock;
}

test('speculative allowance: the initial bytes are available at once, then a share of the measured rate', () => {
  const clock = clockAt();
  const budget = new SpeculativeBudget({ initial: 16_000_000, share: 0.5, burstSeconds: 5, clock: clock.read });
  assert.equal(budget.available(null), 16_000_000);
  assert.equal(budget.waitMs(1_000_000, null), 0);
  budget.spend(16_000_000);
  assert.equal(budget.waitMs(1_000_000, null), Infinity, 'no bandwidth measured and nothing left: wait for a measurement');
  clock.now += 10_000;
  assert.equal(budget.waitMs(1_000_000, null), Infinity, 'time alone earns nothing');
  assert.equal(budget.waitMs(1_000_000, 8_000_000), 250, '1 MB at half of 8 MB/s');
  clock.now += 250;
  assert.ok(Math.abs(budget.available(8_000_000) - 1_000_000) < 1);
  assert.equal(budget.waitMs(1_000_000, 8_000_000), 0);
});

test('speculative allowance saved up is capped at the initial bytes plus a few seconds of the rate', () => {
  const clock = clockAt();
  const budget = new SpeculativeBudget({ initial: 1_000_000, share: 0.5, burstSeconds: 5, clock: clock.read });
  budget.spend(1_000_000);
  clock.now += 3_600_000;
  assert.equal(budget.available(4_000_000), 1_000_000 + 0.5 * 4_000_000 * 5);
});

test('changing the share keeps what was earned at the old share and earns at the new one afterwards', () => {
  const clock = clockAt();
  const budget = new SpeculativeBudget({ initial: 0, share: 0.5, burstSeconds: 100, clock: clock.read });
  assert.equal(budget.share, 0.5);
  clock.now += 2000;
  assert.equal(budget.available(null), 0, 'time before any rate was known earns nothing');
  budget.setShare(0.9, 1_000_000);
  assert.equal(budget.share, 0.9);
  clock.now += 1000;
  budget.setShare(0.5, 1_000_000);
  assert.ok(Math.abs(budget.available(1_000_000) - 900_000) < 1, 'one second at 0.9 of 1 MB/s');
  clock.now += 1000;
  assert.ok(Math.abs(budget.available(1_000_000) - 1_400_000) < 1, 'then a second at 0.5');
  budget.setShare(0.5, 1_000_000);
  assert.equal(budget.share, 0.5);
});

test('a higher share also raises the cap on what may be saved up', () => {
  const clock = clockAt();
  const budget = new SpeculativeBudget({ initial: 1000, share: 0.5, burstSeconds: 5, clock: clock.read });
  budget.setShare(0.9, 2_000_000);
  clock.now += 3_600_000;
  assert.equal(budget.available(2_000_000), 1000 + 0.9 * 2_000_000 * 5);
  budget.setShare(0.5, 2_000_000);
  assert.equal(budget.available(2_000_000), 1000 + 0.5 * 2_000_000 * 5, 'lowering it trims the saved-up amount to the lower cap');
});

test('speculative spend can go negative (a chunk bigger than estimated) and setInitial shifts the allowance', () => {
  const clock = clockAt();
  const budget = new SpeculativeBudget({ initial: 100, share: 0.5, clock: clock.read });
  budget.spend(150);
  assert.equal(budget.available(null), -50);
  budget.setInitial(300);
  assert.equal(budget.available(null), 150);
  budget.setInitial(0);
  assert.equal(budget.available(null), 0, 'never below zero after a change');
});

// ---- bandwidth ----

test('bandwidth is null until a transfer big enough to measure has finished', () => {
  const clock = clockAt();
  const bw = new BandwidthEstimator(clock.read);
  assert.equal(bw.estimate, null);
  bw.begin();
  clock.now += 50;
  bw.end(1000);
  assert.equal(bw.estimate, null, '1 KB in 50 ms says nothing about throughput');
});

test('the estimate is mature after a second of transfer time, however it is spread over requests', () => {
  const clock = clockAt();
  const bw = new BandwidthEstimator(clock.read);
  assert.equal(bw.mature, false);
  bw.begin();
  clock.now += 900;
  bw.end(2_000_000);
  assert.ok(bw.estimate > 0);
  assert.equal(bw.mature, false, '0.9 s of transfer is still young');
  clock.now += 600_000;
  bw.begin();
  clock.now += 200;
  bw.end(500_000);
  assert.equal(bw.mature, true, 'idle time between requests does not count, nor does it make an old estimate young again');
  clock.now += 3_600_000;
  assert.equal(bw.mature, true);
});

test('bandwidth is aggregate: parallel transfers add up instead of each seeing a share', () => {
  const clock = clockAt();
  const bw = new BandwidthEstimator(clock.read);
  // Four 1 MB transfers in parallel over one second: the link carried 4 MB/s.
  for (let i = 0; i < 4; i++) bw.begin();
  clock.now += 1000;
  for (let i = 0; i < 4; i++) bw.end(1_000_000);
  assert.ok(Math.abs(bw.estimate - 4_000_000) < 1, `${bw.estimate}`);
});

test('bandwidth follows the link: an exponential average that weights longer samples more', () => {
  const clock = clockAt();
  const bw = new BandwidthEstimator(clock.read);
  const transfer = (bytes, ms) => {
    bw.begin();
    clock.now += ms;
    bw.end(bytes);
    clock.now += 5000;
  };
  transfer(1_000_000, 1000);
  assert.equal(Math.round(bw.estimate), 1_000_000);
  transfer(10_000_000, 1000);
  assert.ok(bw.estimate > 1_000_000 && bw.estimate < 10_000_000, `moved toward the new rate: ${bw.estimate}`);
  for (let i = 0; i < 10; i++) transfer(10_000_000, 1000);
  assert.ok(Math.abs(bw.estimate - 10_000_000) / 10_000_000 < 0.05, `converged: ${bw.estimate}`);
});

// ---- limiter ----

/** Let queued microtasks and a timer tick run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the limiter keeps the last slots for demand: background jobs stop at max - reserve', async () => {
  const limiter = new RequestLimiter(4, { reserve: 1 });
  const release = [];
  const started = [];
  const job = (priority, name) =>
    limiter.run(priority, undefined, async () => {
      started.push(name);
      await new Promise((resolve) => release.push(resolve));
    });
  const all = ['b1', 'b2', 'b3', 'b4', 'b5'].map((name) => job(1, name));
  assert.equal(limiter.active, 3, 'three background jobs, one slot held back');
  all.push(job(0, 'demand'));
  assert.equal(limiter.active, 4);
  assert.ok(started.includes('demand'), 'demand started at once in the reserved slot');
  assert.deepEqual(started, ['b1', 'b2', 'b3', 'demand']);
  for (let rounds = 0; rounds < 10 && limiter.active + limiter.queued > 0; rounds++) {
    while (release.length) release.shift()();
    await tick();
  }
  await Promise.all(all);
  assert.equal(limiter.active, 0);
});

test('a priority handle lowered later moves a queued job ahead of other background jobs', async () => {
  const limiter = new RequestLimiter(1);
  const order = [];
  const release = [];
  const task = (name) => async () => {
    order.push(name);
    await new Promise((resolve) => release.push(resolve));
  };
  const running = limiter.run(1, undefined, task('running'));
  const handle = { value: 1 };
  const first = limiter.run(1, undefined, task('first'));
  const promoted = limiter.run(handle, undefined, task('promoted'));
  handle.value = 0;
  limiter.reprioritize();
  for (let rounds = 0; rounds < 10 && limiter.active + limiter.queued > 0; rounds++) {
    while (release.length) release.shift()();
    await tick();
  }
  await Promise.all([running, first, promoted]);
  assert.deepEqual(order, ['running', 'promoted', 'first']);
});

// ---- joint cap ----

/** Tier ceilings left open: only the joint cap limits. */
const jointCache = (totalBytes, extra = {}) => new ChunkCache({ totalBytes, score: farFrom(0), ...extra });

test('joint cap: the compressed tier holds what the decoded tier leaves, and gives way as decoded grows', () => {
  const c = jointCache(100);
  c.insert('d0', meta(0), { data: decoded(40) });
  c.insert('c1', meta(1), { compressed: compressed(25) });
  c.insert('c2', meta(2), { compressed: compressed(25) });
  assert.equal(c.usedBytes, 90);
  c.insert('c3', meta(3), { compressed: compressed(25) });
  assert.equal(c.has('c2'), false, 'over the cap: the farthest compressed-only chunk goes');
  assert.equal(c.usedBytes, 90);
  c.insert('d1', meta(0.5), { data: decoded(40) });
  assert.equal(c.decodedBytes, 80, 'a second array fits: the decoded tier is only limited by the cap');
  assert.equal(c.compressedBytes, 0, 'and the compressed chunks, farther than both, made room for it');
  assert.equal(c.usedBytes, 80);
  c.insert('c9', meta(9), { compressed: compressed(15) });
  assert.equal(c.compressedBytes, 15, 'what the decoded tier does not use is the compressed tier\'s');
  assert.equal(c.evictions.decoded, 0);
  assert.equal(c.evictions.compressed, 3);
});

test('joint cap: copies of decoded chunks go before anything that exists nowhere else, however far it is', () => {
  const c = jointCache(100);
  c.insert('far', meta(9), { compressed: compressed(25) });
  c.insert('a', meta(0), { data: decoded(40), compressed: compressed(20) });
  assert.equal(c.usedBytes, 85);
  c.insert('b', meta(1), { data: decoded(30) });
  assert.equal(c.get('a').compressed, null, 'the copy of the nearest chunk was dropped...');
  assert.equal(c.get('far').compressed.length, 25, '...rather than the farthest chunk, which exists nowhere else');
  assert.ok(c.decoded('a') && c.decoded('b'), 'the arrays are untouched');
  assert.equal(c.usedBytes, 95);
  assert.equal(c.evictions.compressed, 1);
  assert.equal(c.evictions.decoded, 0);
});

test('joint cap: a background chunk never displaces a better one; it keeps its bytes if only its array does not fit', () => {
  const c = jointCache(100);
  c.insert('n0', meta(0), { data: decoded(40) });
  c.insert('n1', meta(1), { data: decoded(40) });
  c.insert('far9', meta(9), { data: decoded(40), compressed: compressed(15) }, { background: true });
  assert.equal(c.decoded('far9'), undefined, 'its array would have cost a better chunk its place');
  assert.equal(c.get('far9').compressed.length, 15, 'but its bytes fit and are kept');
  assert.ok(c.decoded('n0') && c.decoded('n1'));
  assert.equal(c.usedBytes, 95);
  assert.equal(c.evictions.decoded + c.evictions.compressed, 0, 'it shed its own copy; nothing was evicted');
  c.insert('far10', meta(10), { compressed: compressed(15) }, { background: true });
  assert.equal(c.get('far10'), undefined, 'no room and nothing worse to evict: it does not get in');
  assert.equal(c.get('far9').compressed.length, 15);
});

test('joint cap: a demand chunk always gets in; the worst chunk loses what it holds, an array without bytes disappears', () => {
  const c = jointCache(100);
  c.insert('n0', meta(0), { data: decoded(40) });
  c.insert('n5', meta(5), { data: decoded(40) });
  c.insert('d1', meta(1), { data: decoded(40) });
  assert.equal(c.has('n5'), false, 'the farthest array went, whole');
  assert.ok(c.decoded('n0') && c.decoded('d1'));
  assert.equal(c.usedBytes, 80);
  assert.equal(c.evictions.decoded, 1);
});

test('joint cap: setBudgets with a smaller cap evicts at once, worst first; pinned chunks stay', () => {
  const c = jointCache(300);
  for (const t of [0, 1]) c.insert(`d${t}`, meta(t), { data: decoded(40) });
  for (const t of [2, 3, 4, 5]) c.insert(`c${t}`, meta(t), { compressed: compressed(25) });
  c.pin(['c5']);
  assert.equal(c.usedBytes, 180);
  c.setBudgets({ totalBytes: 110 });
  assert.equal(c.maxTotal, 110);
  assert.ok(c.usedBytes <= 110);
  assert.ok(c.decoded('d0') && c.decoded('d1'), 'the nearest chunks stay');
  assert.ok(c.get('c5')?.compressed, 'pinned although it is the farthest');
  assert.equal(c.has('c4'), false);
  assert.equal(c.has('c3'), false);
});

test('joint cap: canHoldDecoded and canHoldCompressed ask whether room, a copy to drop, or a worse chunk exists', () => {
  const c = jointCache(100);
  c.insert('n0', meta(0), { data: decoded(40) });
  c.insert('n1', meta(1), { data: decoded(40) });
  assert.equal(c.canHoldCompressed(meta(0.5), 25), true, 'n1 is worse and can be evicted');
  assert.equal(c.canHoldCompressed(meta(9), 25), false, 'full, and worse than everything');
  assert.equal(c.canHoldDecoded(meta(9), 40), false);
  assert.equal(c.canHoldDecoded(meta(0.5), 40), true);
  assert.equal(c.canHoldCompressed(meta(9), 15), true, '80 + 15 fits the cap: room, however far the chunk');
});

test('tier budgets that add up to no more than the total leave the joint cap inert', () => {
  const c = new ChunkCache({ totalBytes: 100, decodedBytes: 60, compressedBytes: 40, score: farFrom(0) });
  for (const t of [0, 1]) c.insert(`k${t}`, meta(t), { data: decoded(30), compressed: compressed(20) });
  assert.equal(c.usedBytes, 100);
  assert.equal(c.canHoldCompressed(meta(0.5), 20), true, 'the copy of a decoded chunk always makes room');
  assert.equal(c.evictions.decoded + c.evictions.compressed, 0);
});
