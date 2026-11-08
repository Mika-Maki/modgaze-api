#!/usr/bin/env node
/**
 * Offline importer for router-preparetion.md, Node ESM, no dependencies.
 * Run: node scripts/import-preparation.mjs [--source PATH] [--output PATH] [--force]
 * Without --source, it reads ./router-preparetion.md, then ../router-preparetion.md.
 * Only the output file and its private parent directory are written.
 *
 * Import limitations:
 * - This is the preparation document's schema, not a general Markdown/YAML importer.
 * - Local declarations are not remote capabilities, availability or key validation.
 * - Explicit capacity beats adapter fallback; conflicting explicit capacities use
 *   the minimum. Input modalities use a conservative intersection. All original
 *   declarations remain in sourceMetadata; conflicts are reported by ordinal only.
 * - Missing output/input/reasoning metadata stays null, not invented. DSH custom
 *   capacity fallback is 262144/32768, as documented in section 2.2.
 * - AstrBot context=0 stays unresolved (null) unless another declaration supplies
 *   capacity; profile-dependent 128000/1050000 fallbacks are not guessed.
 * - Native DeepSeek effort names are known but their full wire mapping is not
 *   present. availableReasoningEfforts is retained; reasoningEfforts stays null.
 * - Session overrides, credentials references, retry policy and live state are
 *   not installed. Original provider compatibility is retained as metadata only.
 * - group.routes contains only routes shared by ALL models. model.routes adds
 *   known model-specific routes; shallow override is therefore safe and never
 *   grants a model an undocumented protocol. URLs and keys are never logged.
 */
