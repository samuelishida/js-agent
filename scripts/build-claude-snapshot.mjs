import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(repoRoot, 'claude-code-main', 'src');
const distRoot = path.join(repoRoot, 'dist', 'claude-code-main');
const distSrcRoot = path.join(distRoot, 'src');
const manifestPath = path.join(distRoot, 'adapter', 'claude-snapshot-manifest.json');
const generatedRuntimePath = path.join(
  repoRoot,
  'src',
  'skills',
  'generated',
  'claude-snapshot-data.js',
);

const CODE_LOADERS = new Map([
  ['.ts', 'ts'],
  ['.tsx', 'tsx'],
  ['.mts', 'ts'],
  ['.cts', 'ts'],
  ['.js', 'js'],
  ['.jsx', 'jsx'],
  ['.mjs', 'js'],
  ['.cjs', 'js'],
]);

const COPY_EXTENSIONS = new Set([
  '.md',
  '.json',
  '.txt',
  '.yaml',
  '.yml',
  '.css',
  '.html',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.wasm',
  '.node',
  '.sql',
]);

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function sanitizeAnthropicMentions(text) {
  if (!text) return '';

  const replacements = [
    [/\bAnthropic's official CLI for Claude\b/gi, 'this agent CLI'],
    [/\bAnthropic\b/gi, 'the model provider'],
    [/\bClaude Code\b/gi, 'the agent runtime'],
    [/\bClaude Agent SDK\b/gi, 'the agent SDK'],
    [/\bclaude\.ai\/code\b/gi, 'the assistant web app'],
    [/\bcode\.claude\.com\b/gi, 'the agent docs'],
    [/\bclaude\.ai\b/gi, 'the assistant web app'],
    [/__claude/gi, '__assistant'],
    [/claude-/gi, 'assistant-'],
    [/claude_/gi, 'assistant_'],
    [/\bClaude\b/g, 'Assistant'],
    [/\bclaude\b/g, 'assistant'],
    [/\bANT-\b/g, 'VENDOR-'],
  ];

  return replacements.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    String(text),
  );
}

function rewriteImportsToJs(content) {
  return String(content)
    .replace(
      /(from\s+['"][^'"]+)\.(ts|tsx|mts|cts)(['"])/g,
      (_m, prefix, _ext, suffix) => `${prefix}.js${suffix}`,
    )
    .replace(
      /(import\(\s*['"][^'"]+)\.(ts|tsx|mts|cts)(['"]\s*\))/g,
      (_m, prefix, _ext, suffix) => `${prefix}.js${suffix}`,
    );
}

function replaceTemplateExpressions(templateLiteralBody) {
  return String(templateLiteralBody || '').replace(/\$\{[^}]+\}/g, '<expr>');
}

function parseQuotedValue(source, start) {
  const quote = source[start];
  if (!['"', "'", '`'].includes(quote)) return null;
  let i = start + 1;
  let value = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      if (i + 1 < source.length) {
        value += source.slice(i, i + 2);
        i += 2;
        continue;
      }
    }
    if (ch === quote) {
      if (quote === '`') {
        return replaceTemplateExpressions(value);
      }
      try {
        return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
      } catch {
        return value;
      }
    }
    value += ch;
    i += 1;
  }
  return null;
}

function extractFieldFromObject(source, key) {
  const regex = new RegExp(`${key}\\s*:\\s*`, 'm');
  const match = source.match(regex);
  if (!match || match.index == null) return null;
  let i = match.index + match[0].length;
  while (i < source.length && /\s/.test(source[i])) i += 1;

  const ch = source[i];
  if (ch === "'" || ch === '"' || ch === '`') {
    return parseQuotedValue(source, i);
  }

  const tail = source.slice(i);
  const primitive = tail.match(/^(true|false|null|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*)/);
  if (!primitive) return null;
  return primitive[1];
}

