const assert = require("assert");
const monitor = require("../monitor");

function state(mediaInfo, progress, stateValue, updatedAt) {
  return {
    progress: progress,
    mediaInfo: mediaInfo,
    state: stateValue,
    duration: 120,
    updatedAt: updatedAt,
    position: (progress / 100) * 120
  };
}

const show = {
  type: "episode",
  title: "Breaking Bad",
  showTitle: "Breaking Bad",
  season: 5,
  episode: 13
};

let actions = monitor.decideActions(null, state(show, 30, monitor.State.Playing, 1), {}, {
  skipInterval: 5,
  previewThreshold: 80,
  fastPauseThreshold: 1
});
assert.deepStrictEqual(actions, ["scrobble"]);

actions = monitor.decideActions(
  state(show, 30, monitor.State.Playing, 1),
  state(show, 50, monitor.State.Paused, 5),
  {},
  {
    skipInterval: 5,
    previewThreshold: 80,
    fastPauseThreshold: 1
  }
);
assert.deepStrictEqual(actions, ["scrobble"]);

actions = monitor.decideActions(null, state(show, 90, monitor.State.Playing, 1), {}, {
  skipInterval: 5,
  previewThreshold: 80,
  fastPauseThreshold: 1
});
assert.deepStrictEqual(actions, ["enter_preview"]);

actions = monitor.decideActions(
  state(show, 10, monitor.State.Playing, 1),
  state(show, 10.2, monitor.State.Paused, 1.4),
  {},
  {
    skipInterval: 5,
    previewThreshold: 80,
    fastPauseThreshold: 1
  }
);
assert.deepStrictEqual(actions, ["scrobble", "enter_fast_pause"]);

actions = monitor.decideActions(
  state(show, 10.2, monitor.State.Paused, 1.4),
  state(show, 10.3, monitor.State.Playing, 2),
  { fastPause: true },
  {
    skipInterval: 5,
    previewThreshold: 80,
    fastPauseThreshold: 1
  }
);
assert.deepStrictEqual(actions, ["delayed_play"]);

console.log("monitor state tests passed");
