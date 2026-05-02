#!/usr/bin/env node
/**
 * Quick validation script for skills - minimal version
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ALLOWED_PROPERTIES = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);

/**
 * Basic validation of a skill
 * @param {string} skillPath - Path to the skill directory
 * @returns {[boolean, string]} - [isValid, message]
 */
function validateSkill(skillPath) {
  skillPath = path.resolve(skillPath);

  // Check SKILL.md exists
  const skillMd = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    return [false, 'SKILL.md not found'];
  }

  // Read and validate frontmatter
  const content = fs.readFileSync(skillMd, 'utf-8');
  if (!content.startsWith('---')) {
    return [false, 'No YAML frontmatter found'];
  }

  // Extract frontmatter
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return [false, 'Invalid frontmatter format'];
  }

  const frontmatterText = match[1];

  // Simple YAML parser (no dependency on js-yaml)
  const frontmatter = {};
  let currentKey = null;
  let currentValue = null;
  let inMultiline = false;
  let multilineIndicator = null;

  for (const line of frontmatterText.split('\n')) {
    if (inMultiline) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        if (typeof currentValue === 'string') {
          currentValue += ' ' + line.trim();
        } else {
          currentValue.push(line.trim());
        }
        continue;
      } else {
        frontmatter[currentKey] = currentValue;
        inMultiline = false;
        currentKey = null;
        currentValue = null;
      }
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Handle YAML multiline indicators
    if (['>', '|', '>-', '|-'].includes(value)) {
      currentKey = key;
      currentValue = value === '>' || value === '>-' ? '' : [];
      multilineIndicator = value;
      inMultiline = true;
      continue;
    }

    // Strip quotes
    value = value.replace(/^["']|["']$/g, '');
    frontmatter[key] = value;
  }

  if (inMultiline && currentKey) {
    frontmatter[currentKey] = currentValue;
  }

  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    return [false, 'Frontmatter must be a YAML dictionary'];
  }

  // Check for unexpected properties
  const unexpectedKeys = Object.keys(frontmatter).filter(k => !ALLOWED_PROPERTIES.has(k));
  if (unexpectedKeys.length > 0) {
    return [false, `Unexpected key(s) in SKILL.md frontmatter: ${unexpectedKeys.sort().join(', ')}. Allowed properties are: ${[...ALLOWED_PROPERTIES].sort().join(', ')}`];
  }

  // Check required fields
  if (!('name' in frontmatter)) {
    return [false, "Missing 'name' in frontmatter"];
  }
  if (!('description' in frontmatter)) {
    return [false, "Missing 'description' in frontmatter"];
  }

  // Validate name
  let name = frontmatter.name;
  if (typeof name !== 'string') {
    return [false, `Name must be a string, got ${typeof name}`];
  }
  name = name.trim();
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return [false, `Name '${name}' should be kebab-case (lowercase letters, digits, and hyphens only)`];
    }
    if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
      return [false, `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`];
    }
    if (name.length > 64) {
      return [false, `Name is too long (${name.length} characters). Maximum is 64 characters.`];
    }
  }

  // Validate description
  let description = frontmatter.description;
  if (typeof description !== 'string') {
    return [false, `Description must be a string, got ${typeof description}`];
  }
  description = description.trim();
  if (description) {
    if (description.includes('<') || description.includes('>')) {
      return [false, 'Description cannot contain angle brackets (< or >)'];
    }
    if (description.length > 1024) {
      return [false, `Description is too long (${description.length} characters). Maximum is 1024 characters.`];
    }
  }

  // Validate compatibility if present
  const compatibility = frontmatter.compatibility;
  if (compatibility) {
    if (typeof compatibility !== 'string') {
      return [false, `Compatibility must be a string, got ${typeof compatibility}`];
    }
    if (compatibility.length > 500) {
      return [false, `Compatibility is too long (${compatibility.length} characters). Maximum is 500 characters.`];
    }
  }

  return [true, 'Skill is valid!'];
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.log('Usage: node quick_validate.js <skill_directory>');
    process.exit(1);
  }

  const [valid, message] = validateSkill(args[0]);
  console.log(message);
  process.exit(valid ? 0 : 1);
}

module.exports = { validateSkill };