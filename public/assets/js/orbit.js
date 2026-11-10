/* Modgaze — radial orbit + living synapse lines. */
import { $ } from "./core.js";

let observer = null;
let currentStage = null;
let layoutFrame = 0;
let resizeHandler = null;
let activeModule = null;

const CORNERS = {
  tl: { x: -1, y: -1, curve: -1 },
  tr: { x: 1, y: -1, curve: 1 },
  br: { x: 1, y: 1, curve: -1 },
  bl: { x: -1, y: 1, curve: 1 },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function compactMode() {
  return window.matchMedia('(max-width: 1080px), (max-height: 720px)').matches;
}

function edgePoint(card, target) {
  const dx = target.x - card.x;
  const dy = target.y - card.y;
  if (!dx && !dy) return { x: card.x, y: card.y };
  const horizontal = Math.abs(dx) > 0.001 ? (card.w / 2) / Math.abs(dx) : Infinity;
  const vertical = Math.abs(dy) > 0.001 ? (card.h / 2) / Math.abs(dy) : Infinity;
  const scale = Math.min(horizontal, vertical) * 0.94;
  return { x: card.x + dx * scale, y: card.y + dy * scale };
}

function pointAlong(start, c1, c2, end, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * start.x + b * c1.x + c * c2.x + d * end.x,
    y: a * start.y + b * c1.y + c * c2.y + d * end.y,
  };
}

function buildVein(card, center, module, index) {
  const end = edgePoint(card, center);
  const dx = end.x - center.x;
  const dy = end.y - center.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / length;
  const uy = dy / length;
  const curve = CORNERS[card.corner]?.curve || 1;
  const wave = clamp(length * 0.085, 18, 74) * curve;
  const c1 = { x: center.x + dx * 0.25 - uy * wave, y: center.y + dy * 0.25 + ux * wave };
  const c2 = { x: center.x + dx * 0.7 + uy * wave * 0.42, y: center.y + dy * 0.7 - ux * wave * 0.42 };
  const main = 'M ' + center.x.toFixed(1) + ' ' + center.y.toFixed(1) +
    ' C ' + c1.x.toFixed(1) + ' ' + c1.y.toFixed(1) + ', ' + c2.x.toFixed(1) + ' ' + c2.y.toFixed(1) + ', ' + end.x.toFixed(1) + ' ' + end.y.toFixed(1);
  const branchBase = pointAlong(center, c1, c2, end, 0.7);
  const branchDir = CORNERS[card.corner]?.y || 1;
  const branch = 'M ' + branchBase.x.toFixed(1) + ' ' + branchBase.y.toFixed(1) +
    ' q ' + (ux * 30 + uy * 18 * branchDir).toFixed(1) + ' ' + (uy * 30 - ux * 18 * branchDir).toFixed(1) +
    ' ' + (ux * 58 + uy * 8 * branchDir).toFixed(1) + ' ' + (uy * 58 - ux * 8 * branchDir).toFixed(1);
  const branchBaseTwo = pointAlong(center, c1, c2, end, 0.42);
  const branchTwo = 'M ' + branchBaseTwo.x.toFixed(1) + ' ' + branchBaseTwo.y.toFixed(1) +
    ' q ' + (ux * 20 - uy * 26 * branchDir).toFixed(1) + ' ' + (uy * 20 + ux * 26 * branchDir).toFixed(1) +
    ' ' + (ux * 42 - uy * 20 * branchDir).toFixed(1) + ' ' + (uy * 42 + ux * 20 * branchDir).toFixed(1);
  const thinOffset = 15 * curve;
  const thin = 'M ' + center.x.toFixed(1) + ' ' + center.y.toFixed(1) +
    ' C ' + (c1.x - uy * thinOffset).toFixed(1) + ' ' + (c1.y + ux * thinOffset).toFixed(1) + ', ' +
    (c2.x - uy * thinOffset * 0.7).toFixed(1) + ' ' + (c2.y + ux * thinOffset * 0.7).toFixed(1) + ', ' +
    (end.x - uy * 4).toFixed(1) + ' ' + (end.y + ux * 4).toFixed(1);
  const gradientId = 'vein-' + module;
  return {
    gradient: '<linearGradient id="' + gradientId + '" gradientUnits="userSpaceOnUse" x1="' + center.x.toFixed(1) + '" y1="' + center.y.toFixed(1) + '" x2="' + end.x.toFixed(1) + '" y2="' + end.y.toFixed(1) + '">' +
      '<stop offset="0" stop-color="#33070a" stop-opacity=".34"/>' +
      '<stop offset=".28" stop-color="#7f1c1c" stop-opacity=".72"/>' +
      '<stop offset=".62" stop-color="#c44b33" stop-opacity=".94"/>' +
      '<stop offset=".86" stop-color="#eaa363" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="#ffe0b2"/>' +
    '</linearGradient>',
    group: '<g class="vein-group" data-module="' + module + '" style="--vein-delay:' + (index * 120) + 'ms">' +
      '<path class="vein-bloom" d="' + main + '" pathLength="1"/>' +
      '<path class="vein-main" d="' + main + '" pathLength="1" stroke="url(#' + gradientId + ')"/>' +
      '<path class="vein-thin" d="' + thin + '" pathLength="1" stroke="url(#' + gradientId + ')"/>' +
      '<path class="vein-branch" d="' + branch + '" pathLength="1" stroke="url(#' + gradientId + ')"/>' +
      '<path class="vein-branch vein-branch-two" d="' + branchTwo + '" pathLength="1" stroke="url(#' + gradientId + ')"/>' +
      '<path class="vein-pulse" d="' + main + '" pathLength="1" stroke="url(#' + gradientId + ')"/>' +
      '<circle class="vein-node" cx="' + end.x.toFixed(1) + '" cy="' + end.y.toFixed(1) + '" r="3.1"/>' +
    '</g>',
  };
}

