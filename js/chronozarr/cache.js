// Chunk cache in two tiers under one joint byte cap, and the allowance for speculative (prefetch) traffic.
//
// An entry is one chunk. It holds its decoded array (decoded tier: what the viewer reads and uploads), its
// compressed bytes (compressed tier: 0.6 to 0.7 of the size, decoded again in a few milliseconds), or both.
// Chunks near what is on screen are kept decoded; chunks far away survive as compressed bytes only, so the
// same memory reaches further along the time axis. Eviction goes highest `score` first (the store's
// evictionScore: farthest from the view by default least recently used).
//
// Three limits apply: decoded bytes <= maxDecoded, compressed bytes <= maxCompressed (0 turns the tier off), and
// decoded + compressed <= maxTotal. With the ceilings at the total (the default) the compressed tier simply takes
// whatever the decoded tier does not use; with ceilings that add up to no more than the total the tiers are
// independent budgets and the joint cap never acts.
//
// A chunk that is decoded keeps its compressed copy while there is room, so it can be demoted without a refetch.
// Under pressure those copies go first: they duplicate what the decoded tier already holds, and the bytes are
// better spent on chunks that exist nowhere else. Beyond that, the worst-scoring chunk loses its array or its
// bytes, whichever it holds.

export class ChunkCache {
  #entries = new Map();
  #decodedKeys = new Set();
  #compressedKeys = new Set();
  #pinned = new Set();
  #decodedBytes = 0;
  #compressedBytes = 0;
  #clock = 0;
  #score;

  maxTotal;
  maxDecoded;
  maxCompressed;
  /** Entries dropped from the decoded tier / compressed tier for lack of budget. */
  evictions = { decoded: 0, compressed: 0 };

  /**
   * `totalBytes` is the joint cap. A tier budget left out is no ceiling beyond the total; a total left out is the
   * sum of the two tier budgets.
   * @param {{totalBytes?:number, decodedBytes?:number, compressedBytes?:number, score:(entry:object)=>number}} options
   */
  constructor({ totalBytes, decodedBytes, compressedBytes, score }) {
    this.maxDecoded = decodedBytes ?? Infinity;
    this.maxCompressed = compressedBytes ?? Infinity;
    this.maxTotal = totalBytes ?? this.maxDecoded + this.maxCompressed;
    this.#score = score;
  }

  get decodedBytes() {
    return this.#decodedBytes;
  }

  get compressedBytes() {
    return this.#compressedBytes;
  }

  /** The most decoded bytes the cache can hold: the decoded ceiling, or the joint cap if that is smaller. */
  get decodedLimit() {
    return Math.min(this.maxDecoded, this.maxTotal);
  }

  /** The most compressed bytes the cache can hold (0: the tier is off). */
  get compressedLimit() {
    return Math.min(this.maxCompressed, this.maxTotal);
  }

  /** Decoded plus compressed bytes held: what the joint cap limits. */
  get usedBytes() {
    return this.#decodedBytes + this.#compressedBytes;
  }

  /** The entry for a key in either tier, or undefined. Does not count as a use. */
  get(key) {
    return this.#entries.get(key);
  }

  has(key) {
    return this.#entries.has(key);
  }

  touch(entry) {
    entry.used = ++this.#clock;
  }

  /** The decoded array for a key (counts as a use), or undefined. */
  decoded(key) {
    const entry = this.#entries.get(key);
    if (!entry?.data) return undefined;
    entry.used = ++this.#clock;
    return entry.data;
  }

  /** Keep these keys out of eviction until unpin(): a caller that needs them all resident at once. */
  pin(keys) {
    for (const key of keys) this.#pinned.add(key);
  }

  unpin(keys) {
    for (const key of keys) this.#pinned.delete(key);
  }

