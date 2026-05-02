#!/usr/bin/env node
/**
 * Skill Packager - Creates a distributable .skill file of a skill folder
 *
 * Usage:
 *     node scripts/package_skill.js <path/to/skill-folder> [output-directory]
 *
 * Example:
 *     node scripts/package_skill.js skills/public/my-skill
 *     node scripts/package_skill.js skills/public/my-skill ./dist
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { validateSkill } = require('./quick_validate');

// Patterns to exclude when packaging skills.
const EXCLUDE_DIRS = new Set(['__pycache__', 'node_modules']);
const EXCLUDE_GLOBS = ['*.pyc'];
const EXCLUDE_FILES = new Set(['.DS_Store']);
// Directories excluded only at the skill root (not when nested deeper).
const ROOT_EXCLUDE_DIRS = new Set(['evals']);

/**
 * Check if a relative path should be excluded from packaging.
 * @param {string} relPath - Relative path from skill folder parent
 * @returns {boolean}
 */
function shouldExclude(relPath) {
  const parts = relPath.split(path.sep);
  if (parts.some(p => EXCLUDE_DIRS.has(p))) return true;
  // relPath is relative to skill_path.parent, so parts[0] is the skill
  // folder name and parts[1] (if present) is the first subdir.
  if (parts.length > 1 && ROOT_EXCLUDE_DIRS.has(parts[1])) return true;
  const name = path.basename(relPath);
  if (EXCLUDE_FILES.has(name)) return true;
  return EXCLUDE_GLOBS.some(glob => {
    const regex = new RegExp('^' + glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    return regex.test(name);
  });
}

/**
 * Package a skill folder into a .skill file (zip format).
 * @param {string} skillPath - Path to the skill folder
 * @param {string} [outputDir] - Optional output directory
 * @returns {string|null} - Path to created .skill file, or null on error
 */
function packageSkill(skillPath, outputDir) {
  skillPath = path.resolve(skillPath);

  // Validate skill folder exists
  if (!fs.existsSync(skillPath)) {
    console.log(`❌ Error: Skill folder not found: ${skillPath}`);
    return null;
  }

  const stat = fs.statSync(skillPath);
  if (!stat.isDirectory()) {
    console.log(`❌ Error: Path is not a directory: ${skillPath}`);
    return null;
  }

  // Validate SKILL.md exists
  const skillMd = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    console.log(`❌ Error: SKILL.md not found in ${skillPath}`);
    return null;
  }

  // Run validation before packaging
  console.log('🔍 Validating skill...');
  const [valid, message] = validateSkill(skillPath);
  if (!valid) {
    console.log(`❌ Validation failed: ${message}`);
    console.log('   Please fix the validation errors before packaging.');
    return null;
  }
  console.log(`✅ ${message}\n`);

  // Determine output location
  const skillName = path.basename(skillPath);
  let outputPath;
  if (outputDir) {
    outputPath = path.resolve(outputDir);
    fs.mkdirSync(outputPath, { recursive: true });
  } else {
    outputPath = process.cwd();
  }

  const skillFilename = path.join(outputPath, `${skillName}.skill`);

  // Collect files to include
  const files = [];
  function walkDir(dir, baseDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, fullPath);
      if (entry.isDirectory()) {
        walkDir(fullPath, baseDir);
      } else {
        if (!shouldExclude(relPath)) {
          files.push({ fullPath, relPath });
        } else {
          console.log(`  Skipped: ${relPath}`);
        }
      }
    }
  }
  walkDir(skillPath, path.dirname(skillPath));

  // Create the .skill file using the zip command or archiver
  // Use Node.js built-in approach with a simple zip implementation
  try {
    // Try using the system zip command first
    const tmpDir = path.join(outputPath, `.tmp-${skillName}-pack`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Copy files to temp directory maintaining structure
    const skillDirName = path.basename(skillPath);
    for (const file of files) {
      const destPath = path.join(tmpDir, file.relPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(file.fullPath, destPath);
      console.log(`  Added: ${file.relPath}`);
    }

    // Create zip using system command
    try {
      execSync(`cd "${tmpDir}" && zip -r "${skillFilename}" .`, { stdio: 'pipe' });
    } catch {
      // Fallback: use PowerShell Compress-Archive on Windows
      try {
        execSync(`powershell -Command "Compress-Archive -Path '${tmpDir}\\*' -DestinationPath '${skillFilename}' -Force"`, { stdio: 'pipe' });
      } catch (e2) {
        console.log(`❌ Error creating .skill file: ${e2.message}`);
        return null;
      }
    }

    // Cleanup temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(`\n✅ Successfully packaged skill to: ${skillFilename}`);
    return skillFilename;
  } catch (e) {
    console.log(`❌ Error creating .skill file: ${e.message}`);
    return null;
  }
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: node scripts/package_skill.js <path/to/skill-folder> [output-directory]');
    console.log('\nExample:');
    console.log('  node scripts/package_skill.js skills/public/my-skill');
    console.log('  node scripts/package_skill.js skills/public/my-skill ./dist');
    process.exit(1);
  }

  const skillPath = args[0];
  const outputDir = args[1] || null;

  console.log(`📦 Packaging skill: ${skillPath}`);
  if (outputDir) {
    console.log(`   Output directory: ${outputDir}`);
  }
  console.log();

  const result = packageSkill(skillPath, outputDir);
  process.exit(result ? 0 : 1);
}

module.exports = { packageSkill, shouldExclude };