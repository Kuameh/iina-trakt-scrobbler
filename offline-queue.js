var PENDING_SCROBBLES_PATH = "@data/pending-scrobbles.json";
var MAX_PENDING_SCROBBLES = 100;
var MAX_RECENTLY_SYNCED = 20;

var runtime = {
  file: null,
  log: null,
  trakt: null,
  mediaKey: null,
  onReplaySuccess: null
};

var pendingFlushActive = false;
var activeSyncId = null;
var recentlySynced = [];

function configure(options) {
  runtime.file = options.file;
  runtime.log = typeof options.log === "function" ? options.log : function() {};
  runtime.trakt = options.trakt;
  runtime.mediaKey = options.mediaKey;
  runtime.onReplaySuccess = typeof options.onReplaySuccess === "function"
    ? options.onReplaySuccess
    : function() {};
}

function log(message) {
  runtime.log(message);
}

function loadPendingScrobbles() {
  try {
    var raw = runtime.file.exists(PENDING_SCROBBLES_PATH)
      ? (runtime.file.read(PENDING_SCROBBLES_PATH) || "[]")
      : "[]";
    var items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch (_error) {
    return [];
  }
}

function savePendingScrobbles(items) {
  try {
    runtime.file.write(PENDING_SCROBBLES_PATH, JSON.stringify(items, null, 2));
  } catch (_error) {}
}

function pendingQueueId(mediaInfo, progress) {
  return [
    "stop",
    runtime.mediaKey(mediaInfo),
    String(Math.round(Number(progress || 0) * 100) / 100)
  ].join("|");
}

function addToPendingQueue(verb, mediaInfo, progress) {
  if (verb !== "stop") return;
  var id = pendingQueueId(mediaInfo, progress);
  var items = loadPendingScrobbles();
  if (items.some(function(item) { return item.id === id; })) return;
  if (items.length >= MAX_PENDING_SCROBBLES) {
    items = items.slice(items.length - MAX_PENDING_SCROBBLES + 1);
  }
  items.push({
    id: id,
    verb: "stop",
    mediaInfo: mediaInfo,
    progress: Number(progress || 0),
    queuedAt: new Date().toISOString()
  });
  savePendingScrobbles(items);
  log("Offline queue: saved " + id + " (" + items.length + " pending)");
}

function removeFromPendingQueue(id) {
  var items = loadPendingScrobbles().filter(function(item) { return item.id !== id; });
  savePendingScrobbles(items);
}

function isNetworkError(error) {
  return !error.statusCode;
}

async function flushPendingScrobbles() {
  if (pendingFlushActive) return;
  var initial = loadPendingScrobbles();
  if (!initial.length) return;
  pendingFlushActive = true;
  log("Offline queue: flushing " + initial.length + " pending scrobble(s)");
  try {
    while (true) {
      var items = loadPendingScrobbles();
      if (!items.length) break;
      var item = items[0];
      activeSyncId = item.id;
      log("Offline queue: replaying " + item.id);
      try {
        var result = await runtime.trakt.scrobble(item.verb, item.mediaInfo, item.progress);
        if (result && result.ok) {
          var action = (result.action) ? String(result.action) : item.verb;
          log("Offline queue: replay succeeded for " + item.id + " (action=" + action + ")");
          runtime.onReplaySuccess(item.verb, action, item.mediaInfo);
          recentlySynced.unshift({ id: item.id, mediaInfo: item.mediaInfo, syncedAt: new Date().toISOString() });
          if (recentlySynced.length > MAX_RECENTLY_SYNCED) {
            recentlySynced = recentlySynced.slice(0, MAX_RECENTLY_SYNCED);
          }
          activeSyncId = null;
          removeFromPendingQueue(item.id);
        } else if (result && result.skip) {
          if (result.reason === "auth-required" || result.reason === "missing-client-credentials") {
            log("Offline queue: replay requires auth, pausing flush");
            activeSyncId = null;
            break;
          }
          log("Offline queue: replay permanently skipped for " + item.id + " (" + result.reason + "), dropping");
          activeSyncId = null;
          removeFromPendingQueue(item.id);
        } else if (result && result.duplicate) {
          log("Offline queue: replay already recorded for " + item.id + ", dropping");
          activeSyncId = null;
          removeFromPendingQueue(item.id);
        } else if (result && result.notFound) {
          log("Offline queue: no Trakt match for " + item.id + ", dropping");
          activeSyncId = null;
          removeFromPendingQueue(item.id);
        } else {
          log("Offline queue: unexpected result for " + item.id + ", dropping");
          activeSyncId = null;
          removeFromPendingQueue(item.id);
        }
      } catch (error) {
        activeSyncId = null;
        if (isNetworkError(error)) {
          log("Offline queue: still offline, pausing flush (" + (error.message || String(error)) + ")");
          break;
        }
        log("Offline queue: non-network error for " + item.id + ": " + (error.message || String(error)) + ", dropping");
        removeFromPendingQueue(item.id);
      }
    }
  } finally {
    activeSyncId = null;
    pendingFlushActive = false;
    var remaining = loadPendingScrobbles();
    if (remaining.length) {
      log("Offline queue: " + remaining.length + " scrobble(s) still pending");
    }
  }
}

function getStatus() {
  return {
    pending: loadPendingScrobbles(),
    activeSyncId: activeSyncId,
    recentlySynced: recentlySynced.slice()
  };
}

module.exports = {
  configure: configure,
  addToPendingQueue: addToPendingQueue,
  flushPendingScrobbles: flushPendingScrobbles,
  isNetworkError: isNetworkError,
  loadPendingScrobbles: loadPendingScrobbles,
  getStatus: getStatus
};
