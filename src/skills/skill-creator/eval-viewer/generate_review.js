#!/usr/bin/env node
/**
 * Generate and serve a review page for eval results.
 *
 * Reads the workspace directory, discovers runs (directories with outputs/),
 * embeds all output data into a self-contained HTML page, and serves it via
 * a tiny HTTP server. Feedback auto-saves to feedback.json in the workspace.
 *
 * Usage:
 *     node generate_review.js <workspace-path> [--port PORT] [--skill-name NAME]
 *     node generate_review.js <workspace-path> --previous-feedback /path/to/old/feedback.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const METADATA_FILES = new Set(['transcript.md', 'user_notes.md', 'metrics.json']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.py', '.js', '.ts', '.tsx', '.jsx',
  '.yaml', '.yml', '.xml', '.html', '.css', '.sh', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.sql', '.r', '.toml',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const overrides = {
    '.svg': 'image/svg+xml',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return overrides[ext] || { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream';
}

function findRuns(workspace) {
  const runs = [];
  _findRunsRecursive(workspace, workspace, runs);
  runs.sort((a, b) => (a.eval_id ?? Infinity) - (b.eval_id ?? Infinity) || a.id - b.id);
  return runs;
}

function _findRunsRecursive(root, current, runs) {
  if (!fs.statSync(current).isDirectory()) return;

  const outputsDir = path.join(current, 'outputs');
  if (fs.existsSync(outputsDir) && fs.statSync(outputsDir).isDirectory()) {
    const run = buildRun(root, current);
    if (run) runs.push(run);
    return;
  }

  const skip = new Set(['node_modules', '.git', '__pycache__', 'skill', 'inputs']);
  for (const child of fs.readdirSync(current).sort()) {
    const childPath = path.join(current, child);
    if (fs.statSync(childPath).isDirectory() && !skip.has(child)) {
      _findRunsRecursive(root, childPath, runs);
    }
  }
}

function buildRun(root, runDir) {
  let prompt = '';
  let evalId = null;

  for (const candidate of [path.join(runDir, 'eval_metadata.json'), path.join(path.dirname(runDir), 'eval_metadata.json')]) {
    if (fs.existsSync(candidate)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        prompt = metadata.prompt || '';
        evalId = metadata.eval_id;
        if (prompt) break;
      } catch { /* ignore */ }
    }
  }

  const outputsDir = path.join(runDir, 'outputs');
  const outputs = [];
  if (fs.existsSync(outputsDir)) {
    for (const name of fs.readdirSync(outputsDir).sort()) {
      const filePath = path.join(outputsDir, name);
      if (!fs.statSync(filePath).isFile()) continue;
      if (METADATA_FILES.has(name)) continue;

      const ext = path.extname(name).toLowerCase();
      const entry = { name, path: path.relative(root, filePath).replace(/\\/g, '/') };

      if (TEXT_EXTENSIONS.has(ext)) {
        try { entry.content = fs.readFileSync(filePath, 'utf-8'); } catch { entry.content = '[Error reading file]'; }
        entry.type = 'text';
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        try { entry.content = fs.readFileSync(filePath).toString('base64'); } catch { entry.content = ''; }
        entry.type = 'image';
        entry.mime = getMimeType(filePath);
      } else {
        entry.type = 'binary';
        entry.size = fs.statSync(filePath).size;
      }
      outputs.push(entry);
    }
  }

  let grading = null;
  const gradingFile = path.join(runDir, 'grading.json');
  if (fs.existsSync(gradingFile)) {
    try { grading = JSON.parse(fs.readFileSync(gradingFile, 'utf-8')); } catch { /* ignore */ }
  }

  const runName = path.basename(runDir);
  const match = runName.match(/run-(\d+)/);
  const id = match ? parseInt(match[1], 10) : 0;

  const configDir = path.dirname(runDir);
  const config = path.basename(configDir);
  const evalDir = path.dirname(configDir);
  const evalMatch = path.basename(evalDir).match(/eval-(\d+)/);
  if (evalId === null && evalMatch) evalId = parseInt(evalMatch[1], 10);

  return { id, eval_id: evalId, config, name: runName, path: path.relative(root, runDir).replace(/\\/g, '/'), prompt, outputs, grading };
}