  /**
   * Store a chunk's decoded array and/or compressed bytes, then evict down to budget. A `background` chunk
   * never displaces a better one: if it scores worse than everything it would evict, it loses its own copy instead.
   * @param {string} key
   * @param {{lod:number,row:number,col:number,t:number}} meta
   * @param {{data?:ArrayBufferView|null, compressed?:Uint8Array|null}} parts
   */
  insert(key, meta, { data = null, compressed = null }, { background = false } = {}) {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { ...meta, key, data: null, compressed: null, used: 0 };
      this.#entries.set(key, entry);
    }
    entry.used = ++this.#clock;
    if (data && !entry.data) {
      entry.data = data;
      this.#decodedKeys.add(key);
      this.#decodedBytes += data.byteLength;
    }
    if (compressed && !entry.compressed) {
      entry.compressed = compressed;
      this.#compressedKeys.add(key);
      this.#compressedBytes += compressed.byteLength;
    }
    this.#shrink(entry, 'data', background);
    this.#shrink(entry, 'compressed', background);
    this.#shrinkJoint(entry, background);
    return entry;
  }

  /** Whether a chunk of `size` decoded bytes would be kept in the decoded tier: room left, or it beats the worst entry. */
  canHoldDecoded(meta, size) {
    if (this.maxDecoded <= 0) return false;
    const fitsTier = this.#decodedBytes + size <= this.maxDecoded || this.#worst(this.#decodedKeys) > this.#scoreOf(meta);
    return fitsTier && this.#fitsJoint(meta, size);
  }

  /** The same for the compressed tier (false when that tier is off); copies of decoded chunks always make room. */
  canHoldCompressed(meta, size) {
    if (this.maxCompressed === 0) return false;
    return this.#fitsCompressedTier(meta, size) && this.#fitsJoint(meta, size);
  }

  #fitsCompressedTier(meta, size) {
    if (this.#compressedBytes + size <= this.maxCompressed) return true;
    let worstCompressedOnly = -Infinity;
    for (const key of this.#compressedKeys) {
      const entry = this.#entries.get(key);
      if (entry.data) return true;
      worstCompressedOnly = Math.max(worstCompressedOnly, this.#score(entry));
    }
    return worstCompressedOnly > this.#scoreOf(meta);
  }

  /** Whether the joint cap leaves room for `size` more bytes of this chunk: free space, a copy to drop, or a worse entry to evict. */
  #fitsJoint(meta, size) {
    if (!this.#jointBinds || this.usedBytes + size <= this.maxTotal) return true;
    const score = this.#scoreOf(meta);
    for (const [key, entry] of this.#entries) {
      if (this.#pinned.has(key)) continue;
      if ((entry.data && entry.compressed) || this.#score(entry) > score) return true;
    }
    return false;
  }

  /** Whether the tier budgets allow more than the joint cap does (when they do not, the cap can never act). */
  get #jointBinds() {
    return this.maxTotal < this.maxDecoded + this.maxCompressed;
  }

  /** Change budgets and evict down to them. */
  setBudgets({ totalBytes = this.maxTotal, decodedBytes = this.maxDecoded, compressedBytes = this.maxCompressed }) {
    this.maxTotal = totalBytes;
    this.maxDecoded = decodedBytes;
    this.maxCompressed = compressedBytes;
    this.#shrink(null, 'data', false);
    this.#shrink(null, 'compressed', false);
    this.#shrinkJoint(null, false);
  }

  clear() {
    this.#entries.clear();
    this.#decodedKeys.clear();
    this.#compressedKeys.clear();
    this.#decodedBytes = 0;
    this.#compressedBytes = 0;
  }

  /** Entries with decoded data and the bytes of each tier. */
  info() {
    return {
      entries: this.#decodedKeys.size,
      bytes: this.#decodedBytes,
      compressedEntries: this.#compressedKeys.size,
      compressedBytes: this.#compressedBytes,
    };
  }

  #scoreOf(meta) {
    return this.#score({ ...meta, used: this.#clock + 1 });
  }

  #worst(keys) {
    let worst = -Infinity;
    for (const key of keys) worst = Math.max(worst, this.#score(this.#entries.get(key)));
    return worst;
  }

  /**
   * The entry to drop from a tier: the highest score; in the compressed tier, first among the copies of chunks that
   * are also decoded. `duplicate` says the victim is such a copy.
   */
  #victim(keys, except, preferDuplicates) {
    let victim = null;
    let victimScore = -Infinity;
    let duplicate = false;
    for (const key of keys) {
      if (key === except?.key || this.#pinned.has(key)) continue;
      const entry = this.#entries.get(key);
      const isDuplicate = preferDuplicates && entry.data !== null;
      const score = this.#score(entry);
      if (victim === null || (isDuplicate && !duplicate) || (isDuplicate === duplicate && score > victimScore)) {
        victim = entry;
        victimScore = score;
        duplicate = isDuplicate;
      }
    }
    return { victim, victimScore, duplicate };
  }

  /** Evict from one tier until it fits; `fresh` is the entry just inserted (never evicted for its own sake). */
  #shrink(fresh, part, background) {
    const decoded = part === 'data';
    const keys = decoded ? this.#decodedKeys : this.#compressedKeys;
    while ((decoded ? this.#decodedBytes > this.maxDecoded : this.#compressedBytes > this.maxCompressed)) {
      const { victim, victimScore, duplicate } = this.#victim(keys, fresh, !decoded);
      if (!victim) {
        if (fresh && fresh[part] && (decoded ? this.maxDecoded : this.maxCompressed) === 0) this.#drop(fresh, part, false);
        return;
      }
      if (background && !duplicate && fresh?.[part] && victimScore <= this.#score(fresh)) {
        this.#drop(fresh, part, false);
        return;
      }
      this.#drop(victim, part, true);
    }
  }

  /**
   * Evict until decoded + compressed fits the joint cap. Copies of decoded chunks go first (highest score first);
   * after that the worst-scoring chunk loses what it holds. A `background` chunk never displaces a better one: it
   * gives up its own array first, then its bytes.
   */
  #shrinkJoint(fresh, background) {
    while (this.usedBytes > this.maxTotal) {
      let victim = null;
      let victimScore = -Infinity;
      let duplicate = false;
      for (const [key, entry] of this.#entries) {
        if (key === fresh?.key || this.#pinned.has(key)) continue;
        const isDuplicate = entry.data !== null && entry.compressed !== null;
        const score = this.#score(entry);
        if (victim === null || (isDuplicate && !duplicate) || (isDuplicate === duplicate && score > victimScore)) {
          victim = entry;
          victimScore = score;
          duplicate = isDuplicate;
        }
      }
      const ownPart = fresh?.data ? 'data' : fresh?.compressed ? 'compressed' : null;
      if (!victim || (background && !duplicate && ownPart && victimScore <= this.#score(fresh))) {
        if (ownPart && background) {
          this.#drop(fresh, ownPart, false);
          continue;
        }
        return;
      }
      this.#drop(victim, duplicate || !victim.data ? 'compressed' : 'data', true);
    }
  }

  #drop(entry, part, counted) {
    if (part === 'data') {
      this.#decodedBytes -= entry.data.byteLength;
      entry.data = null;
      this.#decodedKeys.delete(entry.key);
      if (counted) this.evictions.decoded++;
    } else {
      this.#compressedBytes -= entry.compressed.byteLength;
      entry.compressed = null;
      this.#compressedKeys.delete(entry.key);
      if (counted) this.evictions.compressed++;
    }
    if (!entry.data && !entry.compressed) this.#entries.delete(entry.key);
  }
}

