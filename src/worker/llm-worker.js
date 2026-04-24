// ── LLM Worker for Offloading Heavy Computation ──
// Runs in a Dedicated Web Worker. Handles: token counting, summarization, tool result compaction.

'use strict';

const CHAR_TOKEN_RATIO = 3.5;

function countTokens(text) {
  if (typeof text !== 'string' || !text.length) return { count: 0, characters: 0, ratio: CHAR_TOKEN_RATIO };
  const len = text.length;
  const wsTokens = text.split(/\s+/).filter(Boolean).length;
  const punctTokens = (text.match(/[^\w\s]/g) || []).length;
  const lineBreaks = (text.match(/\n/g) || []).length;
  const count = Math.ceil(wsTokens * 1.3 + punctTokens * 0.5 + lineBreaks * 0.3);
  return { count, characters: len, ratio: +(len / (count || 1)).toFixed(2) };
}

function compactToolResult(raw, maxChars) {
  const limit = maxChars || 4000;
  const str = String(raw || '');
  if (str.length <= limit) return { compacted: false, result: str };
  const head = Math.ceil(limit * 0.6);
  const tail = Math.floor(limit * 0.3);
  const sep = `\n... [compacted: ${str.length - head - tail} chars omitted] ...\n`;
  return { compacted: true, result: str.slice(0, head) + sep + str.slice(-tail) };
}

function summarizeMessages(messages, maxChars) {
  const limit = maxChars || 2000;
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const m of messages) {
    const role = String(m.role || 'unknown');
    const content = String(m.content || '').slice(0, 200);
    parts.push(`[${role}] ${content}`);
  }
  let summary = parts.join('\n');
  if (summary.length > limit) summary = summary.slice(0, limit) + '\n[summary truncated]';
  return summary;
}

self.onmessage = function(event) {
  const { taskId, type, payload, options } = event.data || {};

  try {
    let result;
    switch (type) {
      case 'count':
        result = typeof payload === 'string' ? countTokens(payload) : 0;
        break;
      case 'compact':
        result = compactToolResult(payload, options?.maxChars);
        break;
      case 'summarize':
        result = summarizeMessages(payload, options?.maxChars);
        break;
      default:
        self.postMessage({ type: 'error', taskId, error: `Unknown task type: ${type}` });
        return;
    }
    self.postMessage({ type: 'result', taskId, result });
  } catch (err) {
    self.postMessage({ type: 'error', taskId, error: String(err?.message || err) });
  }
};