function extractObjectLiteralAfterCall(source, functionName) {
  const marker = `${functionName}({`;
  const startIndex = source.indexOf(marker);
  if (startIndex < 0) return null;
  let i = startIndex + functionName.length + 1;
  while (i < source.length && source[i] !== '{') i += 1;
  if (i >= source.length) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  const start = i;

  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function extractReturnTemplateFromFunction(source, functionName) {
  const fnRegex = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`);
  const match = source.match(fnRegex);
  if (!match || match.index == null) return null;
  let i = match.index + match[0].length;
  let depth = 1;
  let inString = false;
  let quote = '';
  let escaped = false;
  const bodyStart = i;

  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }

  const body = source.slice(bodyStart, i);
  const returnMatch = body.match(/return\s*`([\s\S]*?)`/m);
  if (!returnMatch) return null;
  return replaceTemplateExpressions(returnMatch[1]);
}

function extractConstStringLiteral(source, constName) {
  const regex = new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*=\\s*`, 'm');
  const match = source.match(regex);
  if (!match || match.index == null) return null;
  let i = match.index + match[0].length;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return parseQuotedValue(source, i);
}

async function walkFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFiles(absolute);
      files.push(...nested);
      continue;
    }
    files.push(absolute);
  }
  return files;
}

function mapOutputPath(inputFile) {
  const relative = path.relative(sourceRoot, inputFile);
  const ext = path.extname(relative);
  if (ext === '.d.ts') return null;
  if (CODE_LOADERS.has(ext)) {
    const outputRelative = relative.replace(/\.(tsx?|mts|cts)$/, '.js');
    return path.join(distSrcRoot, outputRelative);
  }
  if (COPY_EXTENSIONS.has(ext)) {
    return path.join(distSrcRoot, relative);
  }
  return null;
}

async function transpileSourceFile(inputFile, outputFile) {
  const ext = path.extname(inputFile);
  const loader = CODE_LOADERS.get(ext);
  const raw = await readFile(inputFile, 'utf8');

  if (!loader) {
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, raw);
    return { transpiled: false };
  }

  const transformed = await transform(raw, {
    loader,
    format: 'esm',
    target: 'es2022',
    sourcemap: 'inline',
    sourcefile: toPosix(path.relative(repoRoot, inputFile)),
    legalComments: 'none',
    charset: 'utf8',
  });

  const rewritten = rewriteImportsToJs(transformed.code);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, rewritten);
  return { transpiled: true };
}

function buildBundledSkillsManifest(files) {
  return files
    .map(file => {
      const fileName = path.basename(file.path);
      const objectBlock = extractObjectLiteralAfterCall(file.content, 'registerBundledSkill');
      if (!objectBlock) return null;

      const name = extractFieldFromObject(objectBlock, 'name');
      if (!name || typeof name !== 'string') return null;

      const description = extractFieldFromObject(objectBlock, 'description');
      const whenToUse = extractFieldFromObject(objectBlock, 'whenToUse');
      const argumentHint = extractFieldFromObject(objectBlock, 'argumentHint');
      const userInvocable = extractFieldFromObject(objectBlock, 'userInvocable');
      const disableModelInvocation = extractFieldFromObject(objectBlock, 'disableModelInvocation');

      const promptFromBuilder = extractReturnTemplateFromFunction(file.content, 'buildPrompt');
      const usageMessage = extractFieldFromObject(file.content, 'USAGE_MESSAGE');

      return {
        name: sanitizeAnthropicMentions(name),
        description: sanitizeAnthropicMentions(description || ''),
        whenToUse: sanitizeAnthropicMentions(whenToUse || ''),
        argumentHint: sanitizeAnthropicMentions(argumentHint || ''),
        userInvocable: String(userInvocable) === 'true',
        disableModelInvocation: String(disableModelInvocation) === 'true',
        file: `src/skills/bundled/${fileName}`,
        promptTemplate: sanitizeAnthropicMentions(promptFromBuilder || ''),
        usage: sanitizeAnthropicMentions(usageMessage || ''),
      };
    })
    .filter(Boolean);
}

