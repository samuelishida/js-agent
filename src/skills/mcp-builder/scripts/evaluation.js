#!/usr/bin/env node
/**
 * MCP Server Evaluation Harness
 *
 * Evaluates MCP servers by running test questions against them using Claude.
 *
 * Port of evaluation.py → Node.js
 *
 * Usage:
 *   node evaluation.js -t stdio -c python -a my_server.py eval.xml
 *   node evaluation.js -t sse -u https://example.com/mcp eval.xml
 *   node evaluation.js -t http -u https://example.com/mcp -m claude-3-5-sonnet-20241022 eval.xml
 */

const fs = require('fs');
const path = require('path');
const { parseStringPromise } = require('xml2js');
const Anthropic = require('@anthropic-ai/sdk');
const { createConnection } = require('./connections.js');

// ── Evaluation prompt ─────────────────────────────────────────────────────────

const EVALUATION_PROMPT = `You are an AI assistant with access to tools.

When given a task, you MUST:
1. Use the available tools to complete the task
2. Provide summary of each step in your approach, wrapped in <summary> tags
3. Provide feedback on the tools provided, wrapped in <feedback> tags
4. Provide your final response, wrapped in <response> tags

Summary Requirements:
- In your <summary> tags, you must explain:
  - The steps you took to complete the task
  - Which tools you used, in what order, and why
  - The inputs you provided to each tool
  - The outputs you received from each tool
  - A summary for how you arrived at the response

Feedback Requirements:
- In your <feedback> tags, provide constructive feedback on the tools:
  - Comment on tool names: Are they clear and descriptive?
  - Comment on input parameters: Are they well-documented? Are required vs optional parameters clear?
  - Comment on descriptions: Do they accurately describe what the tool does?
  - Comment on any errors encountered during tool usage
  - Identify specific areas for improvement and explain WHY they would help
  - Be specific and actionable in your suggestions

Response Requirements:
- Your response should be concise and directly address what was asked
- Always wrap your final response in <response> tags
- If you cannot solve the task return <response>NOT_FOUND</response>
- For numeric responses, provide just the number
- For IDs, provide just the ID
- For names or text, provide the exact text requested
- Your response should go last`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractXmlContent(text, tag) {
  const pattern = new RegExp(`<${tag}>(.*?)</${tag}>`, 'gs');
  const matches = [];
  let m;
  while ((m = pattern.exec(text)) !== null) matches.push(m[1]);
  return matches.length > 0 ? matches[matches.length - 1].trim() : null;
}

async function parseEvaluationFile(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const result = await parseStringPromise(xml, { explicitArray: false });
  const qaPairs = [];
  const pairs = result?.evaluation?.qa_pair || [];
  const arr = Array.isArray(pairs) ? pairs : [pairs];
  for (const pair of arr) {
    if (pair.question && pair.answer) {
      qaPairs.push({
        question: (pair.question || '').trim(),
        answer: (pair.answer || '').trim(),
      });
    }
  }
  return qaPairs;
}

// ── Agent loop ────────────────────────────────────────────────────────────────

async function agentLoop(client, model, question, tools, connection) {
  const messages = [{ role: 'user', content: question }];
  let response = await client.messages.create({ model, max_tokens: 4096, system: EVALUATION_PROMPT, messages, tools });
  messages.push({ role: 'assistant', content: response.content });

  const toolMetrics = {};

  while (response.stop_reason === 'tool_use') {
    const toolUse = response.content.find(b => b.type === 'tool_use');
    const toolName = toolUse.name;
    const toolInput = toolUse.input;

    const start = Date.now();
    let toolResponse;
    try {
      const result = await connection.callTool(toolName, toolInput);
      toolResponse = typeof result === 'object' ? JSON.stringify(result) : String(result);
    } catch (e) {
      toolResponse = `Error executing tool ${toolName}: ${e.message}\n${e.stack}`;
    }
    const duration = (Date.now() - start) / 1000;

    if (!toolMetrics[toolName]) toolMetrics[toolName] = { count: 0, durations: [] };
    toolMetrics[toolName].count++;
    toolMetrics[toolName].durations.push(duration);

    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResponse }],
    });

    response = await client.messages.create({ model, max_tokens: 4096, system: EVALUATION_PROMPT, messages, tools });
    messages.push({ role: 'assistant', content: response.content });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  return [textBlock?.text || null, toolMetrics];
}

// ── Single task evaluation ────────────────────────────────────────────────────

async function evaluateSingleTask(client, model, qaPair, tools, connection, taskIndex) {
  const start = Date.now();
  console.log(`Task ${taskIndex + 1}: Running task with question: ${qaPair.question}`);
  const [responseText, toolMetrics] = await agentLoop(client, model, qaPair.question, tools, connection);

  const responseValue = extractXmlContent(responseText, 'response');
  const summary = extractXmlContent(responseText, 'summary');
  const feedback = extractXmlContent(responseText, 'feedback');
  const durationSeconds = (Date.now() - start) / 1000;

  return {
    question: qaPair.question,
    expected: qaPair.answer,
    actual: responseValue,
    score: responseValue === qaPair.answer ? 1 : 0,
    total_duration: durationSeconds,
    tool_calls: toolMetrics,
    num_tool_calls: Object.values(toolMetrics).reduce((s, m) => s + m.durations.length, 0),
    summary,
    feedback,
  };
}

