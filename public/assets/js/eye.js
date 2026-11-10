/* Modgaze — the abyssal eye.
   Pure SVG geometry; JS only maps the pointer to a gaze vector.
   The same coordinates also drive the CRT build sequence (see crt.css):
   the wireframe, the material fill and the final eye all share one frame,
   so the eye is constructed in place instead of being swapped. */

const TAU = Math.PI * 2;
const EYE = { x: 500, y: 308, iris: 160, pupil: 58 };
const EYE_PATH = 'M 54 312 C 168 194 312 126 470 116 C 650 104 816 184 946 305 C 824 426 666 500 492 508 C 320 516 166 436 54 312 Z';
const LID_TOP_LEFT = 'M 54 312 C 168 194 312 126 470 116';
const LID_TOP_RIGHT = 'M 946 305 C 816 184 650 104 470 116';
const LID_BOTTOM_LEFT = 'M 54 312 C 166 436 320 516 492 508';
const LID_BOTTOM_RIGHT = 'M 946 305 C 824 426 666 500 492 508';
let eyeBound = false;
let pointerFrame = 0;
let pendingPointer = null;

function noise(index, salt = 0) {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function buildFibers(prefix) {
  const rows = [];
  for (let index = 0; index < 168; index += 1) {
    const jitter = (noise(index, 1) - 0.5) * 0.03;
    const angle = (index / 168) * TAU + jitter;
    const inner = 56 + noise(index, 2) * 20;
    const outer = 133 + noise(index, 3) * 32;
    const x1 = EYE.x + Math.cos(angle) * inner;
    const y1 = EYE.y + Math.sin(angle) * inner;
    const x2 = EYE.x + Math.cos(angle) * outer;
    const y2 = EYE.y + Math.sin(angle) * outer;
    const warm = noise(index, 4);
    const color = warm > 0.83 ? '#eac287' : warm > 0.42 ? '#a9582a' : '#5b2112';
    const opacity = 0.1 + noise(index, 5) * 0.36;
    const width = 0.45 + noise(index, 6) * 1.55;
    rows.push({ index, markup: '<line x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) + '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2) + '" stroke="' + color + '" stroke-width="' + width.toFixed(2) + '" stroke-linecap="round" opacity="' + opacity.toFixed(2) + '"/>' });
  }
  return rows;
}

function fiberLayers(prefix) {
  // The same fiber geometry, split into six growing shells for the build pass.
  const rows = buildFibers(prefix);
  const shells = 6;
  const groups = Array.from({ length: shells }, function () { return []; });
  rows.forEach(function (row) { groups[row.index % shells].push(row.markup); });
  return groups.map(function (group, index) {
    return '<g class="cv-fiber" style="--cv-shell:' + index + '">' + group.join('') + '</g>';
  }).join('');
}

function buildCrypts() {
  const rows = [];
  for (let index = 0; index < 34; index += 1) {
    const angle = noise(index, 11) * TAU;
    const radius = 92 + noise(index, 12) * 66;
    const length = 8 + noise(index, 13) * 28;
    const bow = (noise(index, 14) - 0.5) * 18;
    const x = EYE.x + Math.cos(angle) * radius;
    const y = EYE.y + Math.sin(angle) * radius;
    const x2 = EYE.x + Math.cos(angle + length / radius) * radius;
    const y2 = EYE.y + Math.sin(angle + length / radius) * radius;
    const mx = (x + x2) / 2 + Math.cos(angle + Math.PI / 2) * bow;
    const my = (y + y2) / 2 + Math.sin(angle + Math.PI / 2) * bow;
    rows.push('<path d="M ' + x.toFixed(1) + ' ' + y.toFixed(1) + ' Q ' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + '" fill="none" stroke="' + (noise(index, 15) > 0.5 ? '#8e3d1e' : '#44140d') + '" stroke-width="' + (1.2 + noise(index, 16) * 3.1).toFixed(2) + '" stroke-linecap="round" opacity="' + (0.22 + noise(index, 17) * 0.32).toFixed(2) + '"/>');
  }
  return rows.join('');
}