import { readFile, mkdir, lstat, chmod, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = 'router-preparetion.md';
const SOURCE_CANDIDATES = [resolve(ROOT, SOURCE_FILE), resolve(ROOT, '..', SOURCE_FILE)];
const PROTOCOLS = new Map([
  ['openai-completions', 'chat'], ['openai_chat_completion', 'chat'],
  ['responses', 'responses'], ['openai-responses', 'responses'],
  ['openai_responses', 'responses'], ['anthropic-messages', 'messages'],
  ['anthropic_messages', 'messages'],
]);
class ImportError extends Error {
  constructor(code, report = []) { super(code); this.code = code; this.report = report; }
}
function fail(code, report) { throw new ImportError(code, report); }
function json(text) { try { return JSON.parse(text); } catch { fail('invalid-source-json'); } }
function object(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function positive(x) { return Number.isSafeInteger(x) && x > 0; }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function section(text, number) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('### ' + number + ' '));
  if (start < 0) fail('missing-source-section');
  let end = start + 1;
  while (end < lines.length && !/^#{1,3} /.test(lines[end])) end++;
  return { text: lines.slice(start + 1, end).join('\n'), line: start + 2 };
}
function jsonSection(text, number) {
  const s = section(text, number);
  const blocks = [...s.text.matchAll(/\x60{3}json\s*\n([\s\S]*?)\n\x60{3}/g)];
  if (blocks.length !== 1) fail('invalid-source-json-block-count');
  return json(blocks[0][1]);
}
function providers(text, number, system) {
  const s = section(text, number);
  const result = new Map();
  let current;
  for (const [index, line] of s.text.split('\n').entries()) {
    const heading = line.match(/^#### (.+)$/);
    if (heading) {
      if (result.has(heading[1])) fail('duplicate-provider');
      current = { id: heading[1], system, line: s.line + index };
      result.set(current.id, current);
    }
    const field = line.match(/^- (baseurl|apikey|apikey 列表|协议): \x60(.*)\x60$/);
    if (current && field) {
      if (Object.hasOwn(current, field[1])) fail('duplicate-provider-field');
      current[field[1]] = field[2];
    }
  }
  for (const p of result.values()) {
    p.keys = p.apikey !== undefined ? [p.apikey] : json(p['apikey 列表'] ?? 'null');
    if (!Array.isArray(p.keys) || !p.keys.length || p.keys.some(k => typeof k !== 'string' || !k.trim())) fail('missing-api-key');
    route(p['协议'], p.baseurl);
  }
  if (!result.size) fail('empty-provider-section');
  return result;
}
function route(protocol, baseURL) {
  const name = PROTOCOLS.get(protocol);
  if (!name) fail('unknown-protocol');
  try {
    const u = new URL(baseURL);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail('invalid-base-url');
  } catch { fail('invalid-base-url'); }
  return [name, { baseURL, auth: name === 'messages' ? 'x-api-key' : 'bearer' }];
}
function modelRecord(p, raw, system, line, native = false) {
  const id = system === 'AstrBot' ? raw.model : raw.id;
  if (typeof id !== 'string' || !id.trim()) fail('missing-model-id');
  const astr = system === 'AstrBot';
  const context = astr ? raw.max_context_tokens : raw.contextWindow;
  const output = raw.maxOutputTokens ?? raw.maxTokens;
  const modalities = astr ? raw.modalities : raw.input;
  if (modalities !== undefined && (!Array.isArray(modalities) || modalities.some(x => typeof x !== 'string'))) fail('invalid-input-modalities');
  const contextFallback = !astr && !native && context === undefined;
  const outputFallback = !astr && !native && output === undefined;
  if (context !== undefined && !(positive(context) || astr && context === 0)) fail('invalid-context-capacity');
  if (output !== undefined && !positive(output)) fail('invalid-output-capacity');
  if (raw.reasoningEfforts !== undefined && raw.reasoningEfforts !== null && !object(raw.reasoningEfforts)) fail('invalid-reasoning-mapping');
  const [protocol, endpoint] = route(raw.api ?? raw.type ?? p['协议'], raw.baseURL ?? raw.api_base ?? p.baseurl);
  return {
    id, protocol, endpoint,
    contextWindow: positive(context) ? context : contextFallback ? 262144 : null,
    maxOutputTokens: positive(output) ? output : outputFallback ? 32768 : null,
    input: modalities ? modalities.filter(x => x !== 'tool_use') : null,
    reasoningEfforts: Object.hasOwn(raw, 'reasoningEfforts') ? raw.reasoningEfforts : null,
    reasoningDeclared: Object.hasOwn(raw, 'reasoningEfforts'),
    contextFallback, outputFallback,
    source: {
      system, provider: p.id, sectionLine: line, declaration: raw,
      provenance: {
        contextWindow: contextFallback ? 'documented-dsh-adapter-fallback' : context === 0 ? 'astrbot-auto-unresolved-profile-dependent' : context === undefined ? 'undeclared' : native ? 'documented-native-adapter-default' : 'explicit-local-declaration',
        maxOutputTokens: outputFallback ? 'documented-dsh-adapter-fallback' : output === undefined ? 'undeclared' : native ? 'documented-native-adapter-default' : 'explicit-local-declaration',
        input: modalities ? 'explicit-local-declaration' : 'undeclared',
        reasoningEfforts: Object.hasOwn(raw, 'reasoningEfforts') ? 'original-mapping-preserved' : 'undeclared-not-disabled',
      },
      ...(p.compat ? { providerCompat: p.compat } : {}),
    },
  };
}
export function buildConfig(text) {
  const dsh = providers(text, '2.1', 'DSH');
  const astr = providers(text, '3.1', 'AstrBot');
  const declarations = jsonSection(text, '2.3');
  const astrModels = jsonSection(text, '3.4');
  if (!object(declarations) || !Array.isArray(astrModels)) fail('invalid-model-section');
  const entries = [];
  const add = (p, raw, system, line, native = false) => {
    if (!p) fail('unknown-model-provider');
    for (const key of new Set(p.keys)) entries.push({ key, record: modelRecord(p, raw, system, line, native) });
  };
  for (const [id, declaration] of Object.entries(declarations)) {
    const p = dsh.get(id);
    if (!p || !object(declaration) || !Array.isArray(declaration.models) || !declaration.models.length) fail('invalid-dsh-provider');
    if (declaration.baseURL !== undefined && declaration.baseURL !== p.baseurl) fail('inconsistent-provider-url');
    if (declaration.api !== undefined && PROTOCOLS.get(declaration.api) !== PROTOCOLS.get(p['协议'])) fail('inconsistent-provider-protocol');
    p.compat = declaration.compat;
    for (const raw of declaration.models) add(p, raw, 'DSH', section(text, '2.3').line);
  }
  // Native providers are absent from the JSON block; read their documented table.
  for (const [id, p] of dsh) {
    if (Object.hasOwn(declarations, id)) continue;
    const table = section(text, '2.2');
    let count = 0;
    for (const [offset, line] of table.text.split('\n').entries()) {
      const cells = line.split('|').slice(1, -1).map(x => x.trim().replace(/^\x60|\x60$/g, ''));
      if (cells[0] !== id) continue;
      const raw = { id: cells[1], contextWindow: Number(cells[2]), maxTokens: Number(cells[3]), availableReasoningEfforts: cells[4].split(',').map(x => x.trim()), nativeThinkingNote: cells[5] };
      add(p, raw, 'DSH', table.line + offset, true);
      count++;
    }
    if (!count) fail('provider-without-models');
  }
  for (const raw of astrModels) add(astr.get(raw.provider_source_id), raw, 'AstrBot', section(text, '3.4').line);
  for (const p of astr.values()) if (!astrModels.some(m => m.provider_source_id === p.id)) fail('provider-without-models');
  const grouped = new Map();
  for (const { key, record } of entries) {
    if (!grouped.has(key)) grouped.set(key, new Map());
    const models = grouped.get(key);
    if (!models.has(record.id)) models.set(record.id, []);
    models.get(record.id).push(record);
  }
  const ambiguities = [];
  const groups = [];
  for (const [key, sourceModels] of grouped) {
    const groupIndex = groups.length + 1;
    const group = { id: 'group-' + String(groupIndex).padStart(3, '0'), apiKeys: [key], routes: {}, models: [] };
    for (const [id, records] of sourceModels) {
      const modelIndex = group.models.length + 1;
      const report = (field, resolution, fatal = false) => ambiguities.push({ group: groupIndex, model: modelIndex, field, resolution, fatal });
      const routes = {};
      for (const r of records) {
        if (routes[r.protocol] && !same(routes[r.protocol], r.endpoint)) report('route.' + r.protocol, 'same-key-model-protocol-multiple-baseURLs', true);
        else routes[r.protocol] = r.endpoint;
      }
      function capacity(field, fallbackField) {
        const known = records.filter(r => positive(r[field]));
        const explicit = known.filter(r => !r[fallbackField]);
        const chosen = explicit.length ? explicit : known;
        const values = [...new Set(known.map(r => r[field]))];
        if (values.length > 1) report(field, 'explicit-before-fallback-then-minimum');
        return { value: chosen.length ? Math.min(...chosen.map(r => r[field])) : null, provenance: !chosen.length ? 'unknown-see-sourceMetadata' : explicit.length ? 'explicit-local-minimum' : 'documented-dsh-adapter-fallback' };
      }
      const context = capacity('contextWindow', 'contextFallback');
      const output = capacity('maxOutputTokens', 'outputFallback');
      const inputs = records.filter(r => r.input !== null).map(r => r.input);
      const input = inputs.length ? [...new Set(inputs[0])].filter(x => inputs.every(v => v.includes(x))) : null;
      if (inputs.some(v => !same([...v].sort(), [...inputs[0]].sort()))) report('input', 'intersection-originals-retained');
      const mappings = records.filter(r => r.reasoningDeclared);
      if (mappings.some(r => !same(r.reasoningEfforts, mappings[0].reasoningEfforts))) report('reasoningEfforts', 'incompatible-original-mappings', true);
      const nativeEfforts = records.find(r => r.source.declaration.availableReasoningEfforts)?.source.declaration.availableReasoningEfforts;
      group.models.push({
        id, contextWindow: context.value, maxOutputTokens: output.value, input,
        reasoningEfforts: mappings.length ? mappings[0].reasoningEfforts : null,
        ...(nativeEfforts ? { availableReasoningEfforts: nativeEfforts } : {}),
        metadataSource: 'router-preparation-local-declarations',
        provenance: { contextWindow: context.provenance, maxOutputTokens: output.provenance, input: inputs.length ? 'local-declarations-intersection' : 'undeclared', reasoningEfforts: mappings.length ? 'original-mapping-preserved' : 'undeclared-not-disabled' },
        sourceMetadata: records.map(r => r.source), routes,
      });
    }
    for (const protocol of ['chat', 'responses', 'messages']) {
      const endpoints = group.models.map(m => m.routes[protocol]);
      if (endpoints.length && endpoints.every(e => e && same(e, endpoints[0]))) {
        group.routes[protocol] = endpoints[0];
        for (const m of group.models) delete m.routes[protocol];
      } else if (endpoints.filter(Boolean).length > 1 && new Set(endpoints.filter(Boolean).map(e => e.baseURL)).size > 1) {
        ambiguities.push({ group: groupIndex, field: 'route.' + protocol, resolution: 'model-specific-routes', fatal: false });
      }
    }
    for (const m of group.models) if (!Object.keys(m.routes).length) delete m.routes;
    groups.push(group);
  }
  if (ambiguities.some(a => a.fatal)) fail('unresolved-ambiguity', ambiguities);
  return { config: { host: '127.0.0.1', port: 8787, groups }, ambiguities, sourceModels: entries.length };
}
export async function writePrivate(output, content, force = false) {
  const parent = dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('unsafe-output-directory');
  // Refuse existing targets before changing any permissions.
  try {
    const s = await lstat(output);
    if (!force) fail('output-exists-use-force');
    if (!s.isFile() || s.isSymbolicLink()) fail('unsafe-output-file');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await chmod(parent, 0o700);
  const target = force ? resolve(parent, '.import-' + randomUUID() + '.tmp') : output;
  let handle;
  let created = false;
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (force) await rename(target, output);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(target).catch(() => {});
    throw error;
  }
}
async function readSource(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') fail('source-not-found');
    if (error.code === 'EACCES' || error.code === 'EPERM') fail('source-unreadable');
    fail('source-io-failed');
  }
}

async function readDefaultSource() {
  for (const candidate of SOURCE_CANDIDATES) {
    try { return await readFile(candidate, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code === 'EACCES' || error.code === 'EPERM') fail('source-unreadable');
      fail('source-io-failed');
    }
  }
  fail('source-not-found');
}

export async function main(argv = process.argv.slice(2)) {
  let source = null;
  let output = resolve(ROOT, 'config/local.json');
  let force = false;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) fail('duplicate-option');
    seen.add(arg);
    if (arg === '--force') force = true;
    else if (arg === '--source' || arg === '--output') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('missing-option-value');
      const path = resolve(argv[++i]);
      if (arg === '--source') source = path; else output = path;
    } else fail('unknown-option');
  }
  if (source === output) fail('source-output-must-differ');
  const { config, ambiguities } = buildConfig(source === null ? await readDefaultSource() : await readSource(source));
  await writePrivate(output, JSON.stringify(config, null, 2) + '\n', force);
  console.log(JSON.stringify({ groups: config.groups.length, models: config.groups.reduce((sum, g) => sum + g.models.length, 0), ambiguities }));
}
const HINTS = new Map([
  ['source-not-found', 'place ' + SOURCE_FILE + ' in the project root or its parent, or pass --source PATH'],
  ['source-unreadable', 'the source document is not readable; check its owner and mode (0600 expected)'],
  ['output-exists-use-force', 'the output already exists; back it up and rerun with: npm run import:preparation -- --force'],
  ['output-permission-denied', 'the output path is not writable; check the parent directory mode'],
]);
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never print native errors: their messages may include source text or paths.
    const code = error instanceof ImportError ? error.code
      : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'output-permission-denied'
        : error?.code === 'ENOSPC' ? 'output-no-space'
          : 'import-io-failed';
    const hint = HINTS.get(code);
    console.error(JSON.stringify({ groups: 0, models: 0, ambiguities: [{ code }, ...(error instanceof ImportError ? error.report : [])], ...(hint ? { hint } : {}) }));
    process.exitCode = 1;
  });
}
