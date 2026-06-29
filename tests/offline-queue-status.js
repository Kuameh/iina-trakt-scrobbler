const assert = require("assert");
const path = require("path");

const QUEUE_PATH = "@data/pending-scrobbles.json";
const SYNCED_PATH = "@data/synced-scrobbles.json";

// ---- Fixtures ----

const movie = {
  type: "movie",
  title: "Inception",
  year: 2010
};

const episode = {
  type: "episode",
  title: "Breaking Bad",
  showTitle: "Breaking Bad",
  season: 5,
  episode: 14
};

const episodeB = {
  type: "episode",
  title: "Better Call Saul",
  showTitle: "Better Call Saul",
  season: 3,
  episode: 1
};

function mediaKey(mediaInfo) {
  if (!mediaInfo) return "";
  if (mediaInfo.type === "episode") {
    return ["episode", mediaInfo.showTitle || mediaInfo.title, mediaInfo.season, mediaInfo.episode, mediaInfo.year || 0].join("|");
  }
  return ["movie", mediaInfo.title, mediaInfo.year || 0].join("|");
}

// ---- Helpers ----

function makeFile(store) {
  return {
    exists(p) { return Object.prototype.hasOwnProperty.call(store, p); },
    read(p) { return Object.prototype.hasOwnProperty.call(store, p) ? store[p] : ""; },
    write(p, v) { store[p] = String(v); }
  };
}

function makeTrakt(handler) {
  return {
    async scrobble(verb, mediaInfo, progress) {
      return handler(verb, mediaInfo, progress);
    }
  };
}

function loadFreshQueue(store, traktHandler, onReplaySuccess) {
  const modulePath = path.resolve(__dirname, "../offline-queue.js");
  delete require.cache[modulePath];
  const q = require("../offline-queue.js");
  q.configure({
    file: makeFile(store),
    log: function() {},
    trakt: makeTrakt(traktHandler || function() { return { ok: true, action: "scrobble" }; }),
    mediaKey: mediaKey,
    onReplaySuccess: onReplaySuccess || function() {}
  });
  return q;
}

function readSynced(store) {
  if (!store[SYNCED_PATH]) return [];
  return JSON.parse(store[SYNCED_PATH]);
}

function networkError() {
  return new Error("curl: (6) Could not resolve host: api.trakt.tv");
}

function httpError(statusCode) {
  const err = new Error("HTTP error " + statusCode);
  err.statusCode = statusCode;
  return err;
}

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .catch(function(error) {
      error.message = name + ": " + error.message;
      throw error;
    });
}

// ---- Tests ----

