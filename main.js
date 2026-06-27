const { core, event, file, preferences, utils, sidebar, menu } = iina;

var parser = require("./parser.iina.js");
var monitor = require("./monitor.js");
var trakt = require("./trakt.js");
var PLUGIN_VERSION = "0.1.36";
var DEBUG_LOG_PATH = "@data/debug.log";
var MAX_DEBUG_LOG_CHARS = 200000;
var PENDING_SCROBBLES_PATH = "@data/pending-scrobbles.json";
var MAX_PENDING_SCROBBLES = 100;
var pendingFlushActive = false;
var POLL_INTERVAL_MS = 2000;
var UI_POLL_INTERVAL_MS = 750;
var PLUGIN_SIDEBAR_ID = "plugin:io.github.fahim.iinatraktscrobbler";
var currentMedia = null;
var lastSourceSignature = "";
var playbackState = createPlaybackState();
var pollTimer = null;
var uiPollTimer = null;
var sidebarHandlersBound = false;
var firstScrobbleNoticeShown = false;
var missingCredentialsNoticeShown = false;
var authRequiredNoticeShown = false;
var guessitFailureLogged = false;
var lastHandledAuthActionNonce = "";
var lastAuthStatusSignature = "";
var authActionChain = Promise.resolve();
var sidebarRefreshChain = Promise.resolve();
var lastScrobbleStatus = createScrobbleStatus();
var correctionState = createCorrectionState();

function createPlaybackState() {
  return {
    prevSnapshot: null,
    preview: false,
    fastPause: false,
    scrobbleBuffer: null,
    previewTimer: null,
    fastPauseTimer: null,
    lastScrobbleKey: "",
    scrobbleChain: Promise.resolve()
  };
}

function createScrobbleStatus() {
  return {
    status: "idle",
    verb: "",
    action: "",
    mediaLabel: "",
    detail: "No scrobble has been attempted in this window yet.",
    reason: "",
    progress: null,
    updatedAt: ""
  };
}

function createCorrectionState() {
  return {
    active: false,
    busy: false,
    query: "",
    reference: "",
    error: "",
    mediaLabel: "",
    mediaKey: "",
    results: []
  };
}

trakt.configure({
  file: file,
  preferences: preferences,
  utils: utils,
  logger: function(message) {
    log(message);
  },
  notify: function(message) {
    importantOsd(message);
  }
});

function appendDebugLog(message) {
  var line = "[" + new Date().toISOString() + "] " + message;
  try {
    var existing = file.exists(DEBUG_LOG_PATH) ? (file.read(DEBUG_LOG_PATH) || "") : "";
    var next = existing + line + "\n";
    if (next.length > MAX_DEBUG_LOG_CHARS) {
      next = next.slice(next.length - MAX_DEBUG_LOG_CHARS);
    }
    file.write(DEBUG_LOG_PATH, next);
  } catch (_error) {}
}

function log(message) {
  iina.console.log("[IINATraktScrobbler] " + message);
  appendDebugLog("[IINATraktScrobbler] " + message);
}

function errStr(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.message || String(error);
}

function logGuessitFailureOnce() {
  if (guessitFailureLogged || !parser || typeof parser.getDiagnostics !== "function") return;

  var diagnostics = parser.getDiagnostics();
  if (!diagnostics) return;
  if (
    diagnostics.guessitStatus !== "load-failed" &&
    diagnostics.guessitStatus !== "unconfigured" &&
    diagnostics.guessitStatus !== "runtime-failed"
  ) return;

  guessitFailureLogged = true;
  if (diagnostics.guessitStatus === "runtime-failed") {
    log("Guessit runtime failed: " + diagnostics.guessitError);
    return;
  }

  log("Guessit unavailable: " + diagnostics.guessitLoadError);
}

function prefBool(key, fallbackValue) {
  var value = preferences.get(key);
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallbackValue;
}

function prefNumber(key, fallbackValue) {
  var value = Number(preferences.get(key));
  return isFinite(value) ? value : fallbackValue;
}

function debugOsd(message) {
  if (!prefBool("debug_osd", false)) return;
  try {
    core.osd("Trakt Scrobbler: " + message);
  } catch (_error) {}
}

function statusOsd(message) {
  if (!prefBool("status_osd", true)) return;
  try {
    core.osd(message);
  } catch (_error) {}
}

function importantOsd(message) {
  try {
    core.osd("Trakt Scrobbler: " + message);
  } catch (_error) {}
}

function successfulScrobbleAction(verb, result) {
  if (result && result.action) {
    return String(result.action);
  }
  return verb;
}

function successfulScrobbleProgress(payloadProgress, result) {
  if (result && isFinite(Number(result.progress))) {
    return Number(result.progress);
  }
  return Number(payloadProgress || 0);
}

function successfulScrobbleDetail(action, progress) {
  var value = Number(progress || 0);
  if (!isFinite(value)) value = 0;
  if (action === "scrobble") return "Trakt marked this as watched at " + value.toFixed(2) + "%.";
  if (action === "pause") return "Trakt saved playback progress at " + value.toFixed(2) + "%.";
  if (action === "start") return "Trakt accepted playback at " + value.toFixed(2) + "%.";
  return "Trakt accepted this scrobble at " + value.toFixed(2) + "%.";
}

function truncateOsdText(value, maxLength) {
  var text = String(value || "").trim();
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 1)).trim() + "…";
}

function osdMediaLabel(mediaInfo) {
  if (!mediaInfo) return "";

  if (mediaInfo.type === "episode") {
    var episodeCode = "S" + pad2(mediaInfo.season) + "E" + pad2(mediaInfo.episode);
    if (mediaInfo.episodeTitle) {
      return truncateOsdText(episodeCode + " - " + mediaInfo.episodeTitle, 64);
    }
    return truncateOsdText((mediaInfo.showTitle || mediaInfo.title || "") + " " + episodeCode, 64);
  }

  return truncateOsdText(mediaInfo.title + (mediaInfo.year ? (" (" + mediaInfo.year + ")") : ""), 64);
}

function showScrobbleStatusOsd(title, mediaInfo) {
  if (!prefBool("status_osd", true)) return;

  var message = String(title || "").trim();
  var label = osdMediaLabel(mediaInfo);
  if (label) {
    message += ": " + label;
  }

  statusOsd(message);
}

function maybeShowScrobbleStatusOsd(verb, action, mediaInfo) {
  if (action === "scrobble") {
    showScrobbleStatusOsd("Watched on Trakt", mediaInfo);
    return;
  }

  if (action === "pause") {
    showScrobbleStatusOsd("Progress Saved", mediaInfo);
    return;
  }

  if (verb === "start") {
    showScrobbleStatusOsd("Scrobble Started", mediaInfo);
    return;
  }

  if (verb === "stop") {
    showScrobbleStatusOsd("Stopped on Trakt", mediaInfo);
  }
}

function setStatusOsdEnabled(enabled) {
  var nextValue = !!enabled;
  var prevValue = prefBool("status_osd", true);
  if (nextValue === prevValue) {
    queueSidebarRefresh(false);
    return;
  }

  persistPreferences({
    status_osd: nextValue
  });

  log("Trakt status OSD " + (nextValue ? "enabled" : "disabled"));
  queueSidebarRefresh(false);
}