// ── Report generation ────────────────────────────────────────────────────────

const REPORT_HEADER = `
# Evaluation Report

## Summary

- **Accuracy**: {correct}/{total} ({accuracy}%)
- **Average Task Duration**: {averageDurationS}s
- **Average Tool Calls per Task**: {averageToolCalls}
- **Total Tool Calls**: {totalToolCalls}

---
`;

const TASK_TEMPLATE = `
### Task {taskNum}

**Question**: {question}
**Ground Truth Answer**: \`{expectedAnswer}\`
**Actual Answer**: \`{actualAnswer}\`
**Correct**: {correctIndicator}
**Duration**: {totalDuration}s
**Tool Calls**: {toolCalls}

**Summary**
{summary}

**Feedback**
{feedback}

---
`;

function generateReport(results) {
  const correct = results.filter(r => r.score).length;
  const total = results.length;
  const accuracy = total > 0 ? ((correct / total) * 100).toFixed(1) : '0.0';
  const avgDuration = total > 0 ? (results.reduce((s, r) => s + r.total_duration, 0) / total).toFixed(2) : '0.00';
  const avgToolCalls = total > 0 ? (results.reduce((s, r) => s + r.num_tool_calls, 0) / total).toFixed(2) : '0.00';
  const totalToolCalls = results.reduce((s, r) => s + r.num_tool_calls, 0);

  let report = REPORT_HEADER
    .replace('{correct}', correct)
    .replace('{total}', total)
    .replace('{accuracy}', accuracy)
    .replace('{averageDurationS}', avgDuration)
    .replace('{averageToolCalls}', avgToolCalls)
    .replace('{totalToolCalls}', totalToolCalls);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    report += TASK_TEMPLATE
      .replace('{taskNum}', i + 1)
      .replace('{question}', r.question)
      .replace('{expectedAnswer}', r.expected)
      .replace('{actualAnswer}', r.actual || 'N/A')
      .replace('{correctIndicator}', r.score ? '✅' : '❌')
      .replace('{totalDuration}', r.total_duration.toFixed(2))
      .replace('{toolCalls}', JSON.stringify(r.tool_calls, null, 2))
      .replace('{summary}', r.summary || 'N/A')
      .replace('{feedback}', r.feedback || 'N/A');
  }

  return report;
}

// ── CLI argument parsing ──────────────────────────────────────────────────────

function parseHeaders(headerList) {
  const headers = {};
  if (!headerList) return headers;
  for (const h of headerList) {
    const idx = h.indexOf(':');
    if (idx > 0) {
      headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    } else {
      console.warn(`Warning: Ignoring malformed header: ${h}`);
    }
  }
  return headers;
}

function parseEnvVars(envList) {
  const env = {};
  if (!envList) return env;
  for (const v of envList) {
    const idx = v.indexOf('=');
    if (idx > 0) {
      env[v.slice(0, idx).trim()] = v.slice(idx + 1).trim();
    } else {
      console.warn(`Warning: Ignoring malformed env var: ${v}`);
    }
  }
  return env;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let transport = 'stdio';
  let command = null;
  let cmdArgs = [];
  let envVars = {};
  let url = null;
  let headers = {};
  let model = 'claude-3-7-sonnet-20250219';
  let outputFile = null;
  let evalFile = null;

  // Simple arg parsing
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-t': case '--transport': transport = args[++i]; break;
      case '-c': case '--command': command = args[++i]; break;
      case '-a': case '--args': cmdArgs = (args[++i] || '').split(' '); break;
      case '-e': case '--env': envVars = parseEnvVars((args[++i] || '').split(',')); break;
      case '-u': case '--url': url = args[++i]; break;
      case '-H': case '--header': headers = parseHeaders((args[++i] || '').split(',')); break;
      case '-m': case '--model': model = args[++i]; break;
      case '-o': case '--output': outputFile = args[++i]; break;
      default:
        if (!args[i].startsWith('-') && !evalFile) evalFile = args[i];
        break;
    }
  }

  if (!evalFile) {
    console.error('Error: Evaluation XML file is required');
    process.exit(1);
  }
  if (!fs.existsSync(evalFile)) {
    console.error(`Error: Evaluation file not found: ${evalFile}`);
    process.exit(1);
  }

  let connection;
  try {
    connection = createConnection({ transport, command, args: cmdArgs, env: envVars, url, headers });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  console.log(`🔗 Connecting to MCP server via ${transport}...`);
  console.log('⚠️  Note: MCP SDK connection requires @modelcontextprotocol/sdk');

  const qaPairs = await parseEvaluationFile(evalFile);
  console.log(`📋 Loaded ${qaPairs.length} evaluation tasks`);

  const report = generateReport(qaPairs.map((qa, i) => ({
    question: qa.question,
    expected: qa.answer,
    actual: 'N/A (SDK not connected)',
    score: 0,
    total_duration: 0,
    tool_calls: {},
    num_tool_calls: 0,
    summary: null,
    feedback: null,
  })));

  if (outputFile) {
    fs.writeFileSync(outputFile, report);
    console.log(`\n✅ Report saved to ${outputFile}`);
  } else {
    console.log('\n' + report);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});