async function run() {

  // getStatus — initial state

  await test("getStatus returns empty pending and recentlySynced when queue is empty", function() {
    const q = loadFreshQueue({});
    const status = q.getStatus();
    assert.deepStrictEqual(status.pending, []);
    assert.deepStrictEqual(status.recentlySynced, []);
  });

  await test("getStatus returns null activeSyncId when not flushing", function() {
    const q = loadFreshQueue({});
    assert.strictEqual(q.getStatus().activeSyncId, null);
  });

  await test("getStatus returns flushing false when not flushing", function() {
    const q = loadFreshQueue({});
    assert.strictEqual(q.getStatus().flushing, false);
  });

  await test("getStatus returns pending items from disk", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 85);
    const status = q.getStatus();
    assert.strictEqual(status.pending.length, 2);
    assert.deepStrictEqual(status.pending[0].mediaInfo, movie);
    assert.deepStrictEqual(status.pending[1].mediaInfo, episode);
  });

  await test("getStatus pending items include id, verb, progress and queuedAt", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", movie, 92);
    const item = q.getStatus().pending[0];
    assert.ok(typeof item.id === "string" && item.id.length > 0);
    assert.strictEqual(item.verb, "stop");
    assert.strictEqual(item.progress, 92);
    assert.ok(typeof item.queuedAt === "string" && item.queuedAt.length > 0);
  });

  await test("getStatus recentlySynced is empty before any flush", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", movie, 92);
    assert.deepStrictEqual(q.getStatus().recentlySynced, []);
  });

  // getStatus — flushing flag

  await test("getStatus flushing is true while flush is in progress", async function() {
    const store = {};
    let observedFlushing = false;
    let resolveBlock;
    const blocked = new Promise(function(r) { resolveBlock = r; });

    const q = loadFreshQueue(store, async function() {
      observedFlushing = q.getStatus().flushing;
      await blocked;
      return { ok: true, action: "scrobble" };
    });

    q.addToPendingQueue("stop", movie, 92);
    const flush = q.flushPendingScrobbles();
    resolveBlock();
    await flush;

    assert.strictEqual(observedFlushing, true);
  });

  await test("getStatus flushing is false after flush completes", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().flushing, false);
  });

  await test("getStatus flushing is false after flush pauses on network error", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { throw networkError(); });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().flushing, false);
  });

  await test("getStatus flushing is false after flush pauses on auth-required", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() {
      return { ok: false, skip: true, reason: "auth-required" };
    });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().flushing, false);
  });

  // getStatus — activeSyncId during flush

  await test("activeSyncId reflects current item id while sync is in progress", async function() {
    const store = {};
    let observedId = "not-set";
    let resolveBlock;
    const blocked = new Promise(function(r) { resolveBlock = r; });

    const q = loadFreshQueue(store, async function() {
      observedId = q.getStatus().activeSyncId;
      await blocked;
      return { ok: true, action: "scrobble" };
    });

    q.addToPendingQueue("stop", movie, 92);
    const expectedId = q.getStatus().pending[0].id;

    const flush = q.flushPendingScrobbles();
    resolveBlock();
    await flush;

    assert.strictEqual(observedId, expectedId);
  });

  await test("activeSyncId is null after successful flush completes", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().activeSyncId, null);
  });

  await test("activeSyncId is null after flush pauses on network error", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { throw networkError(); });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().activeSyncId, null);
  });

  await test("activeSyncId is null after flush pauses on auth-required", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() {
      return { ok: false, skip: true, reason: "auth-required" };
    });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().activeSyncId, null);
  });

  await test("activeSyncId is null after flush pauses on missing-client-credentials", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() {
      return { ok: false, skip: true, reason: "missing-client-credentials" };
    });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().activeSyncId, null);
  });

  await test("activeSyncId is null after flush drops item on non-network error", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { throw httpError(500); });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().activeSyncId, null);
  });

  await test("activeSyncId advances to next item id during multi-item flush", async function() {
    const store = {};
    const observedIds = [];
    const q = loadFreshQueue(store, function(verb, info) {
      observedIds.push(q.getStatus().activeSyncId);
      return { ok: true, action: "scrobble" };
    });
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 85);
    const ids = q.getStatus().pending.map(function(i) { return i.id; });
    await q.flushPendingScrobbles();
    assert.deepStrictEqual(observedIds, ids);
  });

  // recentlySynced — population

  await test("recentlySynced contains item after successful flush", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    const synced = q.getStatus().recentlySynced;
    assert.strictEqual(synced.length, 1);
    assert.deepStrictEqual(synced[0].mediaInfo, movie);
  });

  await test("recentlySynced item has a syncedAt ISO timestamp", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    const item = q.getStatus().recentlySynced[0];
    assert.ok(typeof item.syncedAt === "string" && item.syncedAt.length > 0);
    assert.ok(!isNaN(new Date(item.syncedAt).getTime()));
  });

  await test("recentlySynced item has the same id as the queued item", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q.addToPendingQueue("stop", movie, 92);
    const queuedId = q.getStatus().pending[0].id;
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().recentlySynced[0].id, queuedId);
  });

  await test("recentlySynced accumulates items across multiple flushes", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    q.addToPendingQueue("stop", episode, 85);
    await q.flushPendingScrobbles();
    assert.strictEqual(q.getStatus().recentlySynced.length, 2);
  });

  await test("recentlySynced orders newest first (most recent sync at index 0)", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 85);
    await q.flushPendingScrobbles();
    const synced = q.getStatus().recentlySynced;
    assert.strictEqual(synced.length, 2);
    assert.deepStrictEqual(synced[0].mediaInfo, episode);
    assert.deepStrictEqual(synced[1].mediaInfo, movie);
  });

  // recentlySynced — not populated for non-success outcomes

  await test("recentlySynced not populated when item is dropped as duplicate", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: false, duplicate: true }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.deepStrictEqual(q.getStatus().recentlySynced, []);
  });

  await test("recentlySynced not populated when item is dropped as notFound", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: false, notFound: true }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.deepStrictEqual(q.getStatus().recentlySynced, []);
  });

  await test("recentlySynced not populated when flush pauses on network error", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { throw networkError(); });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.deepStrictEqual(q.getStatus().recentlySynced, []);
  });

  await test("recentlySynced not populated when item is dropped on non-network error", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { throw httpError(500); });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.deepStrictEqual(q.getStatus().recentlySynced, []);
  });

  await test("recentlySynced not populated when flush pauses on auth-required", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() {
      return { ok: false, skip: true, reason: "auth-required" };
    });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.deepStrictEqual(q.getStatus().recentlySynced, []);
  });

  await test("recentlySynced not populated for other skip reasons (item dropped)", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() {
      return { ok: false, skip: true, reason: "stop-too-early" };
    });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.deepStrictEqual(q.getStatus().recentlySynced, []);
  });

  await test("recentlySynced only includes succeeded items when mixed outcomes occur", async function() {
    const store = {};
    const q = loadFreshQueue(store, function(verb, info) {
      if (mediaKey(info) === mediaKey(movie)) return { ok: true, action: "scrobble" };
      return { ok: false, duplicate: true };
    });
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 85);
    await q.flushPendingScrobbles();
    const synced = q.getStatus().recentlySynced;
    assert.strictEqual(synced.length, 1);
    assert.deepStrictEqual(synced[0].mediaInfo, movie);
  });

  // recentlySynced — cap at 50

  await test("recentlySynced is capped at 50 items (oldest dropped)", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    for (var i = 0; i < 52; i++) {
      q.addToPendingQueue("stop", { type: "movie", title: "Movie " + i, year: 2000 + i }, 90);
      await q.flushPendingScrobbles();
    }
    const synced = q.getStatus().recentlySynced;
    assert.strictEqual(synced.length, 50);
    assert.strictEqual(synced[0].mediaInfo.title, "Movie 51");
    assert.strictEqual(synced[49].mediaInfo.title, "Movie 2");
  });

  // persistence — synced history survives across instances

  await test("recentlySynced persists to disk and is readable by a fresh instance", async function() {
    const store = {};
    const q1 = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q1.addToPendingQueue("stop", movie, 92);
    await q1.flushPendingScrobbles();

    const q2 = loadFreshQueue(store);
    const synced = q2.getStatus().recentlySynced;
    assert.strictEqual(synced.length, 1);
    assert.deepStrictEqual(synced[0].mediaInfo, movie);
  });

  await test("recentlySynced from a previous session is prepended to by a new flush", async function() {
    const store = {};
    const q1 = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q1.addToPendingQueue("stop", movie, 92);
    await q1.flushPendingScrobbles();

    const q2 = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q2.addToPendingQueue("stop", episode, 85);
    await q2.flushPendingScrobbles();

    const synced = q2.getStatus().recentlySynced;
    assert.strictEqual(synced.length, 2);
    assert.deepStrictEqual(synced[0].mediaInfo, episode);
    assert.deepStrictEqual(synced[1].mediaInfo, movie);
  });

  await test("loadSyncedScrobbles returns empty array when file does not exist", function() {
    const store = {};
    const q = loadFreshQueue(store);
    assert.deepStrictEqual(q.loadSyncedScrobbles(), []);
  });

  await test("loadSyncedScrobbles tolerates corrupt synced file", function() {
    const store = { [SYNCED_PATH]: "not valid json {{" };
    const q = loadFreshQueue(store);
    assert.deepStrictEqual(q.loadSyncedScrobbles(), []);
  });

  await test("recentlySynced cap is enforced across sessions (fresh instance reads capped history)", async function() {
    const store = {};
    const q1 = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    for (var i = 0; i < 50; i++) {
      q1.addToPendingQueue("stop", { type: "movie", title: "Old " + i, year: 2000 }, 90);
      await q1.flushPendingScrobbles();
    }
    assert.strictEqual(readSynced(store).length, 50);

    const q2 = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q2.addToPendingQueue("stop", { type: "movie", title: "New", year: 2025 }, 90);
    await q2.flushPendingScrobbles();

    const synced = readSynced(store);
    assert.strictEqual(synced.length, 50);
    assert.strictEqual(synced[0].mediaInfo.title, "New");
  });

  console.log("offline queue getStatus tests passed");
}

run().catch(function(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
