// scripts/test-loop-bugs.mjs
// Verify loop regression fixes: Gemini thinking tags, repair context, streaming cleanup.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// ── 1. Gemini thinking tags ───────────────────────────────────────────────
{
  const code = await readFile('src/app/llm/provider-gemini.js', 'utf8');
  assert.ok(code.includes("\\u003cthink\\u003e\\n"), 'Gemini thinking uses \\u003cthink\\u003e tag');
  assert.ok(!code.includes("\\u003ctool_call\\u003e\\n" + "thinkingText"), 'Gemini does not wrap thinking in \\u003ctool_call\\u003e');
  console.log('  gemini thinking tags: OK');
}

// ── 2. Round-controller passes local messages/userMessage to repair ───────
{
  const code = await readFile('src/app/agent/round-controller.js', 'utf8');
  assert.ok(code.includes('completeToolCallArgs(candidateCall, { messages, userMessage })'), 'repair receives local messages and userMessage');
  assert.ok(!code.includes("completeToolCallArgs(candidateCall, { messages: window.messages, userMessage: '' })"), 'repair does not use window.messages');
  console.log('  repair context: OK');
}

// ── 3. Streaming callback restored in finally ─────────────────────────────
{
  const code = await readFile('src/app/agent/round-controller.js', 'utf8');
  assert.ok(code.includes('try {'), 'streaming wrapped in try');
  assert.ok(code.includes('} finally {'), 'streaming wrapped in finally');
  assert.ok(code.includes('window.AgentLLMUtils.streamingCallback = prevStreamingCb'), 'callback restored in finally');
  console.log('  streaming cleanup: OK');
}

// ── 4. Attachment wiring ─────────────────────────────────────────────────
{
  const agentCode = await readFile('src/app/agent/agent.js', 'utf8');
  assert.ok(agentCode.includes('function agentLoop(userMessage, attachments = [])'), 'agentLoop accepts attachments');
  assert.ok(agentCode.includes('buildAttachmentContextBlock(attachments)'), 'agentLoop builds attachment block');

  const sessionCode = await readFile('src/app/agent/session-lifecycle.js', 'utf8');
  assert.ok(sessionCode.includes('window.pendingAttachments'), 'sendMessage reads pendingAttachments');

  const html = await readFile('index.html', 'utf8');
  assert.ok(html.includes('id="file-input"'), 'index.html has file input');
  assert.ok(html.includes('id="attachment-chips"'), 'index.html has attachment chips');

  const openRouter = await readFile('src/app/llm/provider-openrouter.js', 'utf8');
  assert.ok(openRouter.includes('image_url'), 'OpenRouter supports image_url');

  const gemini = await readFile('src/app/llm/provider-gemini.js', 'utf8');
  assert.ok(gemini.includes('inlineData'), 'Gemini supports inlineData');

  const llmUtils = await readFile('src/app/llm/llm-utils.js', 'utf8');
  assert.ok(llmUtils.includes('image_url'), 'llm-utils supports image_url');

  const toolExecutor = await readFile('src/tools/tool-executor.js', 'utf8');
  assert.ok(toolExecutor.includes('createAttachmentRuntime'), 'tool-executor loads attachment runtime');
  assert.ok(toolExecutor.includes('attachmentList'), 'tool-executor exports attachmentList');

  console.log('  attachment wiring: OK');
}

console.log('All loop bug + attachment tests passed');
process.exit(0);
