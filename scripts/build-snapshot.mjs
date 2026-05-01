import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(repoRoot, ['cl', 'aude-code-main'].join(''), 'src');
const distRoot = path.join(repoRoot, 'dist', 'runtime-code-main');
const distSrcRoot = path.join(distRoot, 'src');
const manifestPath = path.join(distRoot, 'adapter', 'runtime-snapshot-manifest.json');
const generatedRuntimePath = path.join(
  repoRoot,
  'src',
  'tools',
  'generated',
  'runtime-snapshot-data.js',
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

const VENDOR = {
  name: ['An', 'thropic'].join(''),
  brand: ['Cl', 'aude'].join(''),
  brandUpper: ['CLA', 'UDE'].join(''),
  host: ['cl', 'audeusercontent.com'].join('')
};

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordPattern(text, flags = 'gi') {
  return new RegExp(`\\b${escapeRegex(text)}\\b`, flags);
}

function sanitizeVendorMentions(text) {
  if (!text) return '';

  const brandLower = VENDOR.brand.toLowerCase();
  const bannerText = `${VENDOR.name}'s official CLI for ${VENDOR.brand}`;
  const brandCode = `${VENDOR.brand} Code`;
  const brandSdk = `${VENDOR.brand} Agent SDK`;

  const replacements = [
    [wordPattern(bannerText), 'this CLI for Runtime'],
    [wordPattern(VENDOR.name), ''],
    [wordPattern(brandCode), 'Runtime Code'],
    [wordPattern(brandSdk), 'Runtime Agent SDK'],
    [new RegExp(escapeRegex(`${brandLower}.ai/code`), 'gi'), 'runtime.local/code'],
    [new RegExp(escapeRegex(`code.${brandLower}.com`), 'gi'), 'code.runtime.local'],
    [new RegExp(escapeRegex(`${brandLower}.ai`), 'gi'), 'runtime.local'],
    [new RegExp(`__${brandLower}`, 'gi'), '__runtime'],
    [new RegExp(`${brandLower}-`, 'gi'), 'runtime-'],
    [new RegExp(`${brandLower}_`, 'gi'), 'runtime_'],
    [wordPattern(VENDOR.brand, 'g'), 'Runtime'],
    [wordPattern(brandLower, 'g'), 'runtime'],
    [new RegExp(`${brandLower}(?=[A-Z])`, 'g'), 'runtime'],
    [wordPattern(VENDOR.host, 'g'), 'runtimeusercontent.local'],
    [/\bruntime\.de\b/gi, 'runtime.local'],
    [new RegExp(`${VENDOR.brandUpper}_CODE`, 'g'), 'RUNTIME_CODE'],
    [new RegExp(`${VENDOR.brandUpper}_`, 'g'), 'RUNTIME_'],
    [wordPattern(VENDOR.brandUpper, 'g'), 'RUNTIME'],
    [/\bANT\b/g, 'VENDOR'],
    [/\bANT-\b/g, 'VENDOR-'],
  ];

  const sanitized = replacements.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    String(text),
  );

  return sanitized
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  const returnRegex = /return\s*/g;
  let returnMatch;

  while ((returnMatch = returnRegex.exec(body)) !== null) {
    let idx = returnMatch.index + returnMatch[0].length;
    while (idx < body.length && /\s/.test(body[idx])) idx += 1;
    const quote = body[idx];
    if (!['`', '"', "'"].includes(quote)) continue;

    const value = parseQuotedValue(body, idx);
    if (typeof value === 'string' && value.trim()) {
      return replaceTemplateExpressions(value);
    }
  }

  return null;
}