function buildFlecks() {
  const rows = [];
  for (let index = 0; index < 42; index += 1) {
    const angle = noise(index, 61) * TAU;
    const radius = 68 + noise(index, 62) * 88;
    const x = EYE.x + Math.cos(angle) * radius;
    const y = EYE.y + Math.sin(angle) * radius;
    const size = 0.5 + noise(index, 63) * 1.8;
    rows.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + size.toFixed(2) + '" fill="' + (noise(index, 64) > 0.5 ? '#ffe6b0' : '#e7a25f') + '" opacity="' + (0.16 + noise(index, 65) * 0.42).toFixed(2) + '"/>');
  }
  return rows.join('');
}

function buildCollarette() {
  const points = [];
  const count = 72;
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * TAU;
    const radius = 82 + Math.sin(angle * 7) * 4 + (noise(index, 21) - 0.5) * 8;
    points.push((EYE.x + Math.cos(angle) * radius).toFixed(1) + ' ' + (EYE.y + Math.sin(angle) * radius).toFixed(1));
  }
  return 'M ' + points.join(' L ') + ' Z';
}

function buildPupil() {
  const points = [];
  const count = 64;
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * TAU;
    const radius = EYE.pupil + Math.sin(angle * 5 + 1.2) * 0.9 + (noise(index, 31) - 0.5) * 0.9;
    points.push((EYE.x + Math.cos(angle) * radius).toFixed(1) + ' ' + (EYE.y + Math.sin(angle) * radius).toFixed(1));
  }
  return 'M ' + points.join(' L ') + ' Z';
}

function buildVeinPaths(prefix) {
  const rows = [];
  for (const side of [-1, 1]) {
    for (let index = 0; index < 17; index += 1) {
      const edgeX = side < 0 ? 46 + noise(index, 41) * 44 : 954 - noise(index, 41) * 44;
      const edgeY = 284 + (noise(index, 42) - 0.5) * 124;
      const reach = 110 + noise(index, 43) * 105;
      const x2 = EYE.x + side * reach + (noise(index, 44) - 0.5) * 48;
      const y2 = EYE.y + (noise(index, 45) - 0.5) * 132;
      const c1x = edgeX - side * (38 + noise(index, 46) * 78);
      const c1y = edgeY + (noise(index, 47) - 0.5) * 74;
      const c2x = x2 + side * (20 + noise(index, 48) * 66);
      const c2y = y2 + (noise(index, 49) - 0.5) * 58;
      const opacity = 0.25 + noise(index, 50) * 0.34;
      const width = 0.6 + noise(index, 51) * 1.8;
      const path = 'M ' + edgeX.toFixed(1) + ' ' + edgeY.toFixed(1) + ' C ' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ', ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ', ' + x2.toFixed(1) + ' ' + y2.toFixed(1);
      rows.push('<path d="' + path + '" fill="none" stroke="url(#' + prefix + '-vein)" stroke-width="' + width.toFixed(2) + '" stroke-linecap="round" opacity="' + opacity.toFixed(2) + '"/>');
      if (index % 3 === 0) {
        const branchX = edgeX + (x2 - edgeX) * 0.55;
        const branchY = edgeY + (y2 - edgeY) * 0.55;
        rows.push('<path d="M ' + branchX.toFixed(1) + ' ' + branchY.toFixed(1) + ' q ' + (side * (10 + noise(index, 52) * 22)).toFixed(1) + ' ' + ((noise(index, 53) - 0.5) * 30).toFixed(1) + ' ' + (side * (24 + noise(index, 54) * 30)).toFixed(1) + ' ' + ((noise(index, 55) - 0.5) * 40).toFixed(1) + '" fill="none" stroke="url(#' + prefix + '-vein)" stroke-width="0.7" stroke-linecap="round" opacity="' + (opacity * 0.62).toFixed(2) + '"/>');
      }
    }
  }
  return rows;
}

