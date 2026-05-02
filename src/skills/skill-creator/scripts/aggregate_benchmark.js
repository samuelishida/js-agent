#!/usr/bin/env node
/**
 * Aggregate individual run results into benchmark summary statistics.
 *
 * Reads grading.json files from run directories and produces:
 * - run_summary with mean, stddev, min, max for each metric
 * - delta between with_skill and without_skill configurations
 *
 * Usage:
 *     node aggregate_benchmark.js <benchmark_dir> [--skill-name name] [--skill-path path] [-o output]
 */

'use strict';

const fs = require('fs');
const path = require('path');

function calculateStats(values) {
  if (!values || values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0 };
  }
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let stddev = 0;
  if (n > 1) {
    const variance = values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1);
    stddev = Math.sqrt(variance);
  }
  return {
    mean: Math.round(mean * 10000) / 10000,
    stddev: Math.round(stddev * 10000) / 10000,
    min: Math.round(Math.min(...values) * 10000) / 10000,
    max: Math.round(Math.max(...values) * 10000) / 10000,
  };
}

function loadRunResults(benchmarkDir) {
  const runsDir = path.join(benchmarkDir, 'runs');
  let searchDir;
  if (fs.existsSync(runsDir)) {
    searchDir = runsDir;
  } else {
    const entries = fs.readdirSync(benchmarkDir).filter(e => e.startsWith('eval-'));
    if (entries.length > 0) {
      searchDir = benchmarkDir;
    } else {
      console.log(`No eval directories found in ${benchmarkDir} or ${runsDir}`);
      return {};
    }
  }

  const results = {};
  const evalDirs = fs.readdirSync(searchDir).filter(e => e.startsWith('eval-')).sort();

  for (let evalIdx = 0; evalIdx < evalDirs.length; evalIdx++) {
    const evalDirName = evalDirs[evalIdx];
    const evalDir = path.join(searchDir, evalDirName);
    if (!fs.statSync(evalDir).isDirectory()) continue;

    const metadataPath = path.join(evalDir, 'eval_metadata.json');
    let evalId = evalIdx;
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        evalId = metadata.eval_id ?? evalIdx;
      } catch { /* use default */ }
    } else {
      const match = evalDirName.match(/eval-(\d+)/);
      if (match) evalId = parseInt(match[1], 10);
    }

    const configDirs = fs.readdirSync(evalDir).filter(d => {
      const full = path.join(evalDir, d);
      return fs.statSync(full).isDirectory() && fs.readdirSync(full).some(e => e.startsWith('run-'));
    });

    for (const config of configDirs.sort()) {
      if (!results[config]) results[config] = [];
      const configDir = path.join(evalDir, config);
      const runDirs = fs.readdirSync(configDir).filter(d => d.startsWith('run-')).sort();

      for (const runDirName of runDirs) {
        const runDir = path.join(configDir, runDirName);
        const runNumber = parseInt(runDirName.split('-')[1], 10);
        const gradingFile = path.join(runDir, 'grading.json');

        if (!fs.existsSync(gradingFile)) {
          console.log(`Warning: grading.json not found in ${runDir}`);
          continue;
        }

        let grading;
        try {
          grading = JSON.parse(fs.readFileSync(gradingFile, 'utf-8'));
        } catch (e) {
          console.log(`Warning: Invalid JSON in ${gradingFile}: ${e.message}`);
          continue;
        }

        const result = {
          eval_id: evalId,
          run_number: runNumber,
          pass_rate: grading?.summary?.pass_rate ?? 0,
          passed: grading?.summary?.passed ?? 0,
          failed: grading?.summary?.failed ?? 0,
          total: grading?.summary?.total ?? 0,
        };

        const timing = grading?.timing ?? {};
        result.time_seconds = timing.total_duration_seconds ?? 0;
        const timingFile = path.join(runDir, 'timing.json');
        if (result.time_seconds === 0 && fs.existsSync(timingFile)) {
          try {
            const timingData = JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
            result.time_seconds = timingData.total_duration_seconds ?? 0;
            result.tokens = timingData.total_tokens ?? 0;
          } catch { /* ignore */ }
        }

        const metrics = grading?.execution_metrics ?? {};
        result.tool_calls = metrics.total_tool_calls ?? 0;
        if (!result.tokens) result.tokens = metrics.output_chars ?? 0;
        result.errors = metrics.errors_encountered ?? 0;

        result.expectations = grading?.expectations ?? [];
        result.notes = [
          ...(grading?.user_notes_summary?.uncertainties ?? []),
          ...(grading?.user_notes_summary?.needs_review ?? []),
          ...(grading?.user_notes_summary?.workarounds ?? []),
        ];

        results[config].push(result);
      }
    }
  }

  return results;
}