function persistPreferences(values) {
  Object.keys(values || {}).forEach(function(key) {
    preferences.set(key, values[key]);
  });

  if (typeof preferences.sync === "function") {
    try {
      preferences.sync();
    } catch (_error) {}
  }
}

function authStatusSignature(status) {
  return JSON.stringify({
    state: status.state,
    summary: status.summary,
    detail: status.detail,
    busy: !!status.busy,
    connected: !!status.connected,
    credentialMode: status.credentialMode
  });
}

function persistAuthStatus(status) {
  var resolved = status || trakt.getAuthStatus();
  var signature = authStatusSignature(resolved);
  var payload = {
    auth_state: resolved.state,
    auth_summary: resolved.summary,
    auth_detail: resolved.detail || "",
    auth_busy: !!resolved.busy,
    auth_connected: !!resolved.connected,
    auth_credential_mode: resolved.credentialMode || ""
  };

  if (signature !== lastAuthStatusSignature) {
    payload.auth_updated_at = new Date().toISOString();
    lastAuthStatusSignature = signature;
  }

  persistPreferences(payload);
  return resolved;
}

function stateName(state) {
  if (state === monitor.State.Playing) return "playing";
  if (state === monitor.State.Paused) return "paused";
  if (state === monitor.State.Stopped) return "stopped";
  return core.status.idle ? "idle" : (core.status.paused ? "paused" : "playing");
}

function cloneScrobbleStatus(status) {
  return {
    status: status.status,
    verb: status.verb,
    action: status.action,
    mediaLabel: status.mediaLabel,
    detail: status.detail,
    reason: status.reason,
    progress: status.progress,
    updatedAt: status.updatedAt
  };
}

function cloneCorrectionState(state) {
  var source = state || createCorrectionState();
  return {
    active: !!source.active,
    busy: !!source.busy,
    query: String(source.query || ""),
    reference: String(source.reference || ""),
    error: String(source.error || ""),
    mediaLabel: String(source.mediaLabel || ""),
    mediaKey: String(source.mediaKey || ""),
    results: Array.isArray(source.results)
      ? source.results.map(function(result) {
          return {
            trakt: Number(result.trakt || 0),
            kind: String(result.kind || ""),
            title: String(result.title || ""),
            subtitle: String(result.subtitle || ""),
            detail: String(result.detail || ""),
            year: result.year ? Number(result.year) : null,
            posterUrl: String(result.posterUrl || "")
          };
        })
      : []
  };
}

function setScrobbleStatus(values) {
  var incoming = values || {};
  var next = Object.assign({}, lastScrobbleStatus, incoming);
  if (!Object.prototype.hasOwnProperty.call(incoming, "reason") &&
      incoming.status !== "skipped" &&
      incoming.status !== "disabled") {
    next.reason = "";
  }
  if (!Object.prototype.hasOwnProperty.call(incoming, "action")) {
    next.action = "";
  }

  lastScrobbleStatus = Object.assign({}, next, {
    updatedAt: new Date().toISOString()
  });
  queueSidebarRefresh(false);
}

function showSidebarTab() {
  try {
    if (sidebar && typeof sidebar.show === "function") {
      sidebar.show();
      return;
    }
  } catch (_error) {}

  try {
    if (core.window) {
      core.window.sidebar = PLUGIN_SIDEBAR_ID;
    }
  } catch (_error) {}
}

function registerMenuItems() {
  if (!menu || typeof menu.addItem !== "function" || typeof menu.item !== "function") {
    return;
  }

  menu.addItem(menu.item("Show Sidebar", function() {
    showSidebarTab();
  }, {
    keyBinding: "Meta+t"
  }));
}

function buildSidebarPlayback() {
  var snapshot = buildLiveSnapshot();
  return {
    available: !!(currentMedia && currentMedia.mediaInfo),
    mediaLabel: currentMedia && currentMedia.mediaInfo ? mediaLabel(currentMedia.mediaInfo) : "",
    parserSource: currentMedia && currentMedia.parsed ? (currentMedia.parsed.parserSource || "") : "",
    state: snapshot ? stateName(snapshot.state) : stateName(null),
    progress: snapshot ? snapshot.progress : 0,
    position: snapshot ? snapshot.position : 0,
    duration: snapshot ? snapshot.duration : 0,
    preview: !!playbackState.preview,
    fastPause: !!playbackState.fastPause,
    identifiedAt: currentMedia ? currentMedia.identifiedAt : ""
  };
}

async function buildSidebarPayload(forceProfileRefresh) {
  var auth = persistAuthStatus();
  var viewerProfile = null;
  var correction = cloneCorrectionState(correctionState);
  var recentHistory = {
    items: [],
    fetchedAt: "",
    error: ""
  };

  if (auth.connected && typeof trakt.getViewerProfile === "function") {
    try {
      viewerProfile = await trakt.getViewerProfile({
        force: !!forceProfileRefresh
      });
    } catch (error) {
      log("Sidebar profile refresh failed: " + errStr(error));
    }
  }

  if (auth.connected && !correction.active && typeof trakt.getRecentHistory === "function") {
    recentHistory = await trakt.getRecentHistory({
      force: !!forceProfileRefresh
    });
  }

  return {
    app: {
      version: PLUGIN_VERSION
    },
    scrobblingEnabled: prefBool("scrobble_enabled", true),
    statusOsdEnabled: prefBool("status_osd", true),
    auth: {
      state: auth.state,
      summary: auth.summary,
      detail: auth.detail || "",
      busy: !!auth.busy,
      connected: !!auth.connected,
      credentialMode: auth.credentialMode || "",
      deviceCode: auth.deviceCode || "",
      verificationUrl: auth.verificationUrl || "",
      token: typeof trakt.getTokenInfo === "function" ? trakt.getTokenInfo() : null,
      user: viewerProfile
    },
    playback: buildSidebarPlayback(),
    scrobble: cloneScrobbleStatus(lastScrobbleStatus),
    correction: correction,
    history: recentHistory,
    generatedAt: new Date().toISOString()
  };
}

function queueSidebarRefresh(forceProfileRefresh) {
  if (!sidebar || typeof sidebar.postMessage !== "function") {
    return;
  }

  sidebarRefreshChain = sidebarRefreshChain.then(async function() {
    var payload = await buildSidebarPayload(!!forceProfileRefresh);
    try {
      sidebar.postMessage("state", payload);
    } catch (error) {
      log("Sidebar postMessage failed: " + errStr(error));
    }
  }).catch(function(error) {
    log("Sidebar refresh failed: " + errStr(error));
  });
}