function buildVeinLayers(prefix) {
  const rows = buildVeinPaths(prefix);
  const layers = 3;
  const groups = Array.from({ length: layers }, function () { return []; });
  rows.forEach(function (markup, index) { groups[index % layers].push(markup); });
  return groups.map(function (group, index) {
    return '<g class="cv-vein" style="--cv-layer:' + index + '">' + group.join('') + '</g>';
  }).join('');
}

function initMarkup(id) {
  // Build pass: calibration dot, locator axes, concentric rings and eyelid edges.
  // Every coordinate is the final eye's own coordinate, so nothing moves later.
  const cx = EYE.x;
  const cy = EYE.y;
  return '<g class="eye-init" aria-hidden="true">' +
    '<g class="cv-cal">' +
      '<path class="cv-hair" d="M ' + (cx - 30) + ' ' + cy + ' H ' + (cx + 30) + ' M ' + cx + ' ' + (cy - 30) + ' V ' + (cy + 30) + '"/>' +
      '<path class="cv-hair cv-hair-corner" d="M ' + (cx - 13) + ' ' + (cy - 9) + ' h -7 v 7 M ' + (cx + 13) + ' ' + (cy - 9) + ' h 7 v 7 M ' + (cx - 13) + ' ' + (cy + 9) + ' h -7 v -7 M ' + (cx + 13) + ' ' + (cy + 9) + ' h 7 v -7"/>' +
      '<circle class="cv-core" cx="' + cx + '" cy="' + cy + '" r="2.6"/>' +
    '</g>' +
    '<g class="cv-axes">' +
      '<line class="cv-axis" x1="54" y1="312" x2="946" y2="305"/>' +
      '<line class="cv-axis" x1="500" y1="116" x2="500" y2="508"/>' +
    '</g>' +
    '<circle class="cv-ring cv-pupil-ring" cx="' + cx + '" cy="' + cy + '" r="' + EYE.pupil + '" pathLength="1"/>' +
    '<circle class="cv-ring cv-iris-ring" cx="' + cx + '" cy="' + cy + '" r="' + EYE.iris + '" pathLength="1"/>' +
    '<path class="cv-lid cv-lid-ul" d="' + LID_TOP_LEFT + '" pathLength="1"/>' +
    '<path class="cv-lid cv-lid-ur" d="' + LID_TOP_RIGHT + '" pathLength="1"/>' +
    '<path class="cv-lid cv-lid-ll" d="' + LID_BOTTOM_LEFT + '" pathLength="1"/>' +
    '<path class="cv-lid cv-lid-lr" d="' + LID_BOTTOM_RIGHT + '" pathLength="1"/>' +
    '<g clip-path="url(#' + id('eye-clip') + ')">' +
      '<rect class="cv-scan" x="30" y="-170" width="940" height="170" fill="url(#' + id('scan') + ')"/>' +
    '</g>' +
  '</g>';
}

