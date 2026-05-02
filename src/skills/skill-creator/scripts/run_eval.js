#!/usr/bin/env node
/**
 * Run trigger evaluation for a skill description.
 *
 * Tests whether a skill's description causes Claude to trigger (read the skill)
 * for a set of queries. Outputs results as JSON.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { parseSkillMd } = require('./utils');

function findProjectRoot() {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.claude'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
}

/**
 * Run a single query and return whether the skill was triggered.
 */
function runSingleQuery(query, skillName, skillDescription, timeout, projectRoot, model = null) {
  const uniqueId = Math.random().toString(36).slice(2, 10);
  const cleanName = `${skillName}-skill-${uniqueId}`;
  const projectCommandsDir = path.join(projectRoot, '.claude', 'commands');
  const commandFile = path.join(projectCommandsDir, `${cleanName}.md`);

  try {
    fs.mkdirSync(projectCommandsDir, { recursive: true });
    const indentedDesc = skillDescription.split('\n').join('\n  ');
    const commandContent = `---\ndescription: |\n  ${indentedDesc}\n---\n\n# ${skillName}\n\nThis skill handles: ${skillDescription}\n`;
    fs.writeFileSync(commandFile, commandContent);

    const cmd = ['claude', '-p', query, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (model) cmd.push('--model', model);

    const env = { ...process.env };
    delete env.CLAUDECODE;

    try {
      const result = execSync(cmd.join(' '), {
        encoding: 'utf-8',
        timeout: (timeout || 30) * 1000,
        cwd: projectRoot,
        env,
        maxBuffer: 50 * 1024 * 1024,
      });

      // Parse stream-json output to detect triggering
      let triggered = false;
      let pendingToolName = null;
      let accumulatedJson = '';

      for (const line of result.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }

        if (event.type === 'stream_event') {
          const se = event.event || {};
          const seType = se.type || '';

          if (seType === 'content_block_start') {
            const cb = se.content_block || {};
            if (cb.type === 'tool_use') {
              const toolName = cb.name || '';
              if (toolName === 'Skill' || toolName === 'Read') {
                pendingToolName = toolName;
                accumulatedJson = '';
              } else {
                return false;
              }
            }
          } else if (seType === 'content_block_delta' && pendingToolName) {
            const delta = se.delta || {};
            if (delta.type === 'input_json_delta') {
              accumulatedJson += delta.partial_json || '';
              if (accumulatedJson.includes(cleanName)) return true;
            }
          } else if (seType === 'content_block_stop' || seType === 'message_stop') {
            if (pendingToolName) return accumulatedJson.includes(cleanName);
            if (seType === 'message_stop') return false;
          }
        } else if (event.type === 'assistant') {
          const message = event.message || {};
          for (const contentItem of message.content || []) {
            if (contentItem.type !== 'tool_use') continue;
            const toolName = contentItem.name || '';
            const toolInput = contentItem.input || {};
            if (toolName === 'Skill' && (toolInput.skill || '').includes(cleanName)) triggered = true;
            else if (toolName === 'Read' && (toolInput.file_path || '').includes(cleanName)) triggered = true;
            return triggered;
          }
        } else if (event.type === 'result') {
          return triggered;
        }
      }

      return triggered;
    } catch (e) {
      return false;
    }
  } finally {
    if (fs.existsSync(commandFile)) {
      try { fs.unlinkSync(commandFile); } catch { /* ignore */ }
    }
  }
}

/**
 * Run the full eval set and return results.
 */
function runEval({
  evalSet,
  skillName,
  description,
  numWorkers = 10,
  timeout = 30,
  projectRoot,
  runsPerQuery = 1,
  triggerThreshold = 0.5,
  model = null,
}) {
  const queryTriggers = {};
  const queryItems = {};

  for (const item of evalSet) {
    const query = item.query;
    queryItems[query] = item;
    if (!queryTriggers[query]) queryTriggers[query] = [];

    for (let runIdx = 0; runIdx < runsPerQuery; runIdx++) {
      try {
        const triggered = runSingleQuery(query, skillName, description, timeout, projectRoot, model);
        queryTriggers[query].push(triggered);
      } catch (e) {
        console.error(`Warning: query failed: ${e.message}`);
        queryTriggers[query].push(false);
      }
    }
  }

  const results = [];
  for (const [query, triggers] of Object.entries(queryTriggers)) {
    const item = queryItems[query];
    const triggerRate = triggers.filter(Boolean).length / triggers.length;
    const shouldTrigger = item.should_trigger;
    const didPass = shouldTrigger ? triggerRate >= triggerThreshold : triggerRate < triggerThreshold;
    results.push({
      query,
      should_trigger: shouldTrigger,
      trigger_rate: triggerRate,
      triggers: triggers.filter(Boolean).length,
      runs: triggers.length,
      pass: didPass,
    });
  }

  const passed = results.filter(r => r.pass).length;
  const total = results.length;

  return {
    skill_name: skillName,
    description,
    results,
    summary: {
      total,
      passed,
      failed: total - passed,
    },
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
  let runsPerQuery = 3;
  let triggerThreshold = 0.5;
  let model = null;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--eval-set': evalSetPath = args[++i]; break;
      case '--skill-path': skillPath = args[++i]; break;
      case '--description': descriptionOverride = args[++i]; break;
      case '--num-workers': numWorkers = parseInt(args[++i], 10); break;
      case '--timeout': timeout = parseInt(args[++i], 10); break;
      case '--runs-per-query': runsPerQuery = parseInt(args[++i], 10); break;
      case '--trigger-threshold': triggerThreshold = parseFloat(args[++i]); break;
      case '--model': model = args[++i]; break;
      case '--verbose': verbose = true; break;
    }
  }

  if (!evalSetPath || !skillPath) {
    console.error('Usage: node run_eval.js --eval-set <path> --skill-path <path> [options]');
    process.exit(1);
  }

  const evalSet = JSON.parse(fs.readFileSync(evalSetPath, 'utf-8'));
  skillPath = path.resolve(skillPath);

  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
    console.error(`Error: No SKILL.md found at ${skillPath}`);
    process.exit(1);
  }

  const { name, description: originalDescription } = parseSkillMd(skillPath);
  const description = descriptionOverride || originalDescription;
  const projectRoot = findProjectRoot();

  if (verbose) console.error(`Evaluating: ${description}`);

  const output = runEval({
    evalSet,
    skillName: name,
    description,
    numWorkers,
    timeout,
    projectRoot,
    runsPerQuery,
    triggerThreshold,
    model,
  });

  if (verbose) {
    const summary = output.summary;
    console.error(`Results: ${summary.passed}/${summary.total} passed`);
    for (const r of output.results) {
      const status = r.pass ? 'PASS' : 'FAIL';
      console.error(`  [${status}] rate=${r.triggers}/${r.runs} expected=${r.should_trigger}: ${r.query.slice(0, 70)}`);
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

module.exports = { runEval, runSingleQuery, findProjectRoot };