function drawSynapses(stage, eye, cards, dimensions) {
  const svg = $('#hub-synapses', stage);
  if (!svg) return;
  const width = dimensions.width;
  const height = dimensions.height;
  const center = { x: eye.x, y: eye.y };
  const ringX = Math.max(150, eye.w * 0.60);
  const ringY = Math.max(100, eye.h * 0.63);
  const veins = cards.map(function (card, index) { return buildVein(card, center, card.module, index); });
  let markup = '<defs>' +
    veins.map(function (vein) { return vein.gradient; }).join('') +
    '<filter id="vein-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>' +
    '<radialGradient id="orbit-fade" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#d0854d" stop-opacity=".22"/><stop offset=".72" stop-color="#7e2922" stop-opacity=".11"/><stop offset="1" stop-color="#4b1116" stop-opacity="0"/></radialGradient>' +
    '</defs>';
  markup += '<ellipse class="orbit-haze" cx="' + center.x.toFixed(1) + '" cy="' + center.y.toFixed(1) + '" rx="' + (ringX * 1.15).toFixed(1) + '" ry="' + (ringY * 1.22).toFixed(1) + '" fill="url(#orbit-fade)"/>';
  markup += '<ellipse class="orbit-ring orbit-ring-outer" cx="' + center.x.toFixed(1) + '" cy="' + center.y.toFixed(1) + '" rx="' + ringX.toFixed(1) + '" ry="' + ringY.toFixed(1) + '"/>';
  markup += '<ellipse class="orbit-ring orbit-ring-inner" cx="' + center.x.toFixed(1) + '" cy="' + center.y.toFixed(1) + '" rx="' + (ringX * 0.72).toFixed(1) + '" ry="' + (ringY * 0.72).toFixed(1) + '"/>';
  const ticks = [];
  for (let i = 0; i < 36; i += 1) {
    if (i % 3 === 0) continue;
    const angle = (i / 36) * Math.PI * 2;
    const inner = 0.986;
    const outer = 1.012;
    ticks.push('<line x1="' + (center.x + Math.cos(angle) * ringX * inner).toFixed(1) + '" y1="' + (center.y + Math.sin(angle) * ringY * inner).toFixed(1) + '" x2="' + (center.x + Math.cos(angle) * ringX * outer).toFixed(1) + '" y2="' + (center.y + Math.sin(angle) * ringY * outer).toFixed(1) + '"/>');
  }
  markup += '<g class="orbit-ticks">' + ticks.join('') + '</g>';
  // Branches sit under the main arteries so junctions stay clean.
  markup += veins.map(function (vein) { return vein.group; }).join('');
  svg.setAttribute('viewBox', '0 0 ' + width.toFixed(0) + ' ' + height.toFixed(0));
  svg.innerHTML = markup;
}

function setActive(module) {
  if (activeModule === module) return;
  activeModule = module;
  if (!currentStage) return;
  currentStage.classList.toggle('has-focus', Boolean(module));
  currentStage.querySelectorAll('.vein-group').forEach(function (group) {
    group.classList.toggle('is-active', group.dataset.module === module);
  });
  currentStage.querySelectorAll('.orbit-card').forEach(function (card) {
    card.classList.toggle('is-focused', card.dataset.module === module);
  });
}