function buildPromptSnippetManifest(promptsSource, systemSource) {
  const extracted = {
    defaultAgentPrompt: '',
    actionsSection: '',
    autonomousSection: '',
    hooksSection: '',
    remindersSection: '',
    functionResultClearingSection: '',
    summarizeToolResultsSection: '',
    prefixes: [],
  };

  extracted.defaultAgentPrompt =
    sanitizeAnthropicMentions(
      extractConstStringLiteral(promptsSource, 'DEFAULT_AGENT_PROMPT')
      || extractFieldFromObject(promptsSource, 'DEFAULT_AGENT_PROMPT')
      || ''
    );
  extracted.actionsSection =
    sanitizeAnthropicMentions(extractReturnTemplateFromFunction(promptsSource, 'getActionsSection') || '');
  extracted.autonomousSection =
    sanitizeAnthropicMentions(extractReturnTemplateFromFunction(promptsSource, 'getProactiveSection') || '');
  extracted.hooksSection =
    sanitizeAnthropicMentions(extractReturnTemplateFromFunction(promptsSource, 'getHooksSection') || '');
  extracted.remindersSection =
    sanitizeAnthropicMentions(extractReturnTemplateFromFunction(promptsSource, 'getSystemRemindersSection') || '');
  extracted.functionResultClearingSection =
    sanitizeAnthropicMentions(extractReturnTemplateFromFunction(promptsSource, 'getFunctionResultClearingSection') || '');
  extracted.summarizeToolResultsSection =
    sanitizeAnthropicMentions(extractConstStringLiteral(promptsSource, 'SUMMARIZE_TOOL_RESULTS_SECTION') || '');

  const prefixKeys = [
    'DEFAULT_PREFIX',
    'AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX',
    'AGENT_SDK_PREFIX',
  ];

  extracted.prefixes = prefixKeys
    .map(key => sanitizeAnthropicMentions(extractFieldFromObject(systemSource, key) || ''))
    .filter(Boolean);

  return extracted;
}

function buildRuntimeDataJs(manifest) {
  const payload = JSON.stringify(manifest, null, 2);
  return `(() => {
  window.AgentClaudeSnapshotData = ${payload};
})();\n`;
}

async function main() {
  const exists = await readdir(path.join(repoRoot, 'claude-code-main')).catch(() => null);
  if (!exists) {
    throw new Error('claude-code-main directory was not found in repository root.');
  }

  await rm(distRoot, { recursive: true, force: true });

  const allFiles = await walkFiles(sourceRoot);
  let transpiledCount = 0;
  let copiedCount = 0;

  for (const inputFile of allFiles) {
    const outputFile = mapOutputPath(inputFile);
    if (!outputFile) continue;
    const result = await transpileSourceFile(inputFile, outputFile);
    if (result.transpiled) transpiledCount += 1;
    else copiedCount += 1;
  }

  const bundledSkillDir = path.join(sourceRoot, 'skills', 'bundled');
  const bundledFiles = await walkFiles(bundledSkillDir);
  const bundledSkillSources = [];
  for (const filePath of bundledFiles.filter(file => path.extname(file) === '.ts')) {
    bundledSkillSources.push({
      path: filePath,
      content: await readFile(filePath, 'utf8'),
    });
  }

  const promptsSource = await readFile(path.join(sourceRoot, 'constants', 'prompts.ts'), 'utf8');
  const systemSource = await readFile(path.join(sourceRoot, 'constants', 'system.ts'), 'utf8');

  const bundledSkills = buildBundledSkillsManifest(bundledSkillSources);
  const promptSnippets = buildPromptSnippetManifest(promptsSource, systemSource);

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceRoot: 'claude-code-main/src',
    outputRoot: 'dist/claude-code-main/src',
    stats: {
      transpiledFiles: transpiledCount,
      copiedFiles: copiedCount,
      bundledSkills: bundledSkills.length,
    },
    bundledSkills,
    promptSnippets,
    notes: [
      'Snapshot transpiled from TypeScript/TSX to JS with import extension rewrite.',
      'Prompt snippets were sanitized to remove direct provider branding.',
      'This manifest is for adapting architecture patterns, not running vendor runtime unchanged.',
    ],
  };

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  await mkdir(path.dirname(generatedRuntimePath), { recursive: true });
  await writeFile(generatedRuntimePath, buildRuntimeDataJs(manifest), 'utf8');

  process.stdout.write(
    `Built Claude snapshot dist.\n` +
      `- Transpiled: ${transpiledCount}\n` +
      `- Copied assets: ${copiedCount}\n` +
      `- Bundled skills cataloged: ${bundledSkills.length}\n` +
      `- Manifest: ${toPosix(path.relative(repoRoot, manifestPath))}\n` +
      `- Runtime data: ${toPosix(path.relative(repoRoot, generatedRuntimePath))}\n`,
  );
}

main().catch(error => {
  process.stderr.write(`build:claude-snapshot failed: ${error.message}\n`);
  process.exitCode = 1;
});