function generateHtml(runs, skillName = '', previousFeedback = null) {
  const runsJson = JSON.stringify(runs);
  const previousFeedbackJson = previousFeedback ? JSON.stringify(previousFeedback) : 'null';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${skillName ? skillName + ' — ' : ''}Eval Review</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 1.5rem; margin-bottom: 1rem; }
  .run { background: white; border-radius: 8px; margin-bottom: 1rem; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .run-header { padding: 12px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; }
  .run-header:hover { background: #f9f9f9; }
  .run-body { padding: 16px; display: none; }
  .run.open .run-body { display: block; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
  .badge-pass { background: #dcfce7; color: #166534; }
  .badge-fail { background: #fce7f3; color: #9d174d; }
  .badge-config { background: #e0e7ff; color: #3730a3; }
  .output { margin: 8px 0; }
  .output pre { background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; max-height: 400px; overflow-y: auto; }
  .output img { max-width: 100%; border-radius: 4px; }
  .feedback { margin-top: 12px; }
  .feedback textarea { width: 100%; min-height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-family: inherit; }
  .feedback button { margin-top: 8px; padding: 8px 16px; background: #4f46e5; color: white; border: none; border-radius: 4px; cursor: pointer; }
  .feedback button:hover { background: #4338ca; }
  .grading { margin: 8px 0; padding: 8px; background: #f0fdf4; border-radius: 4px; }
  .grading-fail { background: #fef2f2; }
  .stats { display: flex; gap: 16px; margin-bottom: 1rem; }
  .stat { background: white; padding: 12px 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .stat-value { font-size: 1.5rem; font-weight: 700; }
  .stat-label { font-size: 0.75rem; color: #666; text-transform: uppercase; }
</style>
</head>
<body>
<div class="container">
  <h1>${skillName ? skillName + ' — ' : ''}Eval Review</h1>
  <div class="stats" id="stats"></div>
  <div id="runs"></div>
</div>
<script>
const runs = ${runsJson};
const previousFeedback = ${previousFeedbackJson};

// Stats
const total = runs.length;
const passed = runs.filter(r => r.grading?.summary?.pass_rate >= 0.5).length;
const failed = total - passed;
document.getElementById('stats').innerHTML = \`
  <div class="stat"><div class="stat-value">\${total}</div><div class="stat-label">Total Runs</div></div>
  <div class="stat"><div class="stat-value" style="color:#16a34a">\${passed}</div><div class="stat-label">Passed</div></div>
  <div class="stat"><div class="stat-value" style="color:#dc2626">\${failed}</div><div class="stat-label">Failed</div></div>
\`;

// Render runs
const container = document.getElementById('runs');
runs.forEach((run, idx) => {
  const passRate = run.grading?.summary?.pass_rate ?? null;
  const badge = passRate !== null
    ? (passRate >= 0.5 ? '<span class="badge badge-pass">PASS</span>' : '<span class="badge badge-fail">FAIL</span>')
    : '';
  const configBadge = '<span class="badge badge-config">' + run.config + '</span>';

  const div = document.createElement('div');
  div.className = 'run';
  div.innerHTML = \`
    <div class="run-header" onclick="this.parentElement.classList.toggle('open')">
      <span>\${configBadge} \${badge} Eval \${run.eval_id ?? '?'} / Run \${run.id} — \${run.name}</span>
      <span>\${passRate !== null ? (passRate * 100).toFixed(0) + '%' : ''}</span>
    </div>
    <div class="run-body">
      \${run.prompt ? '<p><strong>Prompt:</strong> ' + run.prompt.slice(0, 200) + '</p>' : ''}
      \${run.outputs.map(o => {
        if (o.type === 'text') return '<div class="output"><strong>' + o.name + '</strong><pre>' + o.content.replace(/</g, '&lt;') + '</pre></div>';
        if (o.type === 'image') return '<div class="output"><strong>' + o.name + '</strong><img src="data:' + o.mime + ';base64,' + o.content + '"></div>';
        return '<div class="output"><strong>' + o.name + '</strong> (' + o.size + ' bytes)</div>';
      }).join('')}
      \${run.grading ? '<div class="grading ' + (passRate >= 0.5 ? '' : 'grading-fail') + '"><strong>Grading:</strong> ' + (passRate * 100).toFixed(0) + '% pass rate (' + run.grading.summary.passed + '/' + run.grading.summary.total + ')</div>' : ''}
      <div class="feedback">
        <textarea id="feedback-\${idx}" placeholder="Enter feedback for this run...">\${(previousFeedback && previousFeedback[run.path]) || ''}</textarea>
        <button onclick="saveFeedback(\${idx}, '\${run.path}')">Save Feedback</button>
      </div>
    </div>
  \`;
  container.appendChild(div);
});

function saveFeedback(idx, runPath) {
  const text = document.getElementById('feedback-' + idx).value;
  fetch('/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: runPath, feedback: text })
  }).then(r => r.ok ? alert('Feedback saved!') : alert('Error saving feedback'));
}
</script>
</body>
</html>`;
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  let workspacePath = null;
  let port = 8765;
  let skillName = '';
  let previousFeedbackPath = null;
  let outputPath = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port': port = parseInt(args[++i], 10); break;
      case '--skill-name': skillName = args[++i]; break;
      case '--previous-feedback': previousFeedbackPath = args[++i]; break;
      case '-o': case '--output': outputPath = args[++i]; break;
      default:
        if (!workspacePath && !args[i].startsWith('-')) workspacePath = args[i];
        break;
    }
  }

  if (!workspacePath) {
    console.error('Usage: node generate_review.js <workspace-path> [--port PORT] [--skill-name NAME] [-o output.html]');
    process.exit(1);
  }

  workspacePath = path.resolve(workspacePath);
  const runs = findRuns(workspacePath);

  let previousFeedback = null;
  if (previousFeedbackPath && fs.existsSync(previousFeedbackPath)) {
    try { previousFeedback = JSON.parse(fs.readFileSync(previousFeedbackPath, 'utf-8')); } catch { /* ignore */ }
  }

  const html = generateHtml(runs, skillName, previousFeedback);

  if (outputPath) {
    fs.writeFileSync(outputPath, html);
    console.log(`Report written to ${outputPath}`);
  } else {
    // Serve via HTTP
    const feedback = {};

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/feedback') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            feedback[data.path] = data.feedback;
            const feedbackPath = path.join(workspacePath, 'feedback.json');
            fs.writeFileSync(feedbackPath, JSON.stringify(feedback, null, 2));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
          }
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      }
    });

    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      console.log(`Eval review server running at ${url}`);
      console.log(`Found ${runs.length} runs in ${workspacePath}`);
      try { require('child_process').execSync(`open "${url}"`, { stdio: 'ignore' }); } catch { /* ignore */ }
    });
  }
}

module.exports = { generateHtml, findRuns, buildRun };