function eyeMarkup(prefix = 'core', options = {}) {
  const id = value => prefix + '-' + value;
  const build = options.init !== false;
  const pupilPath = buildPupil();
  return '<svg class="abyss-eye' + (build ? ' abyss-eye--built' : ' abyss-eye--final') + '" viewBox="0 0 1000 620" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">' +
    '<defs>' +
      '<radialGradient id="' + id('aura') + '" cx="50%" cy="50%" r="50%">' +
        '<stop offset="0" stop-color="#c9753e" stop-opacity=".35"/>' +
        '<stop offset=".42" stop-color="#7c2219" stop-opacity=".2"/>' +
        '<stop offset=".76" stop-color="#30080a" stop-opacity=".1"/>' +
        '<stop offset="1" stop-color="#0a0203" stop-opacity="0"/>' +
      '</radialGradient>' +
      '<radialGradient id="' + id('socket') + '" cx="50%" cy="52%" r="54%">' +
        '<stop offset="0" stop-color="#5f1715" stop-opacity=".8"/>' +
        '<stop offset=".55" stop-color="#2b080b" stop-opacity=".62"/>' +
        '<stop offset="1" stop-color="#070203" stop-opacity="0"/>' +
      '</radialGradient>' +
      '<linearGradient id="' + id('lid-top') + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#050102" stop-opacity="0"/>' +
        '<stop offset=".43" stop-color="#160507" stop-opacity=".66"/>' +
        '<stop offset=".83" stop-color="#3b0d0e" stop-opacity=".94"/>' +
        '<stop offset="1" stop-color="#591a17"/>' +
      '</linearGradient>' +
      '<linearGradient id="' + id('lid-bottom') + '" x1="0" y1="1" x2="0" y2="0">' +
        '<stop offset="0" stop-color="#040102" stop-opacity="0"/>' +
        '<stop offset=".44" stop-color="#180507" stop-opacity=".7"/>' +
        '<stop offset=".82" stop-color="#421012" stop-opacity=".94"/>' +
        '<stop offset="1" stop-color="#68231e"/>' +
      '</linearGradient>' +
      '<linearGradient id="' + id('lid-edge') + '" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#240709"/>' +
        '<stop offset=".26" stop-color="#7c2b20"/>' +
        '<stop offset=".52" stop-color="#ba6240"/>' +
        '<stop offset=".78" stop-color="#5b1715"/>' +
        '<stop offset="1" stop-color="#1b0507"/>' +
      '</linearGradient>' +
      '<radialGradient id="' + id('sclera') + '" cx="46%" cy="40%" r="74%">' +
        '<stop offset="0" stop-color="#f0ddc8"/>' +
        '<stop offset=".25" stop-color="#e2cab4"/>' +
        '<stop offset=".55" stop-color="#cba58f"/>' +
        '<stop offset=".8" stop-color="#a86e66"/>' +
        '<stop offset="1" stop-color="#6f3937"/>' +
      '</radialGradient>' +
      '<radialGradient id="' + id('sclera-bloom') + '" cx="50%" cy="50%" r="50%">' +
        '<stop offset="0" stop-color="#d48659" stop-opacity=".3"/>' +
        '<stop offset=".42" stop-color="#9a3f2f" stop-opacity=".14"/>' +
        '<stop offset="1" stop-color="#551411" stop-opacity="0"/>' +
      '</radialGradient>' +
      '<linearGradient id="' + id('vein') + '" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#5b181a"/>' +
        '<stop offset=".55" stop-color="#a84a3e"/>' +
        '<stop offset="1" stop-color="#7a2a22"/>' +
      '</linearGradient>' +
      '<radialGradient id="' + id('cold') + '" cx="50%" cy="50%" r="50%">' +
        '<stop offset="0" stop-color="#b8e1db" stop-opacity=".28"/>' +
        '<stop offset=".55" stop-color="#6c9fa1" stop-opacity=".08"/>' +
        '<stop offset="1" stop-color="#326263" stop-opacity="0"/>' +
      '</radialGradient>' +
      '<radialGradient id="' + id('caruncle') + '" cx="40%" cy="40%" r="70%">' +
        '<stop offset="0" stop-color="#d68a78" stop-opacity=".6"/>' +
        '<stop offset="1" stop-color="#6e2725" stop-opacity=".08"/>' +
      '</radialGradient>' +
      '<radialGradient id="' + id('iris') + '" cx="48%" cy="46%" r="54%">' +
        '<stop offset="0" stop-color="#f7ddb0"/>' +
        '<stop offset=".14" stop-color="#e4b878"/>' +
        '<stop offset=".31" stop-color="#ce8b4b"/>' +
        '<stop offset=".52" stop-color="#9c4c27"/>' +
        '<stop offset=".72" stop-color="#642311"/>' +
        '<stop offset=".9" stop-color="#35100c"/>' +
        '<stop offset="1" stop-color="#170607"/>' +
      '</radialGradient>' +
      '<radialGradient id="' + id('iris-depth') + '" cx="50%" cy="48%" r="50%">' +
        '<stop offset="0" stop-color="#f5cf95" stop-opacity=".08"/>' +
        '<stop offset=".55" stop-color="#9b4a25" stop-opacity="0"/>' +
        '<stop offset=".86" stop-color="#3c100d" stop-opacity=".28"/>' +
        '<stop offset="1" stop-color="#0c0304" stop-opacity=".85"/>' +
      '</radialGradient>' +
      '<radialGradient id="' + id('pupil') + '" cx="46%" cy="42%" r="54%">' +
        '<stop offset="0" stop-color="#010102"/>' +
        '<stop offset=".68" stop-color="#030203"/>' +
        '<stop offset=".9" stop-color="#100406"/>' +
        '<stop offset="1" stop-color="#230b0b"/>' +
      '</radialGradient>' +
      '<linearGradient id="' + id('glint') + '" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#fff9ee" stop-opacity=".9"/>' +
        '<stop offset=".5" stop-color="#ffe1b5" stop-opacity=".42"/>' +
        '<stop offset="1" stop-color="#f3b37c" stop-opacity="0"/>' +
      '</linearGradient>' +
      '<linearGradient id="' + id('scan') + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#ffb545" stop-opacity="0"/>' +
        '<stop offset=".38" stop-color="#ffcf86" stop-opacity=".28"/>' +
        '<stop offset=".56" stop-color="#ffe6bd" stop-opacity=".44"/>' +
        '<stop offset=".74" stop-color="#ffb545" stop-opacity=".2"/>' +
        '<stop offset="1" stop-color="#ffb545" stop-opacity="0"/>' +
      '</linearGradient>' +
      '<clipPath id="' + id('eye-clip') + '">' +
        '<path d="' + EYE_PATH + '"/>' +
      '</clipPath>' +
      '<clipPath id="' + id('iris-clip') + '">' +
        '<circle cx="' + EYE.x + '" cy="' + EYE.y + '" r="' + (EYE.iris + 5) + '"/>' +
      '</clipPath>' +
      '<filter id="' + id('soft') + '" x="-50%" y="-50%" width="200%" height="200%">' +
        '<feGaussianBlur stdDeviation="20"/>' +
      '</filter>' +
      '<filter id="' + id('soft-small') + '" x="-30%" y="-30%" width="160%" height="160%">' +
        '<feGaussianBlur stdDeviation="6"/>' +
      '</filter>' +
      '<filter id="' + id('iris-rough') + '" x="-20%" y="-20%" width="140%" height="140%">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.014 0.075" numOctaves="4" seed="19" result="grain"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="grain" scale="7" xChannelSelector="R" yChannelSelector="G"/>' +
      '</filter>' +
    '</defs>' +
    '<g class="eye-aura">' +
      '<ellipse cx="500" cy="308" rx="445" ry="262" fill="url(#' + id('aura') + ')" filter="url(#' + id('soft') + ')"/>' +
      '<ellipse cx="500" cy="308" rx="356" ry="214" fill="url(#' + id('socket') + ')" opacity=".68" filter="url(#' + id('soft') + ')"/>' +
    '</g>' +
    '<g class="eye-tissue">' +
      '<path d="M 54 312 C 168 194 312 126 470 116 C 650 104 816 184 946 305 L 1000 0 L 0 0 Z" fill="url(#' + id('lid-top') + ')"/>' +
      '<path d="M 54 312 C 166 436 320 516 492 508 C 666 500 824 426 946 305 L 1000 620 L 0 620 Z" fill="url(#' + id('lid-bottom') + ')"/>' +
      '<path d="M 54 312 C 168 194 312 126 470 116 C 650 104 816 184 946 305" fill="none" stroke="url(#' + id('lid-edge') + ')" stroke-width="21" filter="url(#' + id('soft-small') + ')" opacity=".8"/>' +
      '<path d="M 54 312 C 168 194 312 126 470 116 C 650 104 816 184 946 305" fill="none" stroke="#220708" stroke-width="7" opacity=".9"/>' +
      '<path d="M 54 312 C 166 436 320 516 492 508 C 666 500 824 426 946 305" fill="none" stroke="url(#' + id('lid-edge') + ')" stroke-width="15" filter="url(#' + id('soft-small') + ')" opacity=".56"/>' +
      '<path d="M 54 312 C 166 436 320 516 492 508 C 666 500 824 426 946 305" fill="none" stroke="#2a090a" stroke-width="4" opacity=".8"/>' +
      '<path d="M 118 270 C 242 158 396 114 518 115 C 670 116 800 178 886 270" fill="none" stroke="#8a3b2e" stroke-width="2.2" opacity=".3"/>' +
      '<path d="M 96 285 C 224 176 360 136 502 136" fill="none" stroke="#b35b42" stroke-width="1.3" opacity=".22"/>' +
      '<path d="M 112 356 C 238 454 378 488 521 492" fill="none" stroke="#8d3328" stroke-width="1.5" opacity=".23"/>' +
      '<path d="M 150 250 C 176 226 214 204 258 188" fill="none" stroke="#b15e49" stroke-width="1" opacity=".2"/>' +
      '<path d="M 744 212 C 798 236 842 266 876 296" fill="none" stroke="#9f4738" stroke-width="1.1" opacity=".18"/>' +
      '<path d="M 30 300 C 54 240 112 184 190 152" fill="none" stroke="#7d2e24" stroke-width="2.2" opacity=".25"/>' +
      '<path d="M 970 286 C 948 232 898 178 824 146" fill="none" stroke="#5a1b18" stroke-width="2" opacity=".2"/>' +
      '<path d="M 36 462 C 92 504 148 538 218 554" fill="none" stroke="#531518" stroke-width="1.6" opacity=".16"/>' +
      '<path d="M 964 456 C 906 500 844 526 776 540" fill="none" stroke="#56171a" stroke-width="1.6" opacity=".14"/>' +
    '</g>' +
    '<g class="eye-body" clip-path="url(#' + id('eye-clip') + ')">' +
      '<g class="eye-material">' +
      '<g class="cv-sclera">' +
        '<path d="' + EYE_PATH + '" fill="url(#' + id('sclera') + ')"/>' +
        '<circle cx="500" cy="308" r="300" fill="url(#' + id('sclera-bloom') + ')"/>' +
        '<ellipse cx="392" cy="244" rx="220" ry="128" fill="url(#' + id('cold') + ')" opacity=".34" filter="url(#' + id('soft-small') + ')"/>' +
        '<ellipse cx="500" cy="160" rx="438" ry="118" fill="#190609" opacity=".5" filter="url(#' + id('soft-small') + ')"/>' +
        '<ellipse cx="500" cy="486" rx="400" ry="84" fill="#3b0c0f" opacity=".38" filter="url(#' + id('soft-small') + ')"/>' +
        '<ellipse cx="80" cy="312" rx="66" ry="46" fill="#67231f" opacity=".32" filter="url(#' + id('soft-small') + ')"/>' +
        '<ellipse cx="920" cy="308" rx="70" ry="44" fill="#58191c" opacity=".28" filter="url(#' + id('soft-small') + ')"/>' +
        '<path d="M 70 310 C 96 289 112 305 118 324 C 104 342 82 349 70 332 Z" fill="url(#' + id('caruncle') + ')" opacity=".65"/>' +
        '<ellipse cx="500" cy="466" rx="342" ry="42" fill="#f2c3a4" opacity=".13" filter="url(#' + id('soft-small') + ')"/>' +
        '<ellipse cx="388" cy="298" rx="175" ry="54" transform="rotate(-8 388 298)" fill="#fff0da" opacity=".06" filter="url(#' + id('soft-small') + ')"/>' +
      '</g>' +
      '<g class="eye-veins" opacity=".86">' + buildVeinLayers(prefix) + '</g>' +
      '<g class="eye-gaze">' +
        '<circle cx="500" cy="308" r="182" fill="#240a08" opacity=".8" filter="url(#' + id('soft-small') + ')"/>' +
        '<g clip-path="url(#' + id('iris-clip') + ')">' +
          '<circle class="cv-iris-base" cx="500" cy="308" r="166" fill="url(#' + id('iris') + ')"/>' +
          '<g class="cv-fibers" filter="url(#' + id('iris-rough') + ')" opacity=".95">' + fiberLayers(prefix) + '</g>' +
          '<g class="cv-crypts" opacity=".9">' + buildCrypts() + '</g>' +
          '<g class="cv-iris-detail">' +
          '<g class="cv-flecks" opacity=".9">' + buildFlecks() + '</g>' +
          '<ellipse cx="468" cy="254" rx="88" ry="44" transform="rotate(-28 468 254)" fill="#2c0a06" opacity=".16" filter="url(#' + id('soft-small') + ')"/>' +
          '<circle cx="500" cy="308" r="91" fill="#3d100a" opacity=".42" filter="url(#' + id('soft-small') + ')"/>' +
          '<path d="' + buildCollarette() + '" fill="none" stroke="#e7b173" stroke-width="3.2" opacity=".19" filter="url(#' + id('soft-small') + ')"/>' +
          '<path d="' + buildCollarette() + '" fill="none" stroke="#f6cd91" stroke-width="0.85" opacity=".32"/>' +
          '<circle cx="500" cy="308" r="166" fill="url(#' + id('iris-depth') + ')"/>' +
          '</g>' +
          '<path class="cv-glint" d="M 377 274 C 397 231 448 200 512 192 C 468 215 421 250 397 296 Z" fill="url(#' + id('glint') + ')" opacity=".5" filter="url(#' + id('soft-small') + ')"/>' +
          '<ellipse cx="432" cy="236" rx="21" ry="8" transform="rotate(-35 432 236)" fill="#c8ede4" opacity=".25" filter="url(#' + id('soft-small') + ')"/>' +
          '<ellipse cx="570" cy="370" rx="11" ry="7" transform="rotate(-26 570 370)" fill="#fff2d8" opacity=".42" filter="url(#' + id('soft-small') + ')"/>' +
          '<ellipse cx="522" cy="232" rx="18" ry="31" transform="rotate(19 522 232)" fill="#ffe9c8" opacity=".13" filter="url(#' + id('soft-small') + ')"/>' +
        '</g>' +
        '<circle cx="500" cy="308" r="165" fill="none" stroke="#1b0707" stroke-width="12" opacity=".92"/>' +
        '<circle cx="500" cy="308" r="170" fill="none" stroke="#c87c42" stroke-width="1.3" opacity=".3"/>' +
        '<circle cx="500" cy="308" r="160" fill="none" stroke="#e2ad71" stroke-width="0.8" opacity=".22"/>' +
        '<ellipse cx="482" cy="286" rx="16" ry="8" transform="rotate(-27 482 286)" fill="#fff8ea" opacity=".16" filter="url(#' + id('soft-small') + ')"/>' +
        '<g class="eye-pupil">' +
          '<g class="eye-pupil-core">' +
            '<path d="' + pupilPath + '" fill="url(#' + id('pupil') + ')" stroke="#3a120e" stroke-width="2"/>' +
            '<circle cx="500" cy="308" r="49" fill="#020102" opacity=".9"/>' +
            '<path class="cv-pupil-rim" d="' + pupilPath + '" fill="none" stroke="#d58c54" stroke-width="1.2" opacity=".3"/>' +
          '</g>' +
        '</g>' +
        '<circle class="iris-shock" cx="500" cy="308" r="177" fill="none" stroke="#ffd3a1" stroke-width="1.4"/>' +
      '</g>' +
      '<g class="eye-glints" opacity=".8">' +
        '<path d="M 70 312 C 190 258 286 219 402 193" fill="none" stroke="#fff0dc" stroke-width="0.8" opacity=".14"/>' +
        '<ellipse cx="374" cy="206" rx="72" ry="11" transform="rotate(20 374 206)" fill="#fff2dc" opacity=".1" filter="url(#' + id('soft-small') + ')"/>' +
      '</g>' +
      '<ellipse cx="500" cy="152" rx="358" ry="122" fill="#130507" opacity=".5" filter="url(#' + id('soft-small') + ')"/>' +
      '<ellipse cx="500" cy="505" rx="332" ry="34" fill="#f9d6b9" opacity=".16" filter="url(#' + id('soft-small') + ')"/>' +
      '</g>' +
    '</g>' +
    (build ? initMarkup(id) : '') +
    '<g class="eye-lid-glow" fill="none">' +
      '<path d="M 54 312 C 168 194 312 126 470 116 C 650 104 816 184 946 305" stroke="#f1ae72" stroke-width="1" opacity=".2"/>' +
      '<path d="M 54 312 C 166 436 320 516 492 508 C 666 500 824 426 946 305" stroke="#ffd0a1" stroke-width="1" opacity=".2"/>' +
    '</g>' +
  '</svg>';
}