function bindSidebarMessaging() {
  if (sidebarHandlersBound || !sidebar || typeof sidebar.onMessage !== "function") {
    return;
  }

  sidebarHandlersBound = true;

  sidebar.onMessage("ready", function() {
    log("Sidebar ready");
    queueSidebarRefresh(true);
  });

  sidebar.onMessage("connect", function() {
    log("Sidebar requested connect");
    authActionChain = authActionChain.then(async function() {
      var force = trakt.getAuthStatus().state === "connected";
      await runManualAuth(force);
    }).catch(function(error) {
      log("Sidebar connect failed: " + errStr(error));
      persistAuthStatus();
      queueSidebarRefresh(true);
    });
  });

  sidebar.onMessage("signout", function() {
    log("Sidebar requested signout");
    authActionChain = authActionChain.then(function() {
      handleManualSignOut();
    }).catch(function(error) {
      log("Sidebar signout failed: " + errStr(error));
      persistAuthStatus();
      queueSidebarRefresh(true);
    });
  });

  sidebar.onMessage("toggle_scrobbling", function(payload) {
    var enabled = !(payload && payload.enabled === false);
    log("Sidebar requested scrobbling " + (enabled ? "enable" : "disable"));
    setScrobblingEnabled(enabled);
  });

  sidebar.onMessage("toggle_status_osd", function(payload) {
    var enabled = !(payload && payload.enabled === false);
    log("Sidebar requested status OSD " + (enabled ? "enable" : "disable"));
    setStatusOsdEnabled(enabled);
  });

  sidebar.onMessage("refresh", function() {
    log("Sidebar requested refresh");
    queueSidebarRefresh(true);
  });

  sidebar.onMessage("copy_auth_code", function() {
    Promise.resolve().then(async function() {
      var result = { ok: false, message: "No active code." };
      if (typeof trakt.copyPendingAuthCode === "function") {
        result = await trakt.copyPendingAuthCode();
      }
      try {
        sidebar.postMessage("copy_auth_result", result);
      } catch (_error) {}
    }).catch(function(error) {
      log("Sidebar auth code copy failed: " + errStr(error));
      try {
        sidebar.postMessage("copy_auth_result", {
          ok: false,
          message: "Copy failed. Copy manually."
        });
      } catch (_error) {}
    });
  });

  sidebar.onMessage("open_correction", function(payload) {
    var query = payload && payload.query ? String(payload.query) : "";
    log("Sidebar requested correction search");
    authActionChain = authActionChain.then(function() {
      return openCorrectionFlow(query);
    }).catch(function(error) {
      log("Sidebar correction open failed: " + errStr(error));
      correctionState = Object.assign(cloneCorrectionState(correctionState), {
        active: true,
        busy: false,
        error: errStr(error)
      });
      queueSidebarRefresh(false);
    });
  });

  sidebar.onMessage("search_correction", function(payload) {
    var query = payload && payload.query ? String(payload.query) : "";
    log('Sidebar requested correction search query="' + query + '"');
    authActionChain = authActionChain.then(function() {
      return searchCorrectionFlow(query);
    }).catch(function(error) {
      log("Sidebar correction search failed: " + errStr(error));
      correctionState = Object.assign(cloneCorrectionState(correctionState), {
        active: true,
        busy: false,
        error: errStr(error)
      });
      queueSidebarRefresh(false);
    });
  });

  sidebar.onMessage("lookup_correction_reference", function(payload) {
    var reference = payload && payload.reference ? String(payload.reference) : "";
    log('Sidebar requested correction reference lookup="' + reference + '"');
    authActionChain = authActionChain.then(function() {
      return lookupCorrectionReference(reference);
    }).catch(function(error) {
      log("Sidebar correction reference lookup failed: " + errStr(error));
      correctionState = Object.assign(cloneCorrectionState(correctionState), {
        active: true,
        busy: false,
        error: errStr(error)
      });
      queueSidebarRefresh(false);
    });
  });

  sidebar.onMessage("close_correction", function() {
    log("Sidebar requested correction close");
    resetCorrectionState();
    queueSidebarRefresh(false);
  });

  sidebar.onMessage("choose_correction", function(payload) {
    var traktId = payload && payload.trakt ? Number(payload.trakt) : 0;
    if (!traktId) {
      return;
    }

    log("Sidebar requested correction apply " + traktId);
    authActionChain = authActionChain.then(function() {
      return applyCorrectionChoice(traktId);
    }).catch(function(error) {
      log("Sidebar correction apply failed: " + errStr(error));
      correctionState = Object.assign(cloneCorrectionState(correctionState), {
        active: true,
        busy: false,
        error: errStr(error)
      });
      queueSidebarRefresh(false);
    });
  });
}

function initializeSidebar() {
  if (!sidebar || typeof sidebar.loadFile !== "function") {
    return;
  }

  sidebarHandlersBound = false;
  sidebar.loadFile("sidebar.html");
  bindSidebarMessaging();
  queueSidebarRefresh(true);
}

function wrapEvent(label, fn) {
  return async function() {
    try {
      return await fn();
    } catch (error) {
      var message = label + " failed: " + errStr(error);
      log(message);
      importantOsd(message);
    }
  };
}

function getCurrentSource() {
  return {
    url: String(core.status.url || ""),
    title: String(core.status.title || "")
  };
}

async function runManualAuth(force) {
  var status = trakt.getAuthStatus();
  showSidebarTab();
  persistAuthStatus({
    state: "authorizing",
    summary: force ? "Reconnecting to Trakt" : "Waiting for Trakt authorization",
    detail: "Complete the confirmation in your browser.",
    busy: true,
    connected: false,
    credentialMode: status.credentialMode
  });
  queueSidebarRefresh(true);

  try {
    await trakt.beginInteractiveAuth({
      force: !!force,
      showDialog: true
    });
    authRequiredNoticeShown = false;
    persistAuthStatus();
    queueSidebarRefresh(true);
    resyncCurrentPlaybackAfterAuth();
    importantOsd("Trakt connected");
    log("Manual Trakt auth completed");
  } catch (error) {
    persistAuthStatus();
    queueSidebarRefresh(true);
    importantOsd("Trakt authorization failed");
    log("Manual Trakt auth failed: " + errStr(error));
  }
}

function handleManualSignOut() {
  trakt.signOut();
  authRequiredNoticeShown = false;
  resetCorrectionState();
  persistAuthStatus();
  queueSidebarRefresh(true);
  importantOsd("Trakt signed out");
  log("Trakt token cleared");
}

async function openCorrectionFlow(query) {
  if (!currentMedia || !currentMedia.mediaInfo) {
    return;
  }

  var resolvedQuery = String(query || defaultCorrectionQuery(currentMedia.mediaInfo)).trim();
  correctionState = {
    active: true,
    busy: false,
    query: resolvedQuery,
    reference: "",
    error: "",
    mediaLabel: correctionMediaLabel(),
    mediaKey: currentMediaKey(),
    results: []
  };
  queueSidebarRefresh(false);
  await searchCorrectionFlow(resolvedQuery);
}

