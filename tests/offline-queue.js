const assert = require("assert");
const path = require("path");

const QUEUE_PATH = "@data/pending-scrobbles.json";

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

function loadFreshQueue(store, traktHandler, logs) {
  const modulePath = path.resolve(__dirname, "../offline-queue.js");
  delete require.cache[modulePath];
  const q = require("../offline-queue.js");
  q.configure({
    file: makeFile(store),
    log: function(msg) { if (logs) logs.push(msg); },
    trakt: makeTrakt(traktHandler || function() { return { ok: true, action: "scrobble" }; }),
    mediaKey: mediaKey,
    onReplaySuccess: function() {}
  });
  return q;
}

function loadFreshQueueWithCallbacks(store, traktHandler, logs, onReplaySuccess) {
  const modulePath = path.resolve(__dirname, "../offline-queue.js");
  delete require.cache[modulePath];
  const q = require("../offline-queue.js");
  q.configure({
    file: makeFile(store),
    log: function(msg) { if (logs) logs.push(msg); },
    trakt: makeTrakt(traktHandler || function() { return { ok: true, action: "scrobble" }; }),
    mediaKey: mediaKey,
    onReplaySuccess: onReplaySuccess || function() {}
  });
  return q;
}

function readQueue(store) {
  if (!store[QUEUE_PATH]) return [];
  return JSON.parse(store[QUEUE_PATH]);
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

  // isNetworkError
  await test("isNetworkError returns true when error has no statusCode", function() {
    const q = loadFreshQueue({});
    assert.strictEqual(q.isNetworkError(new Error("curl: (6) no network")), true);
  });

  await test("isNetworkError returns false when error has statusCode", function() {
    const q = loadFreshQueue({});
    assert.strictEqual(q.isNetworkError(httpError(500)), false);
  });

  await test("isNetworkError returns false for 401", function() {
    const q = loadFreshQueue({});
    assert.strictEqual(q.isNetworkError(httpError(401)), false);
  });

  // addToPendingQueue — verb filtering
  await test("addToPendingQueue ignores start verb", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("start", movie, 10);
    assert.deepStrictEqual(readQueue(store), []);
  });

  await test("addToPendingQueue ignores pause verb", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("pause", movie, 55);
    assert.deepStrictEqual(readQueue(store), []);
  });

  await test("addToPendingQueue accepts stop verb", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", movie, 92);
    const items = readQueue(store);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].verb, "stop");
    assert.strictEqual(items[0].progress, 92);
    assert.deepStrictEqual(items[0].mediaInfo, movie);
  });

  // addToPendingQueue — id and deduplication
  await test("addToPendingQueue deduplicates identical stop scrobbles", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", movie, 92);
    assert.strictEqual(readQueue(store).length, 1);
  });

  await test("addToPendingQueue treats different media as separate entries", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 92);
    assert.strictEqual(readQueue(store).length, 2);
  });

  await test("addToPendingQueue treats different progress as separate entries", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", movie, 45);
    q.addToPendingQueue("stop", movie, 92);
    assert.strictEqual(readQueue(store).length, 2);
  });

  await test("addToPendingQueue rounds progress to 2 decimal places for id", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", movie, 92.001);
    q.addToPendingQueue("stop", movie, 92.004);
    // both round to 92, same id → only one entry
    assert.strictEqual(readQueue(store).length, 1);
  });

  await test("addToPendingQueue stores queuedAt timestamp", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", movie, 92);
    const item = readQueue(store)[0];
    assert.ok(typeof item.queuedAt === "string" && item.queuedAt.length > 0);
  });

  // addToPendingQueue — cap
  await test("addToPendingQueue caps queue at 100 entries by dropping oldest", function() {
    const store = {};
    const q = loadFreshQueue(store);
    // fill with 100 unique movies
    for (var i = 0; i < 100; i++) {
      q.addToPendingQueue("stop", { type: "movie", title: "Movie " + i, year: 2000 }, 90);
    }
    assert.strictEqual(readQueue(store).length, 100);
    // adding one more should drop the oldest
    q.addToPendingQueue("stop", { type: "movie", title: "Movie 100", year: 2000 }, 90);
    const items = readQueue(store);
    assert.strictEqual(items.length, 100);
    assert.strictEqual(items[0].mediaInfo.title, "Movie 1");
    assert.strictEqual(items[99].mediaInfo.title, "Movie 100");
  });

  // addToPendingQueue — persistence across fresh instances
  await test("addToPendingQueue persists queue so a new instance can read it", function() {
    const store = {};
    const q1 = loadFreshQueue(store);
    q1.addToPendingQueue("stop", movie, 92);

    const q2 = loadFreshQueue(store);
    const items = q2.loadPendingScrobbles();
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].mediaInfo, movie);
  });

  // flushPendingScrobbles — empty queue
  await test("flushPendingScrobbles does nothing with empty queue", async function() {
    const store = {};
    const calls = [];
    const q = loadFreshQueue(store, function() { calls.push("scrobble"); return { ok: true }; });
    await q.flushPendingScrobbles();
    assert.strictEqual(calls.length, 0);
  });

  // flushPendingScrobbles — success
  await test("flushPendingScrobbles replays item and removes it on success", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    q.addToPendingQueue("stop", movie, 92);
    assert.strictEqual(readQueue(store).length, 1);
    await q.flushPendingScrobbles();
    assert.strictEqual(readQueue(store).length, 0);
  });

  await test("flushPendingScrobbles calls onReplaySuccess with verb, action and mediaInfo", async function() {
    const store = {};
    const successCalls = [];
    const modulePath = path.resolve(__dirname, "../offline-queue.js");
    delete require.cache[modulePath];
    const q = require("../offline-queue.js");
    q.configure({
      file: makeFile(store),
      log: function() {},
      trakt: makeTrakt(function() { return { ok: true, action: "scrobble" }; }),
      mediaKey: mediaKey,
      onReplaySuccess: function(verb, action, info) { successCalls.push({ verb, action, info }); }
    });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(successCalls.length, 1);
    assert.strictEqual(successCalls[0].verb, "stop");
    assert.strictEqual(successCalls[0].action, "scrobble");
    assert.deepStrictEqual(successCalls[0].info, movie);
  });

  await test("flushPendingScrobbles passes correct verb, mediaInfo and progress to trakt.scrobble", async function() {
    const store = {};
    const scrobbleCalls = [];
    const q = loadFreshQueue(store, function(verb, info, progress) {
      scrobbleCalls.push({ verb, info, progress });
      return { ok: true, action: "scrobble" };
    });
    q.addToPendingQueue("stop", episode, 88);
    await q.flushPendingScrobbles();
    assert.strictEqual(scrobbleCalls.length, 1);
    assert.strictEqual(scrobbleCalls[0].verb, "stop");
    assert.deepStrictEqual(scrobbleCalls[0].info, episode);
    assert.strictEqual(scrobbleCalls[0].progress, 88);
  });

  // flushPendingScrobbles — network error
  await test("flushPendingScrobbles keeps item in queue when network error occurs", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { throw networkError(); });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(readQueue(store).length, 1);
  });

  await test("flushPendingScrobbles stops after first network error leaving remaining items", async function() {
    const store = {};
    let calls = 0;
    const q = loadFreshQueue(store, function() {
      calls++;
      throw networkError();
    });
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 85);
    await q.flushPendingScrobbles();
    assert.strictEqual(calls, 1);
    assert.strictEqual(readQueue(store).length, 2);
  });

  // flushPendingScrobbles — duplicate
  await test("flushPendingScrobbles drops item on duplicate result", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: false, duplicate: true }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(readQueue(store).length, 0);
  });

  // flushPendingScrobbles — notFound
  await test("flushPendingScrobbles drops item when Trakt returns notFound", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: false, notFound: true }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(readQueue(store).length, 0);
  });

  // flushPendingScrobbles — skip reasons
  await test("flushPendingScrobbles pauses on auth-required and keeps item", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { return { ok: false, skip: true, reason: "auth-required" }; });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(readQueue(store).length, 1);
  });

  await test("flushPendingScrobbles pauses on missing-client-credentials and keeps item", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() {
      return { ok: false, skip: true, reason: "missing-client-credentials" };
    });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(readQueue(store).length, 1);
  });

  await test("flushPendingScrobbles drops item on other skip reasons and continues", async function() {
    const store = {};
    let calls = 0;
    const q = loadFreshQueue(store, function(verb, info) {
      calls++;
      if (mediaKey(info) === mediaKey(movie)) return { ok: false, skip: true, reason: "stop-too-early" };
      return { ok: true, action: "scrobble" };
    });
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 88);
    await q.flushPendingScrobbles();
    assert.strictEqual(calls, 2);
    assert.strictEqual(readQueue(store).length, 0);
  });

  // flushPendingScrobbles — non-network throw
  await test("flushPendingScrobbles drops item on non-network error (e.g. bad response parsing)", async function() {
    const store = {};
    const q = loadFreshQueue(store, function() { throw httpError(500); });
    q.addToPendingQueue("stop", movie, 92);
    await q.flushPendingScrobbles();
    assert.strictEqual(readQueue(store).length, 0);
  });

  await test("flushPendingScrobbles continues to next item after non-network error", async function() {
    const store = {};
    let calls = 0;
    const q = loadFreshQueue(store, function(verb, info) {
      calls++;
      if (mediaKey(info) === mediaKey(movie)) throw httpError(500);
      return { ok: true, action: "scrobble" };
    });
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 88);
    await q.flushPendingScrobbles();
    assert.strictEqual(calls, 2);
    assert.strictEqual(readQueue(store).length, 0);
  });

  // flushPendingScrobbles — ordering
  await test("flushPendingScrobbles replays items oldest first", async function() {
    const store = {};
    const order = [];
    const q = loadFreshQueue(store, function(verb, info) {
      order.push(info.title);
      return { ok: true, action: "scrobble" };
    });
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 88);
    q.addToPendingQueue("stop", episodeB, 75);
    await q.flushPendingScrobbles();
    assert.deepStrictEqual(order, [movie.title, episode.showTitle, episodeB.showTitle]);
  });

  // flushPendingScrobbles — partial flush on network error mid-queue
  await test("flushPendingScrobbles removes successful items before hitting network error", async function() {
    const store = {};
    let calls = 0;
    const q = loadFreshQueue(store, function(verb, info) {
      calls++;
      if (mediaKey(info) === mediaKey(episodeB)) throw networkError();
      return { ok: true, action: "scrobble" };
    });
    q.addToPendingQueue("stop", movie, 92);
    q.addToPendingQueue("stop", episode, 88);
    q.addToPendingQueue("stop", episodeB, 75);
    await q.flushPendingScrobbles();
    assert.strictEqual(calls, 3);
    const remaining = readQueue(store);
    assert.strictEqual(remaining.length, 1);
    assert.deepStrictEqual(remaining[0].mediaInfo, episodeB);
  });

  // flushPendingScrobbles — single-flight lock
  await test("concurrent flushPendingScrobbles calls do not double-replay", async function() {
    const store = {};
    let scrobbleCalls = 0;
    let resolveFirst;
    const firstCallBlocked = new Promise(function(resolve) { resolveFirst = resolve; });

    const q = loadFreshQueue(store, async function() {
      scrobbleCalls++;
      await firstCallBlocked;
      return { ok: true, action: "scrobble" };
    });
    q.addToPendingQueue("stop", movie, 92);

    const first = q.flushPendingScrobbles();
    const second = q.flushPendingScrobbles(); // should be a no-op (lock held)
    resolveFirst();
    await Promise.all([first, second]);

    assert.strictEqual(scrobbleCalls, 1);
    assert.strictEqual(readQueue(store).length, 0);
  });

  // flushPendingScrobbles — tolerates corrupt queue file
  await test("flushPendingScrobbles handles corrupt queue file gracefully", async function() {
    const store = { [QUEUE_PATH]: "not valid json {{" };
    const q = loadFreshQueue(store, function() { return { ok: true, action: "scrobble" }; });
    // should not throw
    await q.flushPendingScrobbles();
  });

  // loadPendingScrobbles — tolerates missing file
  await test("loadPendingScrobbles returns empty array when file does not exist", function() {
    const store = {};
    const q = loadFreshQueue(store);
    assert.deepStrictEqual(q.loadPendingScrobbles(), []);
  });

  // addToPendingQueue — tolerates missing mediaInfo fields
  await test("addToPendingQueue handles minimal mediaInfo without crashing", function() {
    const store = {};
    const q = loadFreshQueue(store);
    q.addToPendingQueue("stop", { type: "movie", title: "Unknown" }, 90);
    assert.strictEqual(readQueue(store).length, 1);
  });

  console.log("offline queue tests passed");
}

run().catch(function(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