function resetGaze() {
  const eye = document.querySelector('.abyss-eye');
  if (!eye) return;
  eye.style.setProperty('--gaze-x', '0px');
  eye.style.setProperty('--gaze-y', '0px');
  eye.style.setProperty('--pupil-x', '0px');
  eye.style.setProperty('--pupil-y', '0px');
  eye.style.setProperty('--gaze-angle', '0rad');
  eye.style.setProperty('--gaze-distance', '0');
}

function applyGaze(clientX, clientY) {
  const eye = document.querySelector('.abyss-eye');
  if (!eye) return;
  const rect = eye.getBoundingClientRect();
  if (!rect.width) return;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const dx = clientX - centerX;
  const dy = clientY - centerY;
  const angle = Math.atan2(dy, dx);
  const distance = Math.min(1, Math.hypot(dx, dy) / Math.max(280, rect.width * 0.58));
  const gazeX = Math.cos(angle) * 7.2 * distance;
  const gazeY = Math.sin(angle) * 5.6 * distance;
  const pupilX = Math.cos(angle) * 4.2 * distance;
  const pupilY = Math.sin(angle) * 3.4 * distance;
  eye.style.setProperty('--gaze-x', gazeX.toFixed(2) + 'px');
  eye.style.setProperty('--gaze-y', gazeY.toFixed(2) + 'px');
  eye.style.setProperty('--pupil-x', pupilX.toFixed(2) + 'px');
  eye.style.setProperty('--pupil-y', pupilY.toFixed(2) + 'px');
  eye.style.setProperty('--gaze-angle', angle.toFixed(3) + 'rad');
  eye.style.setProperty('--gaze-distance', distance.toFixed(3));
}