async function searchCorrectionFlow(query) {
  if (!currentMedia || !currentMedia.mediaInfo) {
    resetCorrectionState();
    queueSidebarRefresh(false);
    return;
  }

  var resolvedQuery = String(query || "").trim();
  if (!resolvedQuery) {
    correctionState = Object.assign(cloneCorrectionState(correctionState), {
      active: true,
      busy: false,
      query: "",
      error: "Enter a title to search.",
      mediaLabel: correctionMediaLabel(),
      mediaKey: currentMediaKey(),
      results: []
    });
    queueSidebarRefresh(false);
    return;
  }

  var mediaKey = currentMediaKey();
  correctionState = Object.assign(cloneCorrectionState(correctionState), {
    active: true,
    busy: true,
    query: resolvedQuery,
    error: "",
    mediaLabel: correctionMediaLabel(),
    mediaKey: mediaKey,
    results: []
  });
  queueSidebarRefresh(false);

  try {
    var results = await trakt.searchCorrectionCandidates(currentMedia.mediaInfo, resolvedQuery, 8);
    if (mediaKey !== currentMediaKey()) {
      return;
    }

    correctionState = Object.assign(cloneCorrectionState(correctionState), {
      active: true,
      busy: false,
      query: resolvedQuery,
      error: results.length ? "" : "No Trakt matches found.",
      mediaLabel: correctionMediaLabel(),
      mediaKey: mediaKey,
      results: results
    });
    log("Correction search returned " + results.length + " result(s) for " + correctionMediaLabel());
  } catch (error) {
    if (mediaKey !== currentMediaKey()) {
      return;
    }

    correctionState = Object.assign(cloneCorrectionState(correctionState), {
      active: true,
      busy: false,
      query: resolvedQuery,
      error: errStr(error),
      mediaLabel: correctionMediaLabel(),
      mediaKey: mediaKey,
      results: []
    });
    log("Correction search failed: " + errStr(error));
  }

  queueSidebarRefresh(false);
}

async function lookupCorrectionReference(reference) {
  if (!currentMedia || !currentMedia.mediaInfo) {
    resetCorrectionState();
    queueSidebarRefresh(false);
    return;
  }

  var resolvedReference = String(reference || "").trim();
  if (!resolvedReference) {
    correctionState = Object.assign(cloneCorrectionState(correctionState), {
      active: true,
      busy: false,
      reference: "",
      error: "Enter a Trakt ID or slug.",
      mediaLabel: correctionMediaLabel(),
      mediaKey: currentMediaKey()
    });
    queueSidebarRefresh(false);
    return;
  }

  var mediaKey = currentMediaKey();
  correctionState = Object.assign(cloneCorrectionState(correctionState), {
    active: true,
    busy: true,
    reference: resolvedReference,
    error: "",
    mediaLabel: correctionMediaLabel(),
    mediaKey: mediaKey
  });
  queueSidebarRefresh(false);

  try {
    var result = await trakt.lookupCorrectionReference(currentMedia.mediaInfo, resolvedReference);
    if (mediaKey !== currentMediaKey()) {
      return;
    }

    correctionState = Object.assign(cloneCorrectionState(correctionState), {
      active: true,
      busy: false,
      reference: resolvedReference,
      error: result ? "" : "No Trakt match found for that ID or slug.",
      mediaLabel: correctionMediaLabel(),
      mediaKey: mediaKey,
      results: result ? [result] : []
    });

    if (result) {
      log(
        "Correction reference lookup resolved " +
          resolvedReference +
          " -> " +
          correctionResultLabel(result, currentMedia.mediaInfo)
      );
    }
  } catch (error) {
    if (mediaKey !== currentMediaKey()) {
      return;
    }

    correctionState = Object.assign(cloneCorrectionState(correctionState), {
      active: true,
      busy: false,
      reference: resolvedReference,
      error: errStr(error),
      mediaLabel: correctionMediaLabel(),
      mediaKey: mediaKey
    });
    log("Correction reference lookup failed: " + errStr(error));
  }

  queueSidebarRefresh(false);
}

async function applyCorrectionChoice(traktId) {
  if (!currentMedia || !currentMedia.mediaInfo) {
    return;
  }

  var mediaInfo = cloneMediaInfo(currentMedia.mediaInfo);
  var mediaKey = currentMediaKey();
  var chosenId = Number(traktId || 0);
  if (!chosenId) {
    return;
  }

  correctionState = Object.assign(cloneCorrectionState(correctionState), {
    active: true,
    busy: true,
    error: ""
  });
  queueSidebarRefresh(false);

  try {
    var chosenResult = (correctionState.results || []).find(function(result) {
      return Number(result.trakt || 0) === chosenId;
    }) || null;
    await trakt.applyMatchOverride(mediaInfo, chosenId);
    if (mediaKey !== currentMediaKey()) {
      return;
    }

    if (currentMedia) {
      currentMedia.traktTargetLabel = correctionResultLabel(chosenResult, mediaInfo);
    }
    log("Applied manual Trakt match " + chosenId + " for " + mediaLabel(mediaInfo));
    resetCorrectionState();
    playbackState.lastScrobbleKey = "";
    setScrobbleStatus({
      status: "ready",
      verb: "",
      mediaLabel: currentMedia ? scrobbleTargetLabel(currentMedia) : correctionResultLabel(chosenResult, mediaInfo),
      detail: "Watching for playback changes.",
      reason: ""
    });
    queueSidebarRefresh(true);
    resyncCurrentPlayback("Re-syncing current playback after manual correction");
    importantOsd("Trakt match corrected");
  } catch (error) {
    if (mediaKey !== currentMediaKey()) {
      return;
    }

    correctionState = Object.assign(cloneCorrectionState(correctionState), {
      active: true,
      busy: false,
      error: errStr(error)
    });
    queueSidebarRefresh(false);
    log("Applying manual Trakt match failed: " + errStr(error));
  }
}

function checkAuthActionRequest() {
  var nonce = String(preferences.get("auth_action_nonce") || "");
  if (!nonce || nonce === lastHandledAuthActionNonce) {
    return;
  }

  lastHandledAuthActionNonce = nonce;
  var action = String(preferences.get("auth_action_kind") || "");
  persistPreferences({
    auth_action_kind: "",
    auth_action_nonce: ""
  });

  if (!action) {
    return;
  }

  authActionChain = authActionChain.then(async function() {
    if (action === "show_sidebar") {
      log("Preferences requested sidebar show");
      showSidebarTab();
      queueSidebarRefresh(true);
      return;
    }

    if (action === "connect") {
      var force = trakt.getAuthStatus().state === "connected";
      await runManualAuth(force);
      return;
    }

    if (action === "signout") {
      handleManualSignOut();
    }
  }).catch(function(error) {
    log("Auth action failed: " + errStr(error));
    persistAuthStatus();
  });
}

function parsedLabel(parsed) {
  if (!parsed) return "unparsed";
  if (parsed.kind === "episode") {
    return parsed.showTitle + " S" + parsed.season + "E" + parsed.episode;
  }
  return parsed.title || parsed.kind;
}