/**
 * How many bytes of speculative (prefetch) traffic may start now. It begins with `initial` bytes (16 MB by
 * default) so a freshly opened store can warm up at once, and earns `share` of the measured download rate
 * after that, up to a few seconds' worth saved. The share can be changed while the store runs (setShare):
 * the store lowers it while a demand read is pending or the bandwidth estimate is young, and raises it when
 * nothing is waiting. Demand requests never spend from the allowance. A store whose bandwidth is still
 * unknown earns nothing beyond the initial allowance.
 */
export class SpeculativeBudget {
  #initial;
  #tokens;
  #share;
  #burstSeconds;
  #clock;
  #last;

  constructor({ initial, share = 0.5, burstSeconds = 5, clock = () => performance.now() }) {
    this.#initial = initial;
    this.#tokens = initial;
    this.#share = share;
    this.#burstSeconds = burstSeconds;
    this.#clock = clock;
    this.#last = clock();
  }

  get initial() {
    return this.#initial;
  }

  get share() {
    return this.#share;
  }

  /** Earn at a different share of the rate from now on; what was earned up to now stays earned at the old share. */
  setShare(share, rate) {
    if (share === this.#share) return;
    this.#refill(rate);
    this.#share = share;
    this.#refill(rate);
  }

  setInitial(initial) {
    this.#tokens = Math.max(0, this.#tokens + initial - this.#initial);
    this.#initial = initial;
  }

  /** Bytes that may be spent right now, given the current download rate (bytes/s, or null if unknown). */
  available(rate) {
    this.#refill(rate);
    return this.#tokens;
  }

  /** Milliseconds until `bytes` may be spent: 0 now, Infinity while no rate is known and the allowance is used up. */
  waitMs(bytes, rate) {
    this.#refill(rate);
    const cap = this.#cap(rate);
    const need = cap > 0 ? Math.min(bytes, cap) : bytes;
    if (this.#tokens >= need) return 0;
    if (!rate) return Infinity;
    return ((need - this.#tokens) / (this.#share * rate)) * 1000;
  }

  /** Spend `bytes` (negative to give back). May go below zero when a chunk turns out larger than estimated. */
  spend(bytes) {
    this.#tokens -= bytes;
  }

  #cap(rate) {
    return this.#initial + (rate ? this.#share * rate * this.#burstSeconds : 0);
  }

  #refill(rate) {
    const now = this.#clock();
    const elapsed = now - this.#last;
    this.#last = now;
    if (rate && elapsed > 0) this.#tokens = Math.min(this.#cap(rate), this.#tokens + (this.#share * rate * elapsed) / 1000);
    else if (this.#tokens > this.#cap(rate)) this.#tokens = this.#cap(rate);
  }
}
