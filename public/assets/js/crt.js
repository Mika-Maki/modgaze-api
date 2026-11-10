/* Modgaze — CRT init sequence.
   One build pass, five beats, 2.6 s:
     signal (0–450) · skeleton (450–1050) · material (1050–1850)
     imaging (1850–2250) · control plane (2250–2600)
   The hub is measured in its final frame from the first millisecond.
   Nothing is resized, moved or swapped afterwards: the same SVG that shows
   a calibration dot at t=0 holds the finished eye at t=2600, and a
   pre-rasterised copy of the finished eye takes over two frames before the
   glow dies. Under prefers-reduced-motion the same beats collapse to the
   signal and one 240 ms dissolve — no drawing, no scan sweep. */

const BEATS = [
  { at: 450, className: 'crt-skeleton', phase: 'skeleton' },
  { at: 1050, className: 'crt-material', phase: 'material' },
  { at: 1850, className: 'crt-image', phase: 'imaging' },
  { at: 2250, className: 'crt-ui', phase: 'control' },
];
const SWAP_MS = 2300;   // glow tail is ~30 ms from zero: two frames left
const RETIRE_MS = 2345; // crossfade done, retire the build pass
const SETTLE_MS = 2960;
const STILL = { swap: 600, retire: 670, chrome: 850, settle: 1400 };
const CLASSES = ['is-init', 'crt-still', 'crt-skeleton', 'crt-material', 'crt-image', 'crt-ui'];
const BODY_CLASSES = ['crt-init', 'crt-ui'];

let timers = [];
let stageRef = null;
let playing = false;
let played = false;

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clearTimers() {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
}

function later(delay, fn) {
  timers.push(window.setTimeout(fn, delay));
}

function shellOf(stage) {
  return stage ? stage.querySelector('.eye-shell') : null;
}

function retire(stage) {
  if (!stage) return;
  const built = stage.querySelector('.abyss-eye--built');
  const shell = shellOf(stage);
  if (!built) { if (shell) shell.classList.add('is-final'); return; }
  built.remove();
  if (shell) shell.classList.add('is-final');
}

/* Called the moment the shell becomes visible, so the header never flashes
   before the signal does. */
function primeCrt({ restart = false } = {}) {
  // A successful login starts a new session, not a new document. Ordinary
  // navigation still uses standDownCrt() without rearming the one-shot build.
  if (restart) {
    standDownCrt();
    played = false;
  }
  if (played) return false;
  document.body.classList.add('crt-init');
  return true;
}

function standDownCrt() {
  clearTimers();
  const stage = stageRef || document.querySelector('#hub-stage');
  if (stage) {
    CLASSES.forEach(function (name) { stage.classList.remove(name); });
    stage.dataset.initPhase = 'idle';
  }
  const shell = document.querySelector('.eye-shell');
  if (shell) shell.classList.remove('is-swapping');
  retire(stage);
  BODY_CLASSES.forEach(function (name) { document.body.classList.remove(name); });
  playing = false;
  stageRef = null;
}

function enterChrome(stage) {
  if (!stage.isConnected) return;
  stage.classList.add('crt-ui');
  stage.classList.add('orbit-ready');
  stage.dataset.initPhase = 'control';
  document.body.classList.add('crt-ui');
}

function settle(stage) {
  if (stage && stage.isConnected) {
    CLASSES.forEach(function (name) { stage.classList.remove(name); });
    stage.dataset.initPhase = 'idle';
    // The eye and the layout are fully materialised; keep the stage in its
    // resting state for the rest of the session.
    stage.classList.add('orbit-ready');
  }
  BODY_CLASSES.forEach(function (name) { document.body.classList.remove(name); });
  playing = false;
  stageRef = null;
  played = true;
}

function beginCrt(stage) {
  if (!stage || stage === stageRef) return;
  if (playing) {
    // A silent refresh or hash change replaced the stage mid-build. Hand the
    // sequence to the new stage instead of leaving it in its finished state.
    clearTimers();
    playing = false;
    played = false;
    stageRef = null;
    document.body.classList.remove('crt-ui');
  }
  if (played) {
    document.body.classList.remove('crt-init', 'crt-ui');
    stage.classList.remove(...CLASSES);
    stage.dataset.initPhase = 'idle';
    retire(stage);
    return;
  }

  playing = true;
  played = true;
  stageRef = stage;
  stage.classList.add('is-init');
  stage.classList.remove('orbit-ready');
  stage.dataset.initPhase = 'signal';
  document.body.classList.add('crt-init');

  if (reducedMotion()) {
    stage.classList.add('crt-still');
    later(STILL.swap, function () {
      const shell = shellOf(stage);
      if (shell) shell.classList.add('is-swapping');
    });
    later(STILL.retire, function () { retire(stage); });
    later(STILL.chrome, function () { enterChrome(stage); });
    later(STILL.settle, function () { settle(stage); });
    return;
  }

  BEATS.forEach(function (beat) {
    later(beat.at, function () {
      if (!stage.isConnected) return;
      stage.classList.add(beat.className);
      stage.dataset.initPhase = beat.phase;
      if (beat.className === 'crt-ui') enterChrome(stage);
    });
  });
  later(SWAP_MS, function () {
    const shell = shellOf(stage);
    if (shell) shell.classList.add('is-swapping');
  });
  later(RETIRE_MS, function () {
    if (!stage.isConnected) return;
    // The pre-rendered eye is already opaque on top; dropping the build pass
    // here is invisible, and it frees the animated filters for good.
    retire(stage);
  });
  later(SETTLE_MS, function () { settle(stage); });
}

export { beginCrt, standDownCrt, primeCrt };