function isScrobblingEnabled() {
  return prefBool("scrobble_enabled", true);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function mediaInfoFromParsed(parsed) {
  if (!parsed) return null;
  if (parsed.kind === "movie") {
    return {
      type: "movie",
      title: parsed.title,
      year: parsed.year || null
    };
  }

  if (parsed.kind === "episode") {
    return {
      type: "episode",
      title: parsed.showTitle,
      showTitle: parsed.showTitle,
      year: parsed.year || null,
      season: parsed.season,
      episode: parsed.episode,
      episodeTitle: parsed.episodeTitle || ""
    };
  }

  return null;
}

function mediaLabel(mediaInfo) {
  if (!mediaInfo) return "unknown media";
  if (mediaInfo.type === "episode") {
    var suffix = mediaInfo.episodeTitle ? (" - " + mediaInfo.episodeTitle) : "";
    return mediaInfo.showTitle + " S" + pad2(mediaInfo.season) + "E" + pad2(mediaInfo.episode) + suffix;
  }
  return mediaInfo.title + (mediaInfo.year ? (" (" + mediaInfo.year + ")") : "");
}

function correctionResultLabel(result, mediaInfo) {
  if (!result) return "";
  if (result.kind === "episode") {
    var suffix = mediaInfo && mediaInfo.episodeTitle ? (" - " + mediaInfo.episodeTitle) : "";
    return String(result.title || "") +
      " S" + pad2(mediaInfo && mediaInfo.season) +
      "E" + pad2(mediaInfo && mediaInfo.episode) +
      suffix;
  }

  return String(result.title || "") + (result.year ? (" (" + result.year + ")") : "");
}

function labelFromTraktScrobbleBody(body, mediaInfo) {
  var payload = body || {};

  if (payload.movie && payload.movie.title) {
    return String(payload.movie.title) + (payload.movie.year ? (" (" + payload.movie.year + ")") : "");
  }

  if (payload.show && payload.show.title) {
    var episodeTitle = payload.episode && payload.episode.title
      ? String(payload.episode.title)
      : String((mediaInfo && mediaInfo.episodeTitle) || "");
    return String(payload.show.title) +
      " S" + pad2(payload.episode && payload.episode.season ? payload.episode.season : (mediaInfo && mediaInfo.season)) +
      "E" + pad2(payload.episode && payload.episode.number ? payload.episode.number : (mediaInfo && mediaInfo.episode)) +
      (episodeTitle ? (" - " + episodeTitle) : "");
  }

  return "";
}

function scrobbleTargetLabel(snapshot) {
  if (!snapshot) return "";
  return String(snapshot.traktTargetLabel || "") || mediaLabel(snapshot.mediaInfo);
}

function correctionMediaLabel() {
  if (!currentMedia || !currentMedia.mediaInfo) return "";
  return scrobbleTargetLabel(currentMedia);
}

function cloneMediaInfo(mediaInfo) {
  if (!mediaInfo) return null;
  return {
    type: mediaInfo.type,
    title: mediaInfo.title,
    showTitle: mediaInfo.showTitle,
    year: mediaInfo.year,
    season: mediaInfo.season,
    episode: mediaInfo.episode,
    episodeTitle: mediaInfo.episodeTitle
  };
}

function currentMediaKey() {
  return currentMedia && currentMedia.mediaInfo
    ? monitor.mediaKey(currentMedia.mediaInfo)
    : "";
}

function defaultCorrectionQuery(mediaInfo) {
  if (!mediaInfo) return "";
  if (mediaInfo.type === "episode") {
    return String(mediaInfo.showTitle || mediaInfo.title || "").trim();
  }
  return String(mediaInfo.title || "").trim();
}

function resetCorrectionState() {
  correctionState = createCorrectionState();
}

function cloneSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    state: snapshot.state,
    duration: snapshot.duration,
    position: snapshot.position,
    progress: snapshot.progress,
    updatedAt: snapshot.updatedAt,
    mediaInfo: cloneMediaInfo(snapshot.mediaInfo),
    traktTargetLabel: String(snapshot.traktTargetLabel || "")
  };
}