function clearActive() {
  activeModule = null;
  if (!currentStage) return;
  currentStage.classList.remove('has-focus');
  currentStage.querySelectorAll('.vein-group').forEach(function (group) { group.classList.remove('is-active'); });
  currentStage.querySelectorAll('.orbit-card').forEach(function (card) { card.classList.remove('is-focused'); });
}

function layout() {
  if (!currentStage) return;
  layoutFrame = 0;
  const stage = currentStage;
  const svg = $('#hub-synapses', stage);
  const eyeNode = $('#hub-eye', stage);
  const cards = Array.from(stage.querySelectorAll('.orbit-card'));
  if (!svg || !eyeNode || !cards.length) return;

  if (compactMode()) {
    stage.classList.add('is-compact');
    stage.classList.remove('orbit-ready');
    cards.forEach(function (card) {
      card.style.removeProperty('left');
      card.style.removeProperty('top');
    });
    svg.innerHTML = '';
    clearActive();
    requestAnimationFrame(function () { markReady(stage); });
    return;
  }

  stage.classList.remove('is-compact');
  const stageRect = stage.getBoundingClientRect();
  const eyeRect = eyeNode.getBoundingClientRect();
  const firstCard = cards[0].getBoundingClientRect();
  const cardW = firstCard.width || 240;
  const cardH = firstCard.height || 180;
  const width = stageRect.width;
  const height = stageRect.height;
  if (!width || !height) return;
  const eye = {
    x: eyeRect.left - stageRect.left + eyeRect.width / 2,
    y: eyeRect.top - stageRect.top + eyeRect.height / 2,
    w: eyeRect.width,
    h: eyeRect.height,
  };
  const gap = clamp(width * 0.024, 22, 54);
  let xOffset = eye.w / 2 + cardW / 2 + clamp(gap * 2.4, 68, 118);
  xOffset = Math.min(xOffset, width / 2 - cardW / 2 - 24);
  const topY = Math.max(98 + cardH / 2, height * 0.21);
  const bottomY = Math.min(height - 90 - cardH / 2, height * 0.79);
  const safeCenterY = clamp(eye.y, 130 + cardH / 2, height - 150 - cardH / 2);
  const positions = {
    tl: { x: eye.x - xOffset, y: topY },
    tr: { x: eye.x + xOffset, y: topY },
    br: { x: eye.x + xOffset, y: bottomY },
    bl: { x: eye.x - xOffset, y: bottomY },
  };
  const cardMetrics = [];
  cards.forEach(function (node) {
    const corner = node.dataset.orbit;
    const desired = positions[corner] || { x: eye.x, y: safeCenterY };
    const x = clamp(desired.x, cardW / 2 + 20, width - cardW / 2 - 20);
    const y = clamp(desired.y, cardH / 2 + 92, height - cardH / 2 - 90);
    node.style.left = x.toFixed(1) + 'px';
    node.style.top = y.toFixed(1) + 'px';
    cardMetrics.push({ x: x, y: y, w: cardW, h: cardH, corner: corner, module: node.dataset.module });
  });
  drawSynapses(stage, eye, cardMetrics, { width: width, height: height });
  const previous = activeModule;
  activeModule = null;
  setActive(previous);
  requestAnimationFrame(function () { markReady(stage); });
}

function markReady(stage) {
  if (stage.classList.contains('is-init')) return;
  stage.classList.add('orbit-ready');
}

function scheduleLayout() {
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(layout);
}

function setCardFromEvent(event) {
  const card = event.target.closest ? event.target.closest('.orbit-card') : null;
  if (card) setActive(card.dataset.module);
}

function initOrbit(stage) {
  cleanupOrbit();
  currentStage = stage;
  resizeHandler = scheduleLayout;
  window.addEventListener('resize', resizeHandler, { passive: true });
  observer = new ResizeObserver(scheduleLayout);
  observer.observe(stage);
  stage.addEventListener('pointerover', setCardFromEvent);
  stage.addEventListener('focusin', setCardFromEvent);
  stage.addEventListener('pointerout', function (event) {
    const card = event.target.closest ? event.target.closest('.orbit-card') : null;
    if (!card) return;
    const next = event.relatedTarget;
    if (next && card.contains(next)) return;
    clearActive();
  });
  stage.addEventListener('focusout', function (event) {
    const card = event.target.closest ? event.target.closest('.orbit-card') : null;
    if (!card) return;
    if (event.relatedTarget && card.contains(event.relatedTarget)) return;
    clearActive();
  });
  scheduleLayout();
}

function cleanupOrbit() {
  if (observer) { observer.disconnect(); observer = null; }
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  if (layoutFrame) { cancelAnimationFrame(layoutFrame); layoutFrame = 0; }
  currentStage = null;
  activeModule = null;
}

export { initOrbit, cleanupOrbit };
