import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const req = JSON.parse(line);
  let result;

  if (req.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', serverInfo: { name: 'test', version: '1.0' }, capabilities: { tools: {}, resources: {}, prompts: {} } };
  } else if (req.method === 'tools/list') {
    result = { tools: [{ name: 'test_tool', inputSchema: {} }] };
  } else if (req.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'ok' }] };
  } else if (req.method === 'resources/list') {
    result = { resources: [] };
  } else if (req.method === 'prompts/list') {
    result = { prompts: [] };
  } else {
    result = { error: 'unknown method' };
  }

  const response = JSON.stringify({ jsonrpc: '2.0', id: req.id, result });
  console.log(response);
});