function createResumableTimer(timeoutMs, callback) {
  var remainingMs = timeoutMs;
  var startedAt = 0;
  var timerId = null;

  function clear() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function schedule() {
    clear();
    startedAt = Date.now();
    timerId = setTimeout(function() {
      timerId = null;
      callback();
    }, remainingMs);
  }

  return {
    start: function() {
      remainingMs = timeoutMs;
      schedule();
    },
    pause: function() {
      if (timerId === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
      clear();
    },
    resume: function() {
      if (timerId !== null) return;
      schedule();
    },
    cancel: function() {
      clear();
    }
  };
}

function playbackConfig() {
  return {
    skipInterval: prefNumber("skip_interval", 5),
    previewThreshold: prefNumber("preview_threshold", 80),
    previewDuration: prefNumber("preview_duration", 60),
    fastPauseThreshold: prefNumber("fast_pause_threshold", 1),
    fastPauseDuration: prefNumber("fast_pause_duration", 5)
  };
}

function identifyCurrentMedia() {
  var source = getCurrentSource();
  appendDebugLog("[IINATraktScrobbler] Parser attempt source=" + (source.url || source.title || ""));
  var parsed = parser.parseMediaFromSource(source.url, source.title);
  logGuessitFailureOnce();
  currentMedia = parsed ? {
    source: source,
    parsed: parsed,
    mediaInfo: mediaInfoFromParsed(parsed),
    traktTargetLabel: "",
    identifiedAt: new Date().toISOString()
  } : null;

  if (!parsed) {
    lastScrobbleStatus = createScrobbleStatus();
    setScrobbleStatus({
      status: "idle",
      verb: "",
      mediaLabel: "",
      detail: "The current file could not be classified."
    });
    log("Could not classify current media");
    debugOsd("Could not classify current media");
    return;
  }

  setScrobbleStatus({
    status: isScrobblingEnabled() ? "ready" : "disabled",
    verb: "",
    mediaLabel: currentMedia && currentMedia.mediaInfo ? mediaLabel(currentMedia.mediaInfo) : parsedLabel(parsed),
    detail: isScrobblingEnabled() ? "Watching for playback changes." : "Scrobbling is turned off.",
    reason: isScrobblingEnabled() ? "" : "disabled"
  });
  log("Parsed " + parsedLabel(parsed) + " via " + (parsed.parserSource || "unknown"));
  debugOsd("Parsed " + parsedLabel(parsed));
}

function clearTimer(name) {
  var timer = playbackState[name];
  if (timer && typeof timer.cancel === "function") {
    timer.cancel();
  }
  playbackState[name] = null;
}

function exitPreview() {
  if (!playbackState.preview) return;
  playbackState.preview = false;
  playbackState.scrobbleBuffer = null;
  clearTimer("previewTimer");
  log("Preview mode ended");
}

function exitFastPause() {
  if (!playbackState.fastPause) return;
  playbackState.fastPause = false;
  playbackState.scrobbleBuffer = null;
  clearTimer("fastPauseTimer");
  log("Fast-pause mode ended");
}

function resetPlaybackTracking() {
  exitPreview();
  exitFastPause();
  playbackState.prevSnapshot = null;
  playbackState.scrobbleBuffer = null;
  playbackState.lastScrobbleKey = "";
  playbackState.preview = false;
  playbackState.fastPause = false;
}

function buildLiveSnapshot() {
  if (!currentMedia || !currentMedia.mediaInfo) {
    return null;
  }

  var duration = Number(core.status.duration || 0);
  if (!isFinite(duration) || duration <= 0) {
    return null;
  }

  var position = Number(core.status.position || 0);
  if (!isFinite(position)) position = 0;
  if (position < 0) position = 0;
  if (position > duration) position = duration;

  var state = core.status.idle
    ? monitor.State.Stopped
    : (core.status.paused ? monitor.State.Paused : monitor.State.Playing);

  return {
    state: state,
    duration: duration,
    position: position,
    progress: monitor.computeProgress(position, duration),
    updatedAt: Date.now() / 1000,
    mediaInfo: cloneMediaInfo(currentMedia.mediaInfo),
    traktTargetLabel: String(currentMedia.traktTargetLabel || "")
  };
}

function buildStoppedSnapshot(prevSnapshot) {
  if (!prevSnapshot) return null;
  return {
    state: monitor.State.Stopped,
    duration: prevSnapshot.duration,
    position: prevSnapshot.position,
    progress: prevSnapshot.progress,
    updatedAt: Date.now() / 1000,
    mediaInfo: cloneMediaInfo(prevSnapshot.mediaInfo),
    traktTargetLabel: String(prevSnapshot.traktTargetLabel || "")
  };
}

function resyncCurrentPlayback(logMessage) {
  var snapshot = buildLiveSnapshot();
  if (!snapshot || !snapshot.mediaInfo || snapshot.state === monitor.State.Stopped) {
    return;
  }

  playbackState.lastScrobbleKey = "";
  if (logMessage) {
    log(logMessage);
  }
  queueScrobble(monitor.stateVerb(snapshot.state), snapshot);
}

function resyncCurrentPlaybackAfterAuth() {
  resyncCurrentPlayback("Re-syncing current playback after Trakt auth");
}

function setScrobblingEnabled(enabled) {
  var nextValue = !!enabled;
  var prevValue = isScrobblingEnabled();
  if (nextValue === prevValue) {
    queueSidebarRefresh(false);
    return;
  }

  persistPreferences({
    scrobble_enabled: nextValue
  });

  resetPlaybackTracking();
  playbackState.lastScrobbleKey = "";

  if (nextValue) {
    log("Trakt scrobbling enabled");
    importantOsd("Trakt scrobbling enabled");
    if (currentMedia && currentMedia.mediaInfo) {
      setScrobbleStatus({
        status: "ready",
        verb: "",
        mediaLabel: mediaLabel(currentMedia.mediaInfo),
        detail: "Watching for playback changes.",
        reason: ""
      });
    } else {
      setScrobbleStatus(createScrobbleStatus());
    }
    resyncCurrentPlayback("Re-syncing current playback after enabling scrobbling");
    return;
  }

  log("Trakt scrobbling disabled");
  importantOsd("Trakt scrobbling paused");
  setScrobbleStatus({
    status: "disabled",
    verb: "",
    mediaLabel: currentMedia && currentMedia.mediaInfo ? mediaLabel(currentMedia.mediaInfo) : "",
    detail: "Scrobbling is turned off.",
    reason: "disabled",
    progress: null
  });
}

function loadPendingScrobbles() {
  try {
    var raw = file.exists(PENDING_SCROBBLES_PATH) ? (file.read(PENDING_SCROBBLES_PATH) || "[]") : "[]";
    var items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch (_error) {
    return [];
  }
}

function savePendingScrobbles(items) {
  try {
    file.write(PENDING_SCROBBLES_PATH, JSON.stringify(items, null, 2));
  } catch (_error) {}
}

function addToPendingQueue(verb, mediaInfo, progress) {
  if (verb !== "stop") return;
  var id = [
    "stop",
    monitor.mediaKey(mediaInfo),
    String(Math.round(Number(progress || 0) * 100) / 100)
  ].join("|");
  var items = loadPendingScrobbles();
  if (items.some(function(item) { return item.id === id; })) return;
  if (items.length >= MAX_PENDING_SCROBBLES) {
    items = items.slice(items.length - MAX_PENDING_SCROBBLES + 1);
  }
  items.push({ id: id, verb: "stop", mediaInfo: mediaInfo, progress: Number(progress || 0), queuedAt: new Date().toISOString() });
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
      log("Offline queue: replaying " + item.id);
      try {
        var result = await trakt.scrobble(item.verb, item.mediaInfo, item.progress);
        if (result && result.ok) {
          var action = successfulScrobbleAction(item.verb, result);
          log("Offline queue: replay succeeded for " + item.id + " (action=" + action + ")");
          maybeShowScrobbleStatusOsd(item.verb, action, item.mediaInfo);
          if (action === "scrobble" && trakt && typeof trakt.clearRecentHistoryCache === "function") {
            trakt.clearRecentHistoryCache();
          }
          removeFromPendingQueue(item.id);
        } else if (result && result.skip) {
          if (result.reason === "auth-required" || result.reason === "missing-client-credentials") {
            log("Offline queue: replay requires auth, pausing flush");
            break;
          }
          log("Offline queue: replay permanently skipped for " + item.id + " (" + result.reason + "), dropping");
          removeFromPendingQueue(item.id);
        } else if (result && result.duplicate) {
          log("Offline queue: replay already recorded for " + item.id + ", dropping");
          removeFromPendingQueue(item.id);
        } else if (result && result.notFound) {
          log("Offline queue: no Trakt match for " + item.id + ", dropping");
          removeFromPendingQueue(item.id);
        } else {
          log("Offline queue: unexpected result for " + item.id + ", dropping");
          removeFromPendingQueue(item.id);
        }
      } catch (error) {
        if (isNetworkError(error)) {
          log("Offline queue: still offline, pausing flush (" + errStr(error) + ")");
          break;
        }
        log("Offline queue: non-network error for " + item.id + ": " + errStr(error) + ", dropping");
        removeFromPendingQueue(item.id);
      }
    }
  } finally {
    pendingFlushActive = false;
    var remaining = loadPendingScrobbles();
    if (remaining.length) {
      log("Offline queue: " + remaining.length + " scrobble(s) still pending");
    }
  }
}

