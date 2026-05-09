const assert = require("assert");
const path = require("path");

const TOKEN_PATH = "@data/trakt-token.json";
const CACHE_PATH = "@data/trakt-cache.json";

function makeToken() {
  return {
    access_token: "token",
    refresh_token: "refresh",
    created_at: Math.floor(Date.now() / 1000),
    expires_in: 3600
  };
}

function makeFile(store) {
  return {
    exists(filePath) {
      return Object.prototype.hasOwnProperty.call(store, filePath);
    },
    read(filePath) {
      return Object.prototype.hasOwnProperty.call(store, filePath) ? store[filePath] : "";
    },
    write(filePath, value) {
      store[filePath] = String(value);
    }
  };
}

function makeUtils(routeHandler, calls) {
  return {
    keyChainRead() {
      return JSON.stringify(makeToken());
    },
    keyChainWrite() {
      return true;
    },
    async exec(binary, args) {
      if (binary !== "/usr/bin/curl") {
        throw new Error("Unexpected binary: " + binary);
      }

      const methodIndex = args.indexOf("-X");
      const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
      const url = new URL(args[args.length - 1]);
      calls.push(method + " " + url.pathname + url.search);

      const response = routeHandler({
        method,
        url
      });

      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify(response.body) + "\n__IINA_TRAKT_STATUS__:" + String(response.statusCode)
      };
    }
  };
}

function loadFreshTrakt(store, routeHandler, logs) {
  const modulePath = path.resolve(__dirname, "../trakt.js");
  delete require.cache[modulePath];
  const trakt = require("../trakt.js");
  const calls = [];

  trakt.configure({
    file: makeFile(store),
    preferences: {
      get() {
        return undefined;
      }
    },
    utils: makeUtils(routeHandler, calls),
    logger(message) {
      logs.push(String(message));
    },
    notify() {}
  });

  return {
    trakt,
    calls
  };
}

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .catch(function(error) {
      error.message = name + ": " + error.message;
      throw error;
    });
}