function aggregateResults(results) {
  const runSummary = {};
  const configs = Object.keys(results);

  for (const config of configs) {
    const runs = results[config] || [];
    if (runs.length === 0) {
      runSummary[config] = {
        pass_rate: { mean: 0, stddev: 0, min: 0, max: 0 },
        time_seconds: { mean: 0, stddev: 0, min: 0, max: 0 },
        tokens: { mean: 0, stddev: 0, min: 0, max: 0 },
      };
      continue;
    }

    const passRates = runs.map(r => r.pass_rate);
    const times = runs.map(r => r.time_seconds);
    const tokens = runs.map(r => r.tokens || 0);

    runSummary[config] = {
      pass_rate: calculateStats(passRates),
      time_seconds: calculateStats(times),
      tokens: calculateStats(tokens),
    };
  }

  // Calculate delta
  const primary = runSummary[configs[0]] || {};
  const baseline = runSummary[configs[1]] || {};
  const deltaPassRate = (primary.pass_rate?.mean ?? 0) - (baseline.pass_rate?.mean ?? 0);
  const deltaTime = (primary.time_seconds?.mean ?? 0) - (baseline.time_seconds?.mean ?? 0);
  const deltaTokens = (primary.tokens?.mean ?? 0) - (baseline.tokens?.mean ?? 0);

  runSummary.delta = {
    pass_rate: `${deltaPassRate >= 0 ? '+' : ''}${deltaPassRate.toFixed(2)}`,
    time_seconds: `${deltaTime >= 0 ? '+' : ''}${deltaTime.toFixed(1)}s`,
    tokens: `${deltaTokens >= 0 ? '+' : ''}${deltaTokens.toFixed(0)}`,
  };

  return runSummary;
}

function generateBenchmark(benchmarkDir, skillName = '', skillPath = '') {
  const results = loadRunResults(benchmarkDir);
  const runSummary = aggregateResults(results);

  const runs = [];
  for (const config of Object.keys(results)) {
    for (const result of results[config]) {
      runs.push({
        eval_id: result.eval_id,
        configuration: config,
        run_number: result.run_number,
        result: {
          pass_rate: result.pass_rate,
          passed: result.passed,
          failed: result.failed,
          total: result.total,
          time_seconds: result.time_seconds,
          tokens: result.tokens || 0,
          tool_calls: result.tool_calls || 0,
          errors: result.errors || 0,
        },
        expectations: result.expectations,
        notes: result.notes,
      });
    }
  }

  const evalIds = [...new Set(Object.values(results).flat().map(r => r.eval_id))].sort((a, b) => a - b);

  return {
    metadata: {
      skill_name: skillName || '<skill-name>',
      skill_path: skillPath || '<path/to/skill>',
      executor_model: '<model-name>',
      analyzer_model: '<model-name>',
      timestamp: new Date().toISOString(),
      evals_run: evalIds,
      runs_per_configuration: 3,
    },
    runs,
    run_summary: runSummary,
    notes: [],
  };
}

