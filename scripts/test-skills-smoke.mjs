#!/usr/bin/env node
/**
 * Skills smoke tests — validates that all skill scripts are syntactically
 * correct and that key exports exist.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { execSync } from 'child_process';
import assert from 'assert';

const SKILLS_DIR = 'src/skills';

// ─── Helpers ────────────────────────────────────────────────────────────────
const results = [];

async function group(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function getJsFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...getJsFiles(full));
    } else if (extname(entry) === '.js') {
      results.push(full.replace(/\\/g, '/'));
    }
  }
  return results;
}

function getPyFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...getPyFiles(full));
    } else if (extname(entry) === '.py') {
      results.push(full.replace(/\\/g, '/'));
    }
  }
  return results;
}

// ─── Group A: Skill script syntax ───────────────────────────────────────────
await group('Skill scripts syntax check', async () => {
  const skillDirs = readdirSync(SKILLS_DIR).filter(d =>
    statSync(join(SKILLS_DIR, d)).isDirectory()
  );

  let totalChecked = 0;
  for (const skill of skillDirs) {
    const scriptsDir = join(SKILLS_DIR, skill, 'scripts');
    const examplesDir = join(SKILLS_DIR, skill, 'examples');
    const evalDir = join(SKILLS_DIR, skill, 'eval-viewer');

    for (const dir of [scriptsDir, examplesDir, evalDir]) {
      if (!existsSync(dir)) continue;
      const jsFiles = getJsFiles(dir);
      for (const file of jsFiles) {
        try {
          execSync(`node --check "${file}"`, { stdio: 'pipe' });
          totalChecked++;
        } catch (e) {
          assert.fail(`${file}: syntax error — ${e.stderr?.toString().trim() || e.message}`);
        }
      }
    }
  }
  assert.ok(totalChecked > 0, 'Expected at least one JS skill script to check');
  console.log(`  ✓ ${totalChecked} skill scripts passed syntax check`);
});

// ─── Group B: SKILL.md frontmatter ─────────────────────────────────────────
await group('SKILL.md frontmatter validation', async () => {
  const skillDirs = readdirSync(SKILLS_DIR).filter(d =>
    statSync(join(SKILLS_DIR, d)).isDirectory()
  );

  let totalChecked = 0;
  for (const skill of skillDirs) {
    const skillMd = join(SKILLS_DIR, skill, 'SKILL.md');
    if (!existsSync(skillMd)) continue;

    const content = readFileSync(skillMd, 'utf-8').replace(/^\uFEFF/, '');
    assert.ok(content.startsWith('---'), `${skill}/SKILL.md: missing opening frontmatter`);
    const closeIdx = content.indexOf('---', 3);
    assert.ok(closeIdx > 0, `${skill}/SKILL.md: missing closing frontmatter`);

    const frontmatter = content.slice(3, closeIdx);
    assert.ok(frontmatter.includes('name:'), `${skill}/SKILL.md: missing 'name' in frontmatter`);
    assert.ok(frontmatter.includes('description:'), `${skill}/SKILL.md: missing 'description' in frontmatter`);
    totalChecked++;
  }
  assert.ok(totalChecked > 0, 'Expected at least one SKILL.md to validate');
  console.log(`  ✓ ${totalChecked} SKILL.md files validated`);
});

// ─── Group C: No Python remnants in converted skills ────────────────────────
await group('No Python remnants in converted skills', async () => {
  const convertedSkills = ['skill-creator', 'webapp-testing', 'mcp-builder'];

  for (const skill of convertedSkills) {
    const skillDir = join(SKILLS_DIR, skill);
    if (!existsSync(skillDir)) continue;

    const pyFiles = getPyFiles(skillDir);
    assert.strictEqual(pyFiles.length, 0, `${skill}: found Python files that should have been converted: ${pyFiles.join(', ')}`);
  }
  console.log('  ✓ No Python files found in converted skill directories');
});

// ─── Group D: Key exports exist ─────────────────────────────────────────────
await group('Key skill-creator exports exist', async () => {
  // Check that the main exports exist in the JS files
  const utilsPath = join(SKILLS_DIR, 'skill-creator', 'scripts', 'utils.js');
  assert.ok(existsSync(utilsPath), 'utils.js should exist');
  const utilsContent = readFileSync(utilsPath, 'utf-8');
  assert.ok(utilsContent.includes('module.exports'), 'utils.js should have module.exports');
  assert.ok(utilsContent.includes('parseSkillMd'), 'utils.js should export parseSkillMd');

  const validatePath = join(SKILLS_DIR, 'skill-creator', 'scripts', 'quick_validate.js');
  assert.ok(existsSync(validatePath), 'quick_validate.js should exist');
  const validateContent = readFileSync(validatePath, 'utf-8');
  assert.ok(validateContent.includes('validateSkill'), 'quick_validate.js should export validateSkill');

  const packagePath = join(SKILLS_DIR, 'skill-creator', 'scripts', 'package_skill.js');
  assert.ok(existsSync(packagePath), 'package_skill.js should exist');
  const packageContent = readFileSync(packagePath, 'utf-8');
  assert.ok(packageContent.includes('packageSkill'), 'package_skill.js should export packageSkill');

  console.log('  ✓ All key exports verified');
});

// ─── Summary ────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n──────────────────────────────────────────`);
if (failed > 0) {
  console.log(`${passed} passed, ${failed} FAILED:`);
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
} else {
  console.log(`All ${passed} skills smoke tests passed!`);
}