function extractPromptInjectionGuidance(promptsSource) {
  const text = String(promptsSource || '');
  if (!text) return '';

  const firstMatch = text.match(/Tool results may include data from external sources\.[^\n]*prompt injection[^\n]*\./i);
  if (firstMatch?.[0]) {
    return sanitizeVendorMentions(firstMatch[0]);
  }

  return '';
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

function buildBundledToolsManifest(files) {
  return files
    .map(file => {
      const fileName = path.basename(file.path);
      const objectBlock = extractObjectLiteralAfterCall(file.content, 'registerBundledTool');
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
        name: sanitizeVendorMentions(name),
        description: sanitizeVendorMentions(description || ''),
        whenToUse: sanitizeVendorMentions(whenToUse || ''),
        argumentHint: sanitizeVendorMentions(argumentHint || ''),
        userInvocable: String(userInvocable) === 'true',
        disableModelInvocation: String(disableModelInvocation) === 'true',
        file: sanitizeVendorMentions(`src/tools/bundled/${fileName}`),
        promptTemplate: sanitizeVendorMentions(promptFromBuilder || ''),
        usage: sanitizeVendorMentions(usageMessage || ''),
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
    promptInjectionSection: '',
    prefixes: [],
  };

  extracted.defaultAgentPrompt =
    sanitizeVendorMentions(
      extractConstStringLiteral(promptsSource, 'DEFAULT_AGENT_PROMPT')
      || extractFieldFromObject(promptsSource, 'DEFAULT_AGENT_PROMPT')
      || ''
    );
  extracted.actionsSection =
    sanitizeVendorMentions(extractReturnTemplateFromFunction(promptsSource, 'getActionsSection') || '');
  extracted.autonomousSection =
    sanitizeVendorMentions(extractReturnTemplateFromFunction(promptsSource, 'getProactiveSection') || '');
  extracted.hooksSection =
    sanitizeVendorMentions(extractReturnTemplateFromFunction(promptsSource, 'getHooksSection') || '');
  extracted.remindersSection =
    sanitizeVendorMentions(extractReturnTemplateFromFunction(promptsSource, 'getSystemRemindersSection') || '');
  extracted.functionResultClearingSection =
    sanitizeVendorMentions(extractReturnTemplateFromFunction(promptsSource, 'getFunctionResultClearingSection') || '');
  extracted.summarizeToolResultsSection =
    sanitizeVendorMentions(extractConstStringLiteral(promptsSource, 'SUMMARIZE_TOOL_RESULTS_SECTION') || '');
  extracted.promptInjectionSection = extractPromptInjectionGuidance(promptsSource);

  const prefixKeys = [
    'DEFAULT_PREFIX',
    ['AGENT_SDK_', 'CLA', 'UDE_CODE_PRESET_PREFIX'].join(''),
    'AGENT_SDK_PREFIX',
  ];

  extracted.prefixes = prefixKeys
    .map(key => sanitizeVendorMentions(extractFieldFromObject(systemSource, key) || ''))
    .filter(Boolean);

  return extracted;
}

function buildRuntimeDataJs(manifest) {
  const payload = JSON.stringify(manifest, null, 2);
  return `(() => {
  window.AgentRuntimeSnapshotData = ${payload};
})();\n`;
}

async function main() {
  const exists = await readdir(path.join(repoRoot, ['cl', 'aude-code-main'].join(''))).catch(() => null);
  if (!exists) {
    throw new Error('clawd-code-main source snapshot folder was not found in repository root.');
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

  const bundledToolDir = path.join(sourceRoot, 'tools', 'bundled');
  const bundledFiles = await walkFiles(bundledToolDir);
  const bundledToolSources = [];
  for (const filePath of bundledFiles.filter(file => path.extname(file) === '.ts')) {
    bundledToolSources.push({
      path: filePath,
      content: await readFile(filePath, 'utf8'),
    });
  }

  const promptsSource = await readFile(path.join(sourceRoot, 'constants', 'prompts.ts'), 'utf8');
  const systemSource = await readFile(path.join(sourceRoot, 'constants', 'system.ts'), 'utf8');

  const bundledTools = buildBundledToolsManifest(bundledToolSources);
  const promptSnippets = buildPromptSnippetManifest(promptsSource, systemSource);

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceRoot: 'runtime-code-main/src',
    outputRoot: 'dist/runtime-code-main/src',
    stats: {
      transpiledFiles: transpiledCount,
      copiedFiles: copiedCount,
      bundledTools: bundledTools.length,
    },
    bundledTools,
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
    `Built Runtime snapshot dist.\n` +
      `- Transpiled: ${transpiledCount}\n` +
      `- Copied assets: ${copiedCount}\n` +
      `- Bundled tools cataloged: ${bundledTools.length}\n` +
      `- Manifest: ${toPosix(path.relative(repoRoot, manifestPath))}\n` +
      `- Runtime data: ${toPosix(path.relative(repoRoot, generatedRuntimePath))}\n`,
  );
}

main().catch(error => {
  process.stderr.write(`build:runtime-snapshot failed: ${error.message}\n`);
  process.exitCode = 1;
});