async function run() {
  await test("repairs a stale cached show id by verifying episode candidates", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({
      movie: {},
      show: {
        "game changer|": 172377
      }
    });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/shows/172377/seasons/5/episodes/4") {
        return { statusCode: 404, body: {} };
      }
      if (request.url.pathname === "/search/show") {
        return {
          statusCode: 200,
          body: [
            {
              score: 10,
              show: {
                title: "Game Changer",
                year: 2021,
                ids: { trakt: 172377 }
              }
            },
            {
              score: 10,
              show: {
                title: "Game Changer",
                year: 2019,
                ids: { trakt: 153142 }
              }
            }
          ]
        };
      }
      if (request.url.pathname === "/shows/153142/seasons/5/episodes/4") {
        return {
          statusCode: 200,
          body: {
            title: "Name a Number",
            season: 5,
            number: 4
          }
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const mediaInfo = {
      type: "episode",
      title: "Game Changer",
      showTitle: "Game Changer",
      season: 5,
      episode: 4,
      episodeTitle: "Name A Number"
    };

    const ids = await trakt.getTraktIds(mediaInfo);
    assert.deepStrictEqual(ids, { trakt: 153142 });

    const cache = JSON.parse(store[CACHE_PATH]);
    assert.deepStrictEqual(cache.show["game changer|"], {
      trakt: 153142,
      verified: true
    });

    const payload = await trakt.prepareScrobblePayload(mediaInfo);
    assert.deepStrictEqual(payload, {
      show: {
        ids: { trakt: 153142 }
      },
      episode: {
        season: 5,
        number: 4
      }
    });

    assert(calls.some(function(call) {
      return call.indexOf("/shows/172377/seasons/5/episodes/4") >= 0;
    }));
    assert(calls.some(function(call) {
      return call.indexOf("/search/show") >= 0;
    }));
    assert(calls.some(function(call) {
      return call.indexOf("/shows/153142/seasons/5/episodes/4") >= 0;
    }));
    assert(logs.some(function(line) {
      return line.indexOf("Trakt episode cache entry invalidated") >= 0;
    }));
  });

  await test("prefers the candidate whose episode title matches the parsed title", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({ movie: {}, show: {} });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/search/show") {
        return {
          statusCode: 200,
          body: [
            {
              score: 10,
              show: {
                title: "The Show",
                year: 2020,
                ids: { trakt: 111 }
              }
            },
            {
              score: 10,
              show: {
                title: "The Show",
                year: 2024,
                ids: { trakt: 222 }
              }
            }
          ]
        };
      }
      if (request.url.pathname === "/shows/111/seasons/1/episodes/2") {
        return {
          statusCode: 200,
          body: {
            title: "Pilot",
            season: 1,
            number: 2
          }
        };
      }
      if (request.url.pathname === "/shows/222/seasons/1/episodes/2") {
        return {
          statusCode: 200,
          body: {
            title: "The Real One",
            season: 1,
            number: 2
          }
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const ids = await trakt.getTraktIds({
      type: "episode",
      title: "The Show",
      showTitle: "The Show",
      season: 1,
      episode: 2,
      episodeTitle: "The Real One"
    });

    assert.deepStrictEqual(ids, { trakt: 222 });
    const cache = JSON.parse(store[CACHE_PATH]);
    assert.deepStrictEqual(cache.show["the show|"], {
      trakt: 222,
      verified: true
    });
    assert(logs.some(function(line) {
      return line.indexOf('parsedTitleMatch=yes') >= 0;
    }));
  });

  await test("reuses a verified episode cache entry without hitting the network", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({
      movie: {},
      show: {
        "game changer|": {
          trakt: 153142,
          verified: true
        }
      }
    });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function() {
      throw new Error("verified cache should not trigger network lookups");
    }, logs);

    const ids = await trakt.getTraktIds({
      type: "episode",
      title: "Game Changer",
      showTitle: "Game Changer",
      season: 5,
      episode: 4,
      episodeTitle: "Name A Number"
    });

    assert.deepStrictEqual(ids, { trakt: 153142 });
    assert.deepStrictEqual(calls, []);
  });

  await test("returns verified manual correction candidates for episodes", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({ movie: {}, show: {} });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/search/show") {
        return {
          statusCode: 200,
          body: [
            {
              score: 9,
              show: {
                title: "Arrested Development",
                year: 2003,
                ids: { trakt: 111 }
              }
            },
            {
              score: 8,
              show: {
                title: "Arrested Development",
                year: 2003,
                ids: { trakt: 222 },
                images: {
                  poster: [
                    "media.trakt.tv/posters/arrested-medium.jpg.webp"
                  ]
                }
              }
            }
          ]
        };
      }
      if (request.url.pathname === "/shows/111/seasons/1/episodes/6") {
        return {
          statusCode: 404,
          body: {}
        };
      }
      if (request.url.pathname === "/shows/222/seasons/1/episodes/6") {
        return {
          statusCode: 200,
          body: {
            title: "Visiting Ours",
            season: 1,
            number: 6
          }
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const results = await trakt.searchCorrectionCandidates({
      type: "episode",
      title: "Arrested Development",
      showTitle: "Arrested Development",
      season: 1,
      episode: 6,
      episodeTitle: "Visiting Ours"
    }, "Arrested Development", 6);

    assert.deepStrictEqual(results, [
      {
        trakt: 222,
        kind: "episode",
        title: "Arrested Development",
        subtitle: "Show · 2003",
        detail: "S01E06 - Visiting Ours · title match",
        year: 2003,
        posterUrl: "https://media.trakt.tv/posters/arrested-medium.jpg.webp"
      }
    ]);
  });

  await test("stores a manual episode override as a verified cache entry", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({ movie: {}, show: {} });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/shows/222/seasons/1/episodes/6") {
        return {
          statusCode: 200,
          body: {
            title: "Visiting Ours",
            season: 1,
            number: 6
          }
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    await trakt.applyMatchOverride({
      type: "episode",
      title: "Arrested Development",
      showTitle: "Arrested Development",
      season: 1,
      episode: 6,
      episodeTitle: "Visiting Ours"
    }, 222);

    const cache = JSON.parse(store[CACHE_PATH]);
    assert.deepStrictEqual(cache.show["arrested development|"], {
      trakt: 222,
      verified: true
    });

    const payload = await trakt.prepareScrobblePayload({
      type: "episode",
      title: "Arrested Development",
      showTitle: "Arrested Development",
      season: 1,
      episode: 6,
      episodeTitle: "Visiting Ours"
    });

    assert.deepStrictEqual(payload, {
      show: {
        ids: { trakt: 222 }
      },
      episode: {
        season: 1,
        number: 6
      }
    });
    assert.strictEqual(calls.length, 1);
  });

  await test("returns movie correction candidates with year metadata", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({ movie: {}, show: {} });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/search/movie") {
        return {
          statusCode: 200,
          body: [
            {
              score: 8,
              movie: {
                title: "Big Fat Liar",
                year: 2002,
                ids: { trakt: 123 },
                images: {
                  poster: [
                    "media.trakt.tv/posters/big-fat-liar-medium.jpg.webp"
                  ]
                }
              }
            }
          ]
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const results = await trakt.searchCorrectionCandidates({
      type: "movie",
      title: "Big Fat Liar",
      year: 2002
    }, "Big Fat Liar", 6);

    assert.deepStrictEqual(results, [
      {
        trakt: 123,
        kind: "movie",
        title: "Big Fat Liar",
        subtitle: "Movie · 2002",
        detail: "",
        year: 2002,
        posterUrl: "https://media.trakt.tv/posters/big-fat-liar-medium.jpg.webp"
      }
    ]);
  });

  await test("looks up a movie correction candidate directly by trakt slug", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({ movie: {}, show: {} });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/movies/the-crush-1993") {
        return {
          statusCode: 200,
          body: {
            title: "The Crush",
            year: 1993,
            ids: { trakt: 21401, slug: "the-crush-1993" },
            images: {
              poster: [
                "media.trakt.tv/posters/the-crush-1993-medium.jpg.webp"
              ]
            }
          }
        };
      }

      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const result = await trakt.lookupCorrectionReference({
      type: "movie",
      title: "Crush",
      year: 2022
    }, "the-crush-1993");

    assert.deepStrictEqual(result, {
      trakt: 21401,
      kind: "movie",
      title: "The Crush",
      subtitle: "Movie · 1993",
      detail: "",
      year: 1993,
      posterUrl: "https://media.trakt.tv/posters/the-crush-1993-medium.jpg.webp"
    });
    assert.deepStrictEqual(calls, [
      "GET /movies/the-crush-1993?extended=full"
    ]);
  });

  await test("looks up an episode correction candidate directly by trakt slug", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({ movie: {}, show: {} });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/shows/arrested-development") {
        return {
          statusCode: 200,
          body: {
            title: "Arrested Development",
            year: 2003,
            ids: { trakt: 4589, slug: "arrested-development" },
            images: {
              poster: [
                "media.trakt.tv/posters/arrested-development-medium.jpg.webp"
              ]
            }
          }
        };
      }
      if (request.url.pathname === "/shows/4589/seasons/1/episodes/6") {
        return {
          statusCode: 200,
          body: {
            title: "Visiting Ours",
            season: 1,
            number: 6
          }
        };
      }

      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const result = await trakt.lookupCorrectionReference({
      type: "episode",
      title: "Arrested Development",
      showTitle: "Arrested Development",
      season: 1,
      episode: 6,
      episodeTitle: "Visiting Ours"
    }, "arrested-development");

    assert.deepStrictEqual(result, {
      trakt: 4589,
      kind: "episode",
      title: "Arrested Development",
      subtitle: "Show · 2003",
      detail: "S01E06 - Visiting Ours · title match",
      year: 2003,
      posterUrl: "https://media.trakt.tv/posters/arrested-development-medium.jpg.webp"
    });
    assert.deepStrictEqual(calls, [
      "GET /shows/arrested-development?extended=full",
      "GET /shows/4589/seasons/1/episodes/6"
    ]);
  });

  await test("prioritizes exact movie title matches with matching year in correction search", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({ movie: {}, show: {} });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/search/movie") {
        const years = request.url.searchParams.get("years") || "";
        if (years === "2022") {
          return {
            statusCode: 200,
            body: [
              {
                score: 5,
                movie: {
                  title: "Crush",
                  year: 2022,
                  ids: { trakt: 3022 },
                  images: {
                    poster: [
                      "media.trakt.tv/posters/crush-2022-medium.jpg.webp"
                    ]
                  }
                }
              }
            ]
          };
        }

        return {
          statusCode: 200,
          body: [
            {
              score: 9,
              movie: {
                title: "The Crush",
                year: 1993,
                ids: { trakt: 21993 },
                images: {
                  poster: [
                    "media.trakt.tv/posters/the-crush-1993-medium.jpg.webp"
                  ]
                }
              }
            },
            {
              score: 8,
              movie: {
                title: "Blue Crush",
                year: 2002,
                ids: { trakt: 22002 },
                images: {
                  poster: [
                    "media.trakt.tv/posters/blue-crush-2002-medium.jpg.webp"
                  ]
                }
              }
            }
          ]
        };
      }

      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const results = await trakt.searchCorrectionCandidates({
      type: "movie",
      title: "Crush",
      year: 2022
    }, "Crush", 10);

    assert.strictEqual(results[0].trakt, 3022);
    assert.strictEqual(results[0].title, "Crush");
    assert.strictEqual(results[0].year, 2022);
    assert.strictEqual(
      results[0].posterUrl,
      "https://media.trakt.tv/posters/crush-2022-medium.jpg.webp"
    );
  });

  await test("skips stop scrobbles below 1 percent without calling trakt", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({
      movie: {
        "big fat liar|2002": 123
      },
      show: {}
    });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function() {
      throw new Error("stop below 1% should not hit the network");
    }, logs);

    const result = await trakt.scrobble("stop", {
      type: "movie",
      title: "Big Fat Liar",
      year: 2002
    }, 0.15);

    assert.deepStrictEqual(result, {
      ok: false,
      skip: true,
      reason: "stop-too-early"
    });
    assert.deepStrictEqual(calls, []);
    assert(logs.some(function(line) {
      return line.indexOf("Skipping Trakt stop below 1% progress") >= 0;
    }));
  });

  await test("logs payload and body when trakt returns 422", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({
      movie: {
        "big fat liar|2002": 123
      },
      show: {}
    });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/scrobble/pause") {
        return {
          statusCode: 422,
          body: {
            error: "validation failed"
          }
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    let thrown = null;
    try {
      await trakt.scrobble("pause", {
        type: "movie",
        title: "Big Fat Liar",
        year: 2002
      }, 5.25);
    } catch (error) {
      thrown = error;
    }

    assert(thrown, "expected trakt.scrobble to throw on 422");
    assert.strictEqual(thrown.statusCode, 422);
    assert.strictEqual(thrown.scrobbleVerb, "pause");
    assert.deepStrictEqual(thrown.requestPayload, {
      movie: {
        ids: { trakt: 123 }
      },
      progress: 5.25
    });
    assert(logs.some(function(line) {
      return line.indexOf("Trakt scrobble HTTP 422 verb=pause") >= 0 &&
        line.indexOf("\"progress\":5.25") >= 0 &&
        line.indexOf("validation failed") >= 0;
    }));
  });

  await test("returns trakt action and progress on successful scrobble", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({
      movie: {
        "big fat liar|2002": 123
      },
      show: {}
    });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/scrobble/stop") {
        return {
          statusCode: 200,
          body: {
            action: "scrobble",
            progress: 99.92
          }
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const result = await trakt.scrobble("stop", {
      type: "movie",
      title: "Big Fat Liar",
      year: 2002
    }, 99.92);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, "scrobble");
    assert.strictEqual(result.progress, 99.92);
    assert.deepStrictEqual(result.body, {
      action: "scrobble",
      progress: 99.92
    });
  });

  await test("normalizes high-progress pause to stop", async function() {
    const store = {};
    const logs = [];
    store[CACHE_PATH] = JSON.stringify({
      show: {
        "make some noise|": {
          trakt: 196240,
          verified: true
        }
      },
      movie: {}
    });
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/scrobble/stop") {
        return {
          statusCode: 200,
          body: {
            action: "scrobble",
            progress: 88.83
          }
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const result = await trakt.scrobble("pause", {
      type: "episode",
      title: "Make Some Noise",
      showTitle: "Make Some Noise",
      season: 3,
      episode: 18,
      episodeTitle: "A Date That Is Only Red Flags"
    }, 88.83);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.verb, "stop");
    assert.strictEqual(result.action, "scrobble");
    assert(calls.some(function(call) {
      return call.indexOf("POST /scrobble/stop") === 0;
    }));
    assert(logs.some(function(line) {
      return line.indexOf("Normalizing Trakt pause to stop at 88.83%") >= 0;
    }));
  });

  await test("loads and caches recent Trakt history", async function() {
    const store = {};
    const logs = [];
    store[TOKEN_PATH] = JSON.stringify(makeToken());

    const { trakt, calls } = loadFreshTrakt(store, function(request) {
      if (request.url.pathname === "/users/me/history") {
        return {
          statusCode: 200,
          body: [
            {
              id: 101,
              type: "episode",
              watched_at: "2026-05-05T00:00:00.000Z",
              show: {
                title: "Game Changer"
              },
              episode: {
                season: 7,
                number: 9,
                title: "Who Wants to Be"
              }
            },
            {
              id: 202,
              type: "movie",
              watched_at: "2026-05-04T20:00:00.000Z",
              movie: {
                title: "Big Fat Liar",
                year: 2002
              }
            }
          ]
        };
      }
      throw new Error("Unhandled request: " + request.method + " " + request.url.pathname + request.url.search);
    }, logs);

    const first = await trakt.getRecentHistory();
    const second = await trakt.getRecentHistory();

    assert.deepStrictEqual(first.items, [
      {
        id: 101,
        type: "episode",
        label: "Game Changer S07E09 - Who Wants to Be",
        watchedAt: "2026-05-05T00:00:00.000Z"
      },
      {
        id: 202,
        type: "movie",
        label: "Big Fat Liar (2002)",
        watchedAt: "2026-05-04T20:00:00.000Z"
      }
    ]);
    assert.strictEqual(first.error, "");
    assert.deepStrictEqual(second.items, first.items);
    assert.strictEqual(calls.filter(function(call) {
      return call.indexOf("GET /users/me/history") === 0;
    }).length, 1);
  });

  console.log("trakt resolution tests passed");
}

run().catch(function(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