function generateMarkdown(benchmark) {
  const metadata = benchmark.metadata;
  const runSummary = benchmark.run_summary;
  const configs = Object.keys(runSummary).filter(k => k !== 'delta');
  const configA = configs[0] || 'config_a';
  const configB = configs[1] || 'config_b';
  const labelA = configA.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const labelB = configB.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const delta = runSummary.delta || {};

  const lines = [
    `# Skill Benchmark: ${metadata.skill_name}`,
    '',
    `**Model**: ${metadata.executor_model}`,
    `**Date**: ${metadata.timestamp}`,
    `**Evals**: ${metadata.evals_run.join(', ')} (${metadata.runs_per_configuration} runs each per configuration)`,
    '',
    '## Summary',
    '',
    `| Metric | ${labelA} | ${labelB} | Delta |`,
    '|--------|------------|---------------|-------|',
  ];

  const aSummary = runSummary[configA] || {};
  const bSummary = runSummary[configB] || {};

  const aPr = aSummary.pass_rate || {};
  const bPr = bSummary.pass_rate || {};
  lines.push(`| Pass Rate | ${(aPr.mean * 100 || 0).toFixed(0)}% ± ${(aPr.stddev * 100 || 0).toFixed(0)}% | ${(bPr.mean * 100 || 0).toFixed(0)}% ± ${(bPr.stddev * 100 || 0).toFixed(0)}% | ${delta.pass_rate || '—'} |`);

  const aTime = aSummary.time_seconds || {};
  const bTime = bSummary.time_seconds || {};
  lines.push(`| Time | ${(aTime.mean || 0).toFixed(1)}s ± ${(aTime.stddev || 0).toFixed(1)}s | ${(bTime.mean || 0).toFixed(1)}s ± ${(bTime.stddev || 0).toFixed(1)}s | ${delta.time_seconds || '—'} |`);

  const aTokens = aSummary.tokens || {};
  const bTokens = bSummary.tokens || {};
  lines.push(`| Tokens | ${(aTokens.mean || 0).toFixed(0)} ± ${(aTokens.stddev || 0).toFixed(0)} | ${(bTokens.mean || 0).toFixed(0)} ± ${(bTokens.stddev || 0).toFixed(0)} | ${delta.tokens || '—'} |`);

  if (benchmark.notes && benchmark.notes.length > 0) {
    lines.push('', '## Notes', '');
    for (const note of benchmark.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join('\n');
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  let benchmarkDir = null;
  let skillName = '';
  let skillPath = '';
  let outputPath = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--skill-name': skillName = args[++i]; break;
      case '--skill-path': skillPath = args[++i]; break;
      case '-o': case '--output': outputPath = args[++i]; break;
      default:
        if (!benchmarkDir && !args[i].startsWith('-')) benchmarkDir = args[i];
        break;
    }
  }

  if (!benchmarkDir) {
    console.error('Usage: node aggregate_benchmark.js <benchmark_dir> [--skill-name name] [--skill-path path] [-o output]');
    process.exit(1);
  }

  if (!fs.existsSync(benchmarkDir)) {
    console.log(`Directory not found: ${benchmarkDir}`);
    process.exit(1);
  }

  const benchmark = generateBenchmark(benchmarkDir, skillName, skillPath);

  const outputJson = outputPath || path.join(benchmarkDir, 'benchmark.json');
  const outputMd = outputJson.replace(/\.json$/, '.md');

  fs.writeFileSync(outputJson, JSON.stringify(benchmark, null, 2));
  console.log(`Generated: ${outputJson}`);

  const markdown = generateMarkdown(benchmark);
  fs.writeFileSync(outputMd, markdown);
  console.log(`Generated: ${outputMd}`);

  // Print summary
  const runSummary = benchmark.run_summary;
  const configs = Object.keys(runSummary).filter(k => k !== 'delta');
  const delta = runSummary.delta || {};
  console.log('\nSummary:');
  for (const config of configs) {
    const pr = runSummary[config].pass_rate.mean;
    const label = config.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    console.log(`  ${label}: ${(pr * 100).toFixed(1)}% pass rate`);
  }
  console.log(`  Delta:         ${delta.pass_rate || '—'}`);
}

module.exports = { generateBenchmark, aggregateResults, loadRunResults, calculateStats };