function queueScrobble(verb, snapshot) {
  if (!isScrobblingEnabled()) {
    setScrobbleStatus({
      status: "disabled",
      verb: "",
      mediaLabel: snapshot && snapshot.mediaInfo ? mediaLabel(snapshot.mediaInfo) : "",
      detail: "Scrobbling is turned off.",
      reason: "disabled",
      progress: null
    });
    return;
  }

  var payload = cloneSnapshot(snapshot);
  if (!payload || !payload.mediaInfo) {
    return;
  }

  var effectiveVerb = (trakt && typeof trakt.normalizeScrobbleVerb === "function")
    ? trakt.normalizeScrobbleVerb(verb, payload.progress)
    : verb;

  var scrobbleKey = [
    effectiveVerb,
    monitor.mediaKey(payload.mediaInfo),
    String(Math.round(payload.progress * 100) / 100)
  ].join("|");

  if (playbackState.lastScrobbleKey === scrobbleKey) {
    return;
  }

  playbackState.lastScrobbleKey = scrobbleKey;
  setScrobbleStatus({
    status: "queued",
    verb: effectiveVerb,
    mediaLabel: scrobbleTargetLabel(payload),
    detail: "Queued for Trakt at " + payload.progress.toFixed(2) + "%.",
    reason: "",
    progress: payload.progress
  });
  if (effectiveVerb !== verb) {
    log(
      "Scrobble " + verb +
      " normalized to " + effectiveVerb +
      " for " + scrobbleTargetLabel(payload) +
      " at " + payload.progress.toFixed(2) + "%"
    );
  }
  log("Scrobble " + effectiveVerb + " queued for " + scrobbleTargetLabel(payload) + " at " + payload.progress.toFixed(2) + "%");
  playbackState.scrobbleChain = playbackState.scrobbleChain.then(async function() {
    setScrobbleStatus({
      status: "sending",
      verb: effectiveVerb,
      mediaLabel: scrobbleTargetLabel(payload),
      detail: "Sending " + effectiveVerb + " to Trakt.",
      reason: "",
      progress: payload.progress
    });

    try {
      var result = await trakt.scrobble(effectiveVerb, payload.mediaInfo, payload.progress);
      if (result && result.ok) {
        var traktAction = successfulScrobbleAction(effectiveVerb, result);
        var traktProgress = successfulScrobbleProgress(payload.progress, result);
        var matchedLabel = labelFromTraktScrobbleBody(result.body, payload.mediaInfo) || scrobbleTargetLabel(payload);
        if (
          currentMedia &&
          currentMedia.mediaInfo &&
          monitor.mediaKey(currentMedia.mediaInfo) === monitor.mediaKey(payload.mediaInfo)
        ) {
          currentMedia.traktTargetLabel = matchedLabel;
        }
        setScrobbleStatus({
          status: "succeeded",
          verb: effectiveVerb,
          action: traktAction,
          mediaLabel: matchedLabel,
          detail: successfulScrobbleDetail(traktAction, traktProgress),
          reason: "",
          progress: traktProgress
        });
        log(
          "Scrobble " + effectiveVerb +
          " succeeded for " + matchedLabel +
          " (action=" + traktAction + ", progress=" + traktProgress.toFixed(2) + "%)"
        );
        if (traktAction === "scrobble" && trakt && typeof trakt.clearRecentHistoryCache === "function") {
          trakt.clearRecentHistoryCache();
        }
        maybeShowScrobbleStatusOsd(effectiveVerb, traktAction, payload.mediaInfo);
        if (!firstScrobbleNoticeShown) {
          debugOsd("Scrobble flow active");
          firstScrobbleNoticeShown = true;
        }
        flushPendingScrobbles().catch(function(e) { log("Offline queue flush error: " + errStr(e)); });
        return;
      }

      if (result && result.skip) {
        if (result.reason === "missing-client-credentials" && !missingCredentialsNoticeShown) {
          importantOsd("Configure Trakt app credentials for this build");
          missingCredentialsNoticeShown = true;
        }
        if (result.reason === "auth-required" && !authRequiredNoticeShown) {
          importantOsd("Connect Trakt from the sidebar to start scrobbling");
          authRequiredNoticeShown = true;
        }
        setScrobbleStatus({
          status: "skipped",
          verb: effectiveVerb,
          mediaLabel: scrobbleTargetLabel(payload),
          reason: result.reason,
          detail: result.reason === "auth-required"
            ? "Scrobble skipped until you connect Trakt from the sidebar."
            : ("Scrobble skipped: " + result.reason),
          progress: payload.progress
        });
        log("Scrobble skipped for " + scrobbleTargetLabel(payload) + ": " + result.reason);
        return;
      }

      if (result && result.duplicate) {
        setScrobbleStatus({
          status: "duplicate",
          verb: effectiveVerb,
          mediaLabel: scrobbleTargetLabel(payload),
          detail: "Trakt reported this scrobble as a duplicate.",
          reason: "",
          progress: payload.progress
        });
        log("Scrobble duplicate ignored for " + scrobbleTargetLabel(payload));
        return;
      }

      if (result && result.notFound) {
        setScrobbleStatus({
          status: "unmatched",
          verb: effectiveVerb,
          mediaLabel: scrobbleTargetLabel(payload),
          detail: "Trakt could not match this media identity.",
          reason: "missing-trakt-match",
          progress: payload.progress
        });
        log("Trakt rejected the scrobble because the media was not found: " + scrobbleTargetLabel(payload));
        return;
      }

      setScrobbleStatus({
        status: "unknown",
        verb: effectiveVerb,
        mediaLabel: scrobbleTargetLabel(payload),
        detail: "Trakt returned no actionable result.",
        reason: "",
        progress: payload.progress
      });
      log("Scrobble returned no actionable result for " + scrobbleTargetLabel(payload));
    } catch (error) {
      setScrobbleStatus({
        status: "failed",
        verb: effectiveVerb,
        mediaLabel: scrobbleTargetLabel(payload),
        detail: errStr(error),
        reason: "",
        progress: payload.progress
      });
      log("Scrobble failed for " + scrobbleTargetLabel(payload) + ": " + errStr(error));
      if (isNetworkError(error)) {
        addToPendingQueue(effectiveVerb, payload.mediaInfo, payload.progress);
      }
      if (/Missing Trakt client credentials/.test(errStr(error)) && !missingCredentialsNoticeShown) {
        importantOsd("Configure Trakt app credentials for this build");
        missingCredentialsNoticeShown = true;
      }
    } finally {
      persistAuthStatus();
      queueSidebarRefresh(false);
    }
  }).catch(function(error) {
    setScrobbleStatus({
      status: "failed",
      verb: verb,
      mediaLabel: scrobbleTargetLabel(payload),
      detail: errStr(error),
      reason: "",
      progress: payload.progress
    });
    log("Scrobble queue failure: " + errStr(error));
  });
}

async function flushScrobbleQueue(reason, timeoutMs) {
  var timeout = Math.max(0, Number(timeoutMs || 0));
  var label = reason ? (" for " + reason) : "";
  if (timeout > 0) {
    log("Waiting up to " + timeout + "ms for pending scrobbles" + label);
  } else {
    log("Waiting for pending scrobbles" + label);
  }

  var chain = playbackState.scrobbleChain.catch(function(error) {
    log("Pending scrobble flush saw error: " + errStr(error));
  });

  if (!timeout) {
    await chain;
    return;
  }

  await Promise.race([
    chain,
    new Promise(function(resolve) {
      setTimeout(resolve, timeout);
    })
  ]);
}

function delayedScrobble(cleanup) {
  if (playbackState.scrobbleBuffer) {
    var buffered = cloneSnapshot(playbackState.scrobbleBuffer);
    queueScrobble(monitor.stateVerb(buffered.state), buffered);
  }
  if (typeof cleanup === "function") {
    cleanup();
  }
}

