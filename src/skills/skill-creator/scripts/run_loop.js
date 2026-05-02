#!/usr/bin/env node
/**
 * Run the eval + improve loop until all pass or max iterations reached.
 *
 * Combines run_eval.js and improve_description.js in a loop, tracking history
 * and returning the best description found. Supports train/test split to prevent
 * overfitting.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseSkillMd } = require('./utils');
const { improveDescription } = require('./improve_description');

/**
 * Split eval set into train and test sets, stratified by should_trigger.
 */
function splitEvalSet(evalSet, holdout, seed = 42) {
  const random = seededRandom(seed);

  const trigger = evalSet.filter(e => e.should_trigger);
  const noTrigger = evalSet.filter(e => !e.should_trigger);

  // Shuffle each group
  shuffleArray(trigger, random);
  shuffleArray(noTrigger, random);

  const nTriggerTest = Math.max(1, Math.floor(trigger.length * holdout));
  const nNoTriggerTest = Math.max(1, Math.floor(noTrigger.length * holdout));

  const testSet = trigger.slice(0, nTriggerTest).concat(noTrigger.slice(0, nNoTriggerTest));
  const trainSet = trigger.slice(nTriggerTest).concat(noTrigger.slice(nNoTriggerTest));

  return [trainSet, testSet];
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function shuffleArray(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Run a single eval query via claude -p.
 */
function runSingleEval(query, skillName, description, timeout, model) {
  const prompt = `You have access to a skill called "${skillName}" with the following description:\n\n"${description}"\n\nWould you use this skill for the following query? Answer only "yes" or "no".\n\nQuery: ${query}`;

  const cmd = ['claude', '-p', '--output-format', 'text'];
  if (model) cmd.push('--model', model);

  const env = { ...process.env };
  delete env.CLAUDECODE;

  try {
    const result = execSync(cmd.join(' '), {
      input: prompt,
      encoding: 'utf-8',
      timeout: (timeout || 30) * 1000,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
    const answer = result.trim().toLowerCase();
    return answer.includes('yes');
  } catch {
    return false;
  }
}

/**
 * Run eval on a set of queries.
 */
function runEval({ evalSet, skillName, description, runsPerQuery = 3, triggerThreshold = 0.5, timeout = 30, model }) {
  const results = evalSet.map(item => {
    let triggers = 0;
    for (let i = 0; i < runsPerQuery; i++) {
      if (runSingleEval(item.query, skillName, description, timeout, model)) {
        triggers++;
      }
    }
    const triggerRate = triggers / runsPerQuery;
    const pass = item.should_trigger ? triggerRate >= triggerThreshold : triggerRate < triggerThreshold;
    return {
      query: item.query,
      should_trigger: item.should_trigger,
      triggers,
      runs: runsPerQuery,
      pass,
    };
  });

  const passed = results.filter(r => r.pass).length;
  return {
    results,
    summary: {
      passed,
      failed: results.length - passed,
      total: results.length,
    },
  };
}

/**
 * Run the eval + improvement loop.
 */
function runLoop({
  evalSet,
  skillPath,
  descriptionOverride,
  numWorkers = 10,
  timeout = 30,
  maxIterations = 5,
  runsPerQuery = 3,
  triggerThreshold = 0.5,
  holdout = 0.4,
  model,
  verbose = false,
  liveReportPath = null,
  logDir = null,
}) {
  const { name, description: originalDescription, content } = parseSkillMd(skillPath);
  let currentDescription = descriptionOverride || originalDescription;

  let trainSet, testSet;
  if (holdout > 0) {
    [trainSet, testSet] = splitEvalSet(evalSet, holdout);
    if (verbose) console.error(`Split: ${trainSet.length} train, ${testSet.length} test (holdout=${holdout})`);
  } else {
    trainSet = evalSet;
    testSet = [];
  }

  const history = [];
  let exitReason = 'unknown';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (verbose) {
      console.error(`\n${'='.repeat(60)}`);
      console.error(`Iteration ${iteration}/${maxIterations}`);
      console.error(`Description: ${currentDescription}`);
      console.error('='.repeat(60));
    }

    const allQueries = trainSet.concat(testSet);
    const allResults = runEval({
      evalSet: allQueries,
      skillName: name,
      description: currentDescription,
      numWorkers,
      timeout,
      runsPerQuery,
      triggerThreshold,
      model,
    });

    const trainQueriesSet = new Set(trainSet.map(q => q.query));
    const trainResultList = allResults.results.filter(r => trainQueriesSet.has(r.query));
    const testResultList = allResults.results.filter(r => !trainQueriesSet.has(r.query));

    const trainPassed = trainResultList.filter(r => r.pass).length;
    const trainTotal = trainResultList.length;
    const trainSummary = { passed: trainPassed, failed: trainTotal - trainPassed, total: trainTotal };
    const trainResults = { results: trainResultList, summary: trainSummary };

    let testResults = null;
    let testSummary = null;
    if (testSet.length > 0) {
      const testPassed = testResultList.filter(r => r.pass).length;
      const testTotal = testResultList.length;
      testSummary = { passed: testPassed, failed: testTotal - testPassed, total: testTotal };
      testResults = { results: testResultList, summary: testSummary };
    }

    history.push({
      iteration,
      description: currentDescription,
      train_passed: trainSummary.passed,
      train_failed: trainSummary.failed,
      train_total: trainSummary.total,
      train_results: trainResults.results,
      test_passed: testSummary ? testSummary.passed : null,
      test_failed: testSummary ? testSummary.failed : null,
      test_total: testSummary ? testSummary.total : null,
      test_results: testResults ? testResults.results : null,
      passed: trainSummary.passed,
      failed: trainSummary.failed,
      total: trainSummary.total,
      results: trainResults.results,
    });

    if (trainSummary.failed === 0) {
      exitReason = `all_passed (iteration ${iteration})`;
      if (verbose) console.error(`\nAll train queries passed on iteration ${iteration}!`);
      break;
    }

    if (iteration === maxIterations) {
      exitReason = `max_iterations (${maxIterations})`;
      if (verbose) console.error(`\nMax iterations reached (${maxIterations}).`);
      break;
    }

    if (verbose) console.error('\nImproving description...');

    const blindedHistory = history.map(h => {
      const entry = {};
      for (const [k, v] of Object.entries(h)) {
        if (!k.startsWith('test_')) entry[k] = v;
      }
      return entry;
    });

    const newDescription = improveDescription({
      skillName: name,
      skillContent: content,
      currentDescription,
      evalResults: trainResults,
      history: blindedHistory,
      model,
      logDir,
      iteration,
    });

    if (verbose) console.error(`Proposed: ${newDescription}`);
    currentDescription = newDescription;
  }

  let best;
  if (testSet.length > 0) {
    best = history.reduce((a, b) => (b.test_passed || 0) > (a.test_passed || 0) ? b : a);
  } else {
    best = history.reduce((a, b) => b.train_passed > a.train_passed ? b : a);
  }

  const bestScore = testSet.length > 0
    ? `${best.test_passed}/${best.test_total}`
    : `${best.train_passed}/${best.train_total}`;

  if (verbose) {
    console.error(`\nExit reason: ${exitReason}`);
    console.error(`Best score: ${bestScore} (iteration ${best.iteration})`);
  }

  return {
    exit_reason: exitReason,
    original_description: originalDescription,
    best_description: best.description,
    best_score: bestScore,
    best_train_score: `${best.train_passed}/${best.train_total}`,
    best_test_score: testSet.length > 0 ? `${best.test_passed}/${best.test_total}` : null,
    final_description: currentDescription,
    iterations_run: history.length,
    holdout,
    train_size: trainSet.length,
    test_size: testSet.length,
    history,
  };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  let evalSetPath = null;
  let skillPath = null;
  let descriptionOverride = null;
  let numWorkers = 10;
  let timeout = 30;
  let maxIterations = 5;
  let runsPerQuery = 3;
  let triggerThreshold = 0.5;
  let holdout = 0.4;
  let model = null;
  let verbose = false;
  let report = 'auto';
  let resultsDir = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--eval-set': evalSetPath = args[++i]; break;
      case '--skill-path': skillPath = args[++i]; break;
      case '--description': descriptionOverride = args[++i]; break;
      case '--num-workers': numWorkers = parseInt(args[++i], 10); break;
      case '--timeout': timeout = parseInt(args[++i], 10); break;
      case '--max-iterations': maxIterations = parseInt(args[++i], 10); break;
      case '--runs-per-query': runsPerQuery = parseInt(args[++i], 10); break;
      case '--trigger-threshold': triggerThreshold = parseFloat(args[++i]); break;
      case '--holdout': holdout = parseFloat(args[++i]); break;
      case '--model': model = args[++i]; break;
      case '--verbose': verbose = true; break;
      case '--report': report = args[++i]; break;
      case '--results-dir': resultsDir = args[++i]; break;
    }
  }

  if (!evalSetPath || !skillPath || !model) {
    console.error('Usage: node run_loop.js --eval-set <path> --skill-path <path> --model <model> [options]');
    process.exit(1);
  }

  const evalSet = JSON.parse(fs.readFileSync(evalSetPath, 'utf-8'));
  skillPath = path.resolve(skillPath);

  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
    console.error(`Error: No SKILL.md found at ${skillPath}`);
    process.exit(1);
  }

  const output = runLoop({
    evalSet,
    skillPath,
    descriptionOverride,
    numWorkers,
    timeout,
    maxIterations,
    runsPerQuery,
    triggerThreshold,
    holdout,
    model,
    verbose,
  });

  console.log(JSON.stringify(output, null, 2));
}

module.exports = { runLoop, splitEvalSet, runEval };