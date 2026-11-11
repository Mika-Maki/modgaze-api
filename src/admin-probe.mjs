import { PROTOCOLS, upstreamURL } from './router.mjs';
import { assertProtocol } from './admin-keys.mjs';
import { groupById, httpError, resolvedGroupById } from './admin-store.mjs';
import { secretRedactor } from './secrets.mjs';

async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        chunks.push(value.subarray(0, Math.max(0, limit - (total - value.byteLength))));
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } catch {}
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

export function createGroupTest({ store }) {
  return async function groupTest(body) {
    const snapshot = await store.readVersioned();
    const target = body.id ? groupById(snapshot.raw, body.id) : null;
    if (!target) throw httpError(400, '缺少分组 ID');
    const resolvedGroup = resolvedGroupById(snapshot.resolved, target.id) ?? target;
    const mode = body.mode === 'generate' ? 'generate' : 'models';
    const requestedProtocol = body.protocol ? assertProtocol(body.protocol) : null;
    const model = body.model ? target.models?.find(item => item.id === body.model) : (target.models?.[0] ?? null);
    if (body.model && !model) throw httpError(404, '分组中不存在该模型：' + body.model);
    const resolvedModel = model ? resolvedGroup.models?.find(item => item.id === model.id) : null;
    const protocols = PROTOCOLS.filter(protocol => (model?.routes?.[protocol] ?? target.routes?.[protocol]));
    const protocol = requestedProtocol ?? protocols[0] ?? null;
    if (!protocol) throw httpError(400, '该模型/分组没有可用协议路由');
    if (!protocols.includes(protocol)) throw httpError(400, '该模型没有 ' + protocol + ' 路由');
    const route = model?.routes?.[protocol] ?? target.routes?.[protocol];
    const resolvedRoute = resolvedModel?.routes?.[protocol] ?? resolvedGroup.routes?.[protocol] ?? route;
    const upstreamKey = resolvedRoute.upstreamApiKey ?? resolvedGroup.upstreamApiKey;
    if (!upstreamKey) throw httpError(400, '未配置上游 Key；此路由只能直传客户端 Key，管理台无法代为测试');
    const authMode = resolvedRoute.auth ?? route.auth ?? (protocol === 'messages' ? 'x-api-key' : 'bearer');
    const headers = { accept: 'application/json' };
    if (authMode === 'x-api-key') headers['x-api-key'] = upstreamKey;
    else headers.authorization = 'Bearer ' + upstreamKey;
    if (protocol === 'messages') headers['anthropic-version'] = '2023-06-01';
    let endpoint;
    let requestInit = { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30000) };
    if (mode === 'models') {
      endpoint = upstreamURL(route.baseURL, '/v1/models');
    } else {
      if (!model) throw httpError(400, '生成测试需要一个模型');
      endpoint = upstreamURL(route.baseURL, protocol === 'chat' ? '/v1/chat/completions' : protocol === 'responses' ? '/v1/responses' : '/v1/messages');
      const modelName = model.upstreamModel ?? model.id;
      const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim().slice(0, 4000) : 'ping';
      const maxTokens = Number.isSafeInteger(body.maxTokens) && body.maxTokens > 0 ? Math.min(body.maxTokens, 128) : 16;
      const payload = protocol === 'chat'
        ? { model: modelName, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false }
        : protocol === 'responses'
          ? { model: modelName, input: prompt, max_output_tokens: maxTokens }
          : { model: modelName, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
      headers['content-type'] = 'application/json';
      requestInit = { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(30000) };
    }
    const credentials = snapshot.resolved.groups.flatMap(group => [
      group.upstreamApiKey, ...(group.apiKeys ?? []), ...(group.virtualApiKeys ?? []),
      ...Object.values(group.routes ?? {}).map(item => item?.upstreamApiKey),
      ...(group.models ?? []).flatMap(item => Object.values(item.routes ?? {}).map(route => route?.upstreamApiKey)),
    ]).filter(value => typeof value === 'string');
    const redact = secretRedactor(credentials);
    const started = Date.now();
    let response;
    try { response = await fetch(endpoint, requestInit); }
    catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      return { ok: false, status: 0, latencyMs: Date.now() - started, error: timedOut ? '请求超时（30s）' : '上游连接失败', protocol, baseURL: route.baseURL, mode };
    }
    const snippet = redact.text(await readLimited(response, 256 * 1024)).slice(0, 800);
    return {
      ok: response.ok, status: response.status, latencyMs: Date.now() - started,
      endpoint: endpoint.pathname + endpoint.search, baseURL: route.baseURL, protocol, mode,
      contentType: response.headers.get('content-type'), snippet,
    };
  };
}

export function createRouterTest({ routerPort }) {
  return async function routerTest(body) {
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key || /\s/.test(key)) throw httpError(400, '请选择或输入一个本地访问 Key');
    const port = routerPort();
    if (!port) throw httpError(503, '路由服务尚未就绪');
    const mode = body.mode === 'generate' ? 'generate' : 'models';
    const protocol = body.protocol ? assertProtocol(body.protocol) : 'chat';
    const base = 'http://127.0.0.1:' + port;
    const headers = { accept: 'application/json', authorization: 'Bearer ' + key };
    let path = '/v1/models';
    let requestInit = { method: 'GET', headers, signal: AbortSignal.timeout(30000) };
    if (mode === 'generate') {
      if (typeof body.model !== 'string' || !body.model) throw httpError(400, '生成测试需要模型 ID');
      const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim().slice(0, 4000) : 'ping';
      const maxTokens = Number.isSafeInteger(body.maxTokens) && body.maxTokens > 0 ? Math.min(body.maxTokens, 128) : 16;
      const payload = protocol === 'chat'
        ? { model: body.model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false }
        : protocol === 'responses'
          ? { model: body.model, input: prompt, max_output_tokens: maxTokens }
          : { model: body.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
      path = protocol === 'chat' ? '/v1/chat/completions' : protocol === 'responses' ? '/v1/responses' : '/v1/messages';
      if (protocol === 'messages') headers['anthropic-version'] = '2023-06-01';
      headers['content-type'] = 'application/json';
      requestInit = { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) };
    }
    const redact = secretRedactor([key]);
    const started = Date.now();
    let response;
    try { response = await fetch(base + path, requestInit); }
    catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      return { ok: false, status: 0, latencyMs: Date.now() - started, error: timedOut ? '请求超时（30s）' : '上游连接失败', mode, protocol };
    }
    const text = redact.text(await readLimited(response, 256 * 1024));
    let models;
    if (mode === 'models' && response.ok) {
      try {
        const parsed = JSON.parse(text);
        models = Array.isArray(parsed.data) ? parsed.data.map(item => item.id).filter(Boolean) : undefined;
      } catch {}
    }
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - started, models, snippet: text.slice(0, 800), mode, protocol, endpoint: base + path };
  };
}