function executeAction(action, prevSnapshot, currentSnapshot) {
  if (action === "scrobble") {
    queueScrobble(monitor.stateVerb(currentSnapshot.state), currentSnapshot);
    return;
  }

  if (action === "stop_previous") {
    queueScrobble("stop", prevSnapshot);
    return;
  }

  if (action === "exit_preview") {
    exitPreview();
    return;
  }

  if (action === "enter_preview") {
    exitPreview();
    playbackState.preview = true;
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    playbackState.previewTimer = createResumableTimer(playbackConfig().previewDuration * 1000, function() {
      delayedScrobble(exitPreview);
    });
    playbackState.previewTimer.start();
    log("Entered preview mode for " + mediaLabel(currentSnapshot.mediaInfo));
    return;
  }

  if (action === "pause_preview") {
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    if (playbackState.previewTimer) {
      playbackState.previewTimer.pause();
    }
    return;
  }

  if (action === "resume_preview") {
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    if (playbackState.previewTimer) {
      playbackState.previewTimer.resume();
    }
    return;
  }

  if (action === "enter_fast_pause") {
    playbackState.fastPause = true;
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    clearTimer("fastPauseTimer");
    playbackState.fastPauseTimer = createResumableTimer(playbackConfig().fastPauseDuration * 1000, function() {
      delayedScrobble(exitFastPause);
    });
    playbackState.fastPauseTimer.start();
    log("Entered fast-pause mode");
    return;
  }

  if (action === "clear_buf") {
    clearTimer("fastPauseTimer");
    playbackState.scrobbleBuffer = null;
    return;
  }

  if (action === "delayed_play") {
    clearTimer("fastPauseTimer");
    playbackState.scrobbleBuffer = cloneSnapshot(currentSnapshot);
    playbackState.fastPauseTimer = createResumableTimer(playbackConfig().fastPauseDuration * 1000, function() {
      delayedScrobble(exitFastPause);
    });
    playbackState.fastPauseTimer.start();
    return;
  }

  if (action === "exit_fast_pause") {
    exitFastPause();
    return;
  }

  if (action === "ignore") {
    log("Ignoring transition for " + mediaLabel(currentSnapshot && currentSnapshot.mediaInfo));
    return;
  }

  log("Unhandled action: " + action);
}

function processTransition(prevSnapshot, currentSnapshot, reason) {
  var actions = monitor.decideActions(prevSnapshot, currentSnapshot, {
    preview: playbackState.preview,
    fastPause: playbackState.fastPause
  }, playbackConfig());

  if (!actions.length) {
    return;
  }

  log("Transition " + reason + ": " + actions.join(", "));
  actions.forEach(function(action) {
    executeAction(action, prevSnapshot, currentSnapshot);
  });
}

function handleStatusUpdate(reason) {
  if (!currentMedia || !currentMedia.mediaInfo) {
    queueSidebarRefresh(false);
    return;
  }

  var currentSnapshot = buildLiveSnapshot();
  if (!currentSnapshot) {
    queueSidebarRefresh(false);
    return;
  }

  var prevSnapshot = playbackState.prevSnapshot;
  if (prevSnapshot && monitor.shouldIgnoreEndRollover(prevSnapshot, currentSnapshot)) {
    log(
      "Ignoring end-of-file rollover reset for " +
      mediaLabel(prevSnapshot.mediaInfo) +
      " at " + currentSnapshot.progress.toFixed(2) + "%"
    );
    queueSidebarRefresh(false);
    return;
  }
  processTransition(prevSnapshot, currentSnapshot, reason || "status");
  playbackState.prevSnapshot = currentSnapshot;
  queueSidebarRefresh(false);
}

async function finalizeCurrentMedia(reason) {
  if (!playbackState.prevSnapshot) {
    currentMedia = null;
    lastSourceSignature = "";
    resetCorrectionState();
    resetPlaybackTracking();
    setScrobbleStatus({
      status: "idle",
      verb: "",
      mediaLabel: "",
      detail: "Waiting for playback."
    });
    return;
  }

  var prevSnapshot = playbackState.prevSnapshot;
  var stoppedSnapshot = buildStoppedSnapshot(prevSnapshot);
  processTransition(prevSnapshot, stoppedSnapshot, reason || "stop");
  playbackState.prevSnapshot = stoppedSnapshot;
  currentMedia = null;
  lastSourceSignature = "";
  resetCorrectionState();
  queueSidebarRefresh(false);
  if (reason === "end-file") {
    await flushScrobbleQueue("end-file", 2500);
    if (currentMedia || lastSourceSignature) {
      log("New media became active during end-file flush; preserving new playback state");
      return;
    }
  }
  resetPlaybackTracking();
  queueSidebarRefresh(false);
}

function scheduleBootstrapTicks() {
  [250, 1000, 2000].forEach(function(delayMs) {
    setTimeout(function() {
      handleStatusUpdate("bootstrap:" + delayMs);
    }, delayMs);
  });
}

function ensurePollTimer() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(function() {
    handleStatusUpdate("poll");
  }, POLL_INTERVAL_MS);
}

function ensureUiPollTimer() {
  if (uiPollTimer !== null) return;
  uiPollTimer = setInterval(function() {
    if (trakt.getAuthStatus().busy) {
      persistAuthStatus();
    }
    checkAuthActionRequest();
    queueSidebarRefresh(false);
  }, UI_POLL_INTERVAL_MS);
}

async function handleFileLoaded() {
  var source = getCurrentSource();
  var signature = source.url || source.title;
  if (signature && signature === lastSourceSignature && currentMedia) {
    return;
  }

  if (currentMedia && lastSourceSignature && signature && signature !== lastSourceSignature) {
    await finalizeCurrentMedia("new-file");
  } else {
    resetPlaybackTracking();
    currentMedia = null;
    resetCorrectionState();
  }

  lastSourceSignature = signature;
  missingCredentialsNoticeShown = false;
  authRequiredNoticeShown = false;
  identifyCurrentMedia();
  scheduleBootstrapTicks();
}

appendDebugLog("[IINATraktScrobbler] --------------------------------------------------");
appendDebugLog("[IINATraktScrobbler] Session start");
log("Plugin main loaded");
appendDebugLog("[IINATraktScrobbler] Parser mode default=guessit-with-heuristic-fallback");
persistAuthStatus();
flushPendingScrobbles().catch(function(e) { log("Offline queue startup flush error: " + errStr(e)); });
registerMenuItems();
ensurePollTimer();
ensureUiPollTimer();

event.on("iina.window-loaded", wrapEvent("iina.window-loaded", function() {
  initializeSidebar();
  debugOsd("Plugin loaded");
}));

event.on("iina.file-loaded", wrapEvent("iina.file-loaded", function() {
  return handleFileLoaded();
}));

event.on("mpv.pause.changed", wrapEvent("mpv.pause.changed", function() {
  handleStatusUpdate("pause.changed");
}));

event.on("mpv.time-pos.changed", wrapEvent("mpv.time-pos.changed", function() {
  handleStatusUpdate("time-pos.changed");
}));

event.on("mpv.duration.changed", wrapEvent("mpv.duration.changed", function() {
  handleStatusUpdate("duration.changed");
}));

event.on("mpv.end-file", wrapEvent("mpv.end-file", function() {
  return finalizeCurrentMedia("end-file");
}));