function updateGaze(event) {
  if (!event || event.pointerType === 'touch') return;
  pendingPointer = event;
  if (pointerFrame) return;
  pointerFrame = requestAnimationFrame(function () {
    pointerFrame = 0;
    const pointer = pendingPointer;
    pendingPointer = null;
    if (pointer) applyGaze(pointer.clientX, pointer.clientY);
  });
}

function strikePupil() {
  const eye = document.querySelector('.abyss-eye');
  if (!eye) return;
  const pupil = eye.querySelector('.eye-pupil-core');
  if (!pupil) return;
  eye.classList.remove('is-striking');
  // Reflow so the shock ring restarts even on a rapid second click.
  void eye.getBoundingClientRect();
  eye.classList.add('is-striking');
  window.setTimeout(function () { eye.classList.remove('is-striking'); }, 760);
  pupil.getAnimations().forEach(function (animation) { animation.cancel(); });
  // Set the contracted frame synchronously; the spring-back is the animation.
  pupil.style.transform = 'scale(0.53)';
  const spring = pupil.animate([
    { transform: 'scale(0.53)', offset: 0 },
    { transform: 'scale(0.57)', offset: 0.15 },
    { transform: 'scale(0.82)', offset: 0.42 },
    { transform: 'scale(0.64)', offset: 0.66 },
    { transform: 'scale(1)', offset: 1 },
  ], {
    duration: 620,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'none',
  });
  spring.onfinish = function () { pupil.style.transform = ''; };
  spring.oncancel = function () { pupil.style.transform = ''; };
}

function initEye() {
  if (eyeBound) return;
  eyeBound = true;
  window.addEventListener('mousemove', updateGaze, { passive: true });
  window.addEventListener('mouseleave', resetGaze, { passive: true });
  window.addEventListener('blur', resetGaze);
  document.addEventListener('pointerdown', function (event) {
    applyGaze(event.clientX, event.clientY);
    strikePupil();
  }, { passive: true, capture: true });
}

export { eyeMarkup, initEye, resetGaze };
