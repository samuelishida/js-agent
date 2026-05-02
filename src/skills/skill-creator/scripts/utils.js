#!/usr/bin/env node
/**
 * Shared utilities for skill-creator scripts.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse a SKILL.md file, returning { name, description, content }.
 * @param {string} skillPath - Path to the skill directory
 * @returns {{ name: string, description: string, content: string }}
 */
function parseSkillMd(skillPath) {
  const mdFile = path.join(skillPath, 'SKILL.md');
  const content = fs.readFileSync(mdFile, 'utf-8');
  const lines = content.split('\n');

  if (lines[0].trim() !== '---') {
    throw new Error('SKILL.md missing frontmatter (no opening ---)');
  }

  let endIdx = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }

  if (endIdx === null) {
    throw new Error('SKILL.md missing frontmatter (no closing ---)');
  }

  let name = '';
  let description = '';
  const frontmatterLines = lines.slice(1, endIdx);
  let i = 0;
  while (i < frontmatterLines.length) {
    const line = frontmatterLines[i];
    if (line.startsWith('name:')) {
      name = line.slice('name:'.length).trim().replace(/^["']|["']$/g, '');
    } else if (line.startsWith('description:')) {
      let value = line.slice('description:'.length).trim();
      // Handle YAML multiline indicators (>, |, >-, |-)
      if (['>', '|', '>-', '|-'].includes(value)) {
        const continuationLines = [];
        i++;
        while (i < frontmatterLines.length && (frontmatterLines[i].startsWith('  ') || frontmatterLines[i].startsWith('\t'))) {
          continuationLines.push(frontmatterLines[i].trim());
          i++;
        }
        description = continuationLines.join(' ');
        continue;
      } else {
        description = value.replace(/^["']|["']$/g, '');
      }
    }
    i++;
  }

  return { name, description, content };
}

module.exports = { parseSkillMd };