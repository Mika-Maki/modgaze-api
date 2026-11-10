// This router has no ownership ledger for provider files, vector stores,
// containers or saved prompts. Fail closed at protocol authority slots only;
// user text, metadata, function arguments and tool JSON schemas remain opaque.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const referenceNames = new Set(['fileid', 'fileids', 'vectorstoreid', 'vectorstoreids', 'containerid']);
const present = value => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
function denied() {
  throw Object.assign(new Error('Untracked upstream resource references are not supported; use inline content instead'), {
    status: 403, type: 'resource_reference_error',
  });
}
function rejectFields(value) {
  if (!object(value)) return;
  for (const [name, field] of Object.entries(value)) if (referenceNames.has(normalized(name)) && present(field)) denied();
}
function container(value) {
  if (!present(value)) return;
  // Only a newly allocated, empty auto container is safe. Existing container
  // identifiers (including object forms) cannot establish ownership.
  if (!object(value) || value.type !== 'auto') denied();
  rejectFields(value);
  if (present(value.id)) denied();
}
function contentBlocks(content, protocol) {
  const pending = Array.isArray(content) ? [...content] : [];
  while (pending.length) {
    const block = pending.pop();
    if (!object(block)) continue;
    rejectFields(block);
    if (object(block.file)) rejectFields(block.file);
    if (object(block.source)) {
      rejectFields(block.source);
      if (block.source.type === 'file') denied();
      if (block.source.type === 'content' && Array.isArray(block.source.content)) for (const child of block.source.content) pending.push(child);
    }
    if (protocol === 'responses' && block.type === 'item_reference') {
      throw Object.assign(new Error('Untracked item references are not supported'), { status: 400, type: 'invalid_request_error' });
    }
    if (block.type === 'container_upload' || (block.type === 'file' && present(block.id))) denied();
    // Recurse only into message or tool-result content, never tool_use.input,
    // function_call.arguments, metadata, citations or arbitrary output JSON.
    if ((!block.type || ['message', 'tool_result', 'function_call_output', 'document'].includes(block.type)) && Array.isArray(block.content)) for (const child of block.content) pending.push(child);
    if (block.type === 'function_call_output' && Array.isArray(block.output)) for (const child of block.output) pending.push(child);
  }
}
export function validateResourceReferences(parsed, protocol) {
  rejectFields(parsed);
  if (present(parsed.container)) container(parsed.container);
  if (object(parsed.prompt) && present(parsed.prompt.id)) denied();
  if (protocol === 'responses') contentBlocks(parsed.input, protocol);
  else if (Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (!object(message)) continue;
      contentBlocks(message.content, protocol);
      // Chat audio.id is also a stored provider object, not inline audio bytes.
      if (object(message.audio) && present(message.audio.id)) denied();
    }
    if (protocol === 'messages') contentBlocks(parsed.system, protocol);
  }
  if (Array.isArray(parsed.tools)) for (const tool of parsed.tools) {
    if (!object(tool)) continue;
    // Function/custom tools and their schemas are user data, not built-in
    // provider capabilities. Only inspect the built-in resource-bearing tools.
    if (tool.type === 'file_search') rejectFields(tool);
    if (tool.type === 'code_interpreter') {
      rejectFields(tool);
      // Omitted container is ambiguous across provider implementations.
      if (!present(tool.container)) denied();
      container(tool.container);
    }
  }
}
export function rejectResourceQuery(name) {
  const key = normalized(name);
  if (/fileids?|vectorstoreids?|container|promptid/.test(key)) denied();
}
