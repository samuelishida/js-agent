#!/usr/bin/env node
/**
 * Generate an HTML report from run_loop.js output.
 *
 * Takes the JSON output from run_loop.js and generates a visual HTML report
 * showing each description attempt with check/x for each test case.
 * Distinguishes between train and test queries.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateHtml(data, autoRefresh = false, skillName = '') {
  const history = data.history || [];
  const holdout = data.holdout || 0;
  const titlePrefix = skillName ? escapeHtml(skillName + ' — ') : '';

  const trainQueries = [];
  const testQueries = [];
  if (history.length > 0) {
    const first = history[0];
    for (const r of (first.train_results || first.results || [])) {
      trainQueries.push({ query: r.query, should_trigger: r.should_trigger !== undefined ? r.should_trigger : true });
    }
    if (first.test_results) {
      for (const r of first.test_results) {
        testQueries.push({ query: r.query, should_trigger: r.should_trigger !== undefined ? r.should_trigger : true });
      }
    }
  }

  const refreshTag = autoRefresh ? '    <meta http-equiv="refresh" content="5">\n' : '';

  let html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
${refreshTag}    <title>${titlePrefix}Skill Description Optimization</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Lora:wght@400;500&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Lora', Georgia, serif; max-width: 100%; margin: 0 auto; padding: 20px; background: #faf9f5; color: #141413; }
        h1 { font-family: 'Poppins', sans-serif; color: #141413; }
        .explainer { background: white; padding: 15px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #e8e6dc; color: #b0aea5; font-size: 0.875rem; line-height: 1.6; }
        .summary { background: white; padding: 15px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #e8e6dc; }
        .summary p { margin: 5px 0; }
        .best { color: #788c5d; font-weight: bold; }
        .table-container { overflow-x: auto; width: 100%; }
        table { border-collapse: collapse; background: white; border: 1px solid #e8e6dc; border-radius: 6px; font-size: 12px; min-width: 100%; }
        th, td { padding: 8px; text-align: left; border: 1px solid #e8e6dc; white-space: normal; word-wrap: break-word; }
        th { font-family: 'Poppins', sans-serif; background: #141413; color: #faf9f5; font-weight: 500; }
        th.test-col { background: #6a9bcc; }
        th.query-col { min-width: 200px; }
        td.description { font-family: monospace; font-size: 11px; word-wrap: break-word; max-width: 400px; }
        td.result { text-align: center; font-size: 16px; min-width: 40px; }
        td.test-result { background: #f0f6fc; }
        .pass { color: #788c5d; }
        .fail { color: #c44; }
        .rate { font-size: 9px; color: #b0aea5; display: block; }
        tr:hover { background: #faf9f5; }
        .score { display: inline-block; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 11px; }
        .score-good { background: #eef2e8; color: #788c5d; }
        .score-ok { background: #fef3c7; color: #d97706; }
        .score-bad { background: #fceaea; color: #c44; }
        .train-label { color: #b0aea5; font-size: 10px; }
        .test-label { color: #6a9bcc; font-size: 10px; font-weight: bold; }
        .best-row { background: #f5f8f2; }
        th.positive-col { border-bottom: 3px solid #788c5d; }
        th.negative-col { border-bottom: 3px solid #c44; }
        th.test-col.positive-col { border-bottom: 3px solid #788c5d; }
        th.test-col.negative-col { border-bottom: 3px solid #c44; }
        .legend { font-family: 'Poppins', sans-serif; display: flex; gap: 20px; margin-bottom: 10px; font-size: 13px; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 6px; }
        .legend-swatch { width: 16px; height: 16px; border-radius: 3px; display: inline-block; }
        .swatch-positive { background: #141413; border-bottom: 3px solid #788c5d; }
        .swatch-negative { background: #141413; border-bottom: 3px solid #c44; }
        .swatch-test { background: #6a9bcc; }
        .swatch-train { background: #141413; }
    </style>
</head>
<body>
    <h1>${titlePrefix}Skill Description Optimization</h1>
    <div class="explainer">
        <strong>Optimizing your skill's description.</strong> This page updates automatically as Claude tests different versions of your skill's description. Each row is an iteration — a new description attempt. The columns show test queries: green checkmarks mean the skill triggered correctly (or correctly didn't trigger), red crosses mean it got it wrong. The "Train" score shows performance on queries used to improve the description; the "Test" score shows performance on held-out queries the optimizer hasn't seen. When it's done, Claude will apply the best-performing description to your skill.
    </div>
`;

  // Summary section
  const bestTestScore = data.best_test_score;
  const bestTrainScore = data.best_train_score;
  html += `
    <div class="summary">
        <p><strong>Original:</strong> ${escapeHtml(data.original_description || 'N/A')}</p>
        <p class="best"><strong>Best:</strong> ${escapeHtml(data.best_description || 'N/A')}</p>
        <p><strong>Best Score:</strong> ${data.best_score || 'N/A'} ${bestTestScore ? '(test)' : '(train)'}</p>
        <p><strong>Iterations:</strong> ${data.iterations_run || 0} | <strong>Train:</strong> ${data.train_size || '?'} | <strong>Test:</strong> ${data.test_size || '?'}</p>
    </div>
`;

  // Legend
  html += `
    <div class="legend">
        <span style="font-weight:600">Query columns:</span>
        <span class="legend-item"><span class="legend-swatch swatch-positive"></span> Should trigger</span>
        <span class="legend-item"><span class="legend-swatch swatch-negative"></span> Should NOT trigger</span>
        <span class="legend-item"><span class="legend-swatch swatch-train"></span> Train</span>
        <span class="legend-item"><span class="legend-swatch swatch-test"></span> Test</span>
    </div>
`;

  // Table header
  html += `
    <div class="table-container">
    <table>
        <thead>
            <tr>
                <th>Iter</th>
                <th>Train</th>
                <th>Test</th>
                <th class="query-col">Description</th>
`;

  for (const qinfo of trainQueries) {
    const polarity = qinfo.should_trigger ? 'positive-col' : 'negative-col';
    html += `                <th class="${polarity}">${escapeHtml(qinfo.query)}</th>\n`;
  }
  for (const qinfo of testQueries) {
    const polarity = qinfo.should_trigger ? 'positive-col' : 'negative-col';
    html += `                <th class="test-col ${polarity}">${escapeHtml(qinfo.query)}</th>\n`;
  }

  html += `            </tr>
        </thead>
        <tbody>
`;

  // Find best iteration
  let bestIter;
  if (testQueries.length > 0) {
    bestIter = history.reduce((a, b) => (b.test_passed || 0) > (a.test_passed || 0) ? b : a).iteration;
  } else {
    bestIter = history.reduce((a, b) => (b.train_passed || b.passed || 0) > (a.train_passed || a.passed || 0) ? b : a).iteration;
  }

  // Add rows
  for (const h of history) {
    const iteration = h.iteration || '?';
    const trainPassed = h.train_passed ?? h.passed ?? 0;
    const trainTotal = h.train_total ?? h.total ?? 0;
    const testPassed = h.test_passed;
    const testTotal = h.test_total;
    const description = h.description || '';
    const trainResults = h.train_results || h.results || [];
    const testResults = h.test_results || [];

    const trainByQuery = {};
    for (const r of trainResults) trainByQuery[r.query] = r;
    const testByQuery = {};
    for (const r of testResults) testByQuery[r.query] = r;

    function aggregateRuns(results) {
      let correct = 0, total = 0;
      for (const r of results) {
        const runs = r.runs || 0;
        const triggers = r.triggers || 0;
        total += runs;
        if (r.should_trigger !== false) correct += triggers;
        else correct += runs - triggers;
      }
      return [correct, total];
    }

    const [trainCorrect, trainRuns] = aggregateRuns(trainResults);
    const [testCorrect, testRuns] = aggregateRuns(testResults);

    function scoreClass(correct, total) {
      if (total > 0) {
        const ratio = correct / total;
        if (ratio >= 0.8) return 'score-good';
        if (ratio >= 0.5) return 'score-ok';
      }
      return 'score-bad';
    }

    const trainClass = scoreClass(trainCorrect, trainRuns);
    const testClass = scoreClass(testCorrect, testRuns);
    const rowClass = iteration === bestIter ? 'best-row' : '';

    html += `            <tr class="${rowClass}">
                <td>${iteration}</td>
                <td><span class="score ${trainClass}">${trainCorrect}/${trainRuns}</span></td>
                <td><span class="score ${testClass}">${testCorrect}/${testRuns}</span></td>
                <td class="description">${escapeHtml(description)}</td>
`;

    for (const qinfo of trainQueries) {
      const r = trainByQuery[qinfo.query] || {};
      const didPass = r.pass || false;
      const triggers = r.triggers || 0;
      const runs = r.runs || 0;
      const icon = didPass ? '✓' : '✗';
      const cssClass = didPass ? 'pass' : 'fail';
      html += `                <td class="result ${cssClass}">${icon}<span class="rate">${triggers}/${runs}</span></td>\n`;
    }

    for (const qinfo of testQueries) {
      const r = testByQuery[qinfo.query] || {};
      const didPass = r.pass || false;
      const triggers = r.triggers || 0;
      const runs = r.runs || 0;
      const icon = didPass ? '✓' : '✗';
      const cssClass = didPass ? 'pass' : 'fail';
      html += `                <td class="result test-result ${cssClass}">${icon}<span class="rate">${triggers}/${runs}</span></td>\n`;
    }

    html += '            </tr>\n';
  }

  html += `        </tbody>
    </table>
    </div>

</body>
</html>
`;

  return html;
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = null;
  let skillName = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') {
      outputPath = args[++i];
    } else if (args[i] === '--skill-name') {
      skillName = args[++i];
    } else if (!inputPath) {
      inputPath = args[i];
    }
  }

  if (!inputPath) {
    console.error('Usage: node generate_report.js <input.json> [-o output.html] [--skill-name name]');
    process.exit(1);
  }

  let data;
  if (inputPath === '-') {
    data = JSON.parse(fs.readFileSync('/dev/stdin', 'utf-8'));
  } else {
    data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  }

  const htmlOutput = generateHtml(data, false, skillName);

  if (outputPath) {
    fs.writeFileSync(outputPath, htmlOutput);
    console.error(`Report written to ${outputPath}`);
  } else {
    console.log(htmlOutput);
  }
}

module.exports = { generateHtml };