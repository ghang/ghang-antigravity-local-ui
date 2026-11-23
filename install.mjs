#!/usr/bin/env node
/**
 * ghang-antigravity-local-ui — Idempotent installer/uninstaller for user/custom.{js,css}
 *
 * Usage:
 *   node install.mjs install [--target-dir <userDir>] [--json]
 *   node install.mjs uninstall [--target-dir <userDir>] [--json]
 *   node install.mjs status [--target-dir <userDir>] [--json]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_MARKER_START = '/* __AG_PLUGIN_QUOTA_BAR_START__ */';
export const PLUGIN_MARKER_END = '/* __AG_PLUGIN_QUOTA_BAR_END__ */';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET_DIR = join(homedir(), '.gemini', 'antigravity', 'theme-patch', 'user');

function writeAtomic(targetPath, content) {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, targetPath);
}

export function hasPluginBlock(text, startMarker = PLUGIN_MARKER_START, endMarker = PLUGIN_MARKER_END) {
  if (typeof text !== 'string') return false;
  const s = text.indexOf(startMarker);
  const e = text.indexOf(endMarker);
  return s !== -1 && e !== -1 && e > s;
}

export function upsertPluginBlock(
  existingText,
  blockContent,
  startMarker = PLUGIN_MARKER_START,
  endMarker = PLUGIN_MARKER_END,
) {
  const raw = typeof existingText === 'string' ? existingText.replace(/^\uFEFF/, '') : '';
  const body = String(blockContent || '').trim();
  const wrapped = `${startMarker}\n${body}\n${endMarker}`;

  const s = raw.indexOf(startMarker);
  const e = raw.indexOf(endMarker);
  if (s !== -1 && e !== -1 && e > s) {
    const before = raw.slice(0, s);
    const after = raw.slice(e + endMarker.length);
    const out = `${before}${wrapped}${after}`;
    return out.endsWith('\n') ? out : `${out}\n`;
  }

  const trimmed = raw.trimEnd();
  if (!trimmed) {
    return `${wrapped}\n`;
  }
  return `${trimmed}\n\n${wrapped}\n`;
}

export function removePluginBlock(
  existingText,
  startMarker = PLUGIN_MARKER_START,
  endMarker = PLUGIN_MARKER_END,
) {
  if (typeof existingText !== 'string' || !existingText) return { text: '', removed: false };
  const raw = existingText.replace(/^\uFEFF/, '');
  const s = raw.indexOf(startMarker);
  const e = raw.indexOf(endMarker);
  if (s === -1 || e === -1 || e <= s) {
    return { text: raw, removed: false };
  }
  const before = raw.slice(0, s).replace(/[ \t]*\n+$/, '');
  const after = raw.slice(e + endMarker.length).replace(/^\n+/, '');
  let joined = '';
  if (before && after) {
    joined = `${before}\n\n${after}`;
  } else if (before) {
    joined = `${before}\n`;
  } else if (after) {
    joined = after.endsWith('\n') ? after : `${after}\n`;
  }
  return { text: joined, removed: true };
}

function readConfigFlags(targetDir) {
  const cfgPath = join(targetDir, 'config.json');
  if (!existsSync(cfgPath)) {
    return { exists: false, customCssDisabled: false, customJsDisabled: false, patchDisabled: false };
  }
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    return {
      exists: true,
      patchDisabled: cfg?.enabled === false,
      customCssDisabled: cfg?.modules?.customCss === false,
      customJsDisabled: cfg?.modules?.customJs === false,
    };
  } catch {
    return { exists: true, customCssDisabled: false, customJsDisabled: false, patchDisabled: false };
  }
}

export function getPluginStatus({ targetDir = DEFAULT_TARGET_DIR } = {}) {
  const jsPath = join(targetDir, 'custom.js');
  const cssPath = join(targetDir, 'custom.css');
  const jsText = existsSync(jsPath) ? readFileSync(jsPath, 'utf8') : '';
  const cssText = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  const cfgFlags = readConfigFlags(targetDir);
  return {
    targetDir,
    jsPath,
    cssPath,
    jsInstalled: hasPluginBlock(jsText),
    cssInstalled: hasPluginBlock(cssText),
    ...cfgFlags,
  };
}

export function installPlugin({ targetDir = DEFAULT_TARGET_DIR, pluginDir = PLUGIN_DIR } = {}) {
  const srcJsPath = join(pluginDir, 'quota-bar.js');
  const srcCssPath = join(pluginDir, 'quota-bar.css');
  if (!existsSync(srcJsPath) || !existsSync(srcCssPath)) {
    throw new Error(`Plugin source files missing in ${pluginDir}`);
  }
  const srcJs = readFileSync(srcJsPath, 'utf8');
  const srcCss = readFileSync(srcCssPath, 'utf8');

  const dstJsPath = join(targetDir, 'custom.js');
  const dstCssPath = join(targetDir, 'custom.css');
  const prevJs = existsSync(dstJsPath) ? readFileSync(dstJsPath, 'utf8') : '';
  const prevCss = existsSync(dstCssPath) ? readFileSync(dstCssPath, 'utf8') : '';

  const nextJs = upsertPluginBlock(prevJs, srcJs);
  const nextCss = upsertPluginBlock(prevCss, srcCss);

  writeAtomic(dstJsPath, nextJs);
  writeAtomic(dstCssPath, nextCss);

  return {
    ok: true,
    action: 'install',
    targetDir,
    jsChanged: nextJs !== prevJs,
    cssChanged: nextCss !== prevCss,
    ...readConfigFlags(targetDir),
  };
}

export function uninstallPlugin({ targetDir = DEFAULT_TARGET_DIR } = {}) {
  const dstJsPath = join(targetDir, 'custom.js');
  const dstCssPath = join(targetDir, 'custom.css');

  let jsRemoved = false;
  let cssRemoved = false;

  if (existsSync(dstJsPath)) {
    const prevJs = readFileSync(dstJsPath, 'utf8');
    const resJs = removePluginBlock(prevJs);
    if (resJs.removed) {
      writeAtomic(dstJsPath, resJs.text);
      jsRemoved = true;
    }
  }
  if (existsSync(dstCssPath)) {
    const prevCss = readFileSync(dstCssPath, 'utf8');
    const resCss = removePluginBlock(prevCss);
    if (resCss.removed) {
      writeAtomic(dstCssPath, resCss.text);
      cssRemoved = true;
    }
  }

  return {
    ok: true,
    action: 'uninstall',
    targetDir,
    jsRemoved,
    cssRemoved,
  };
}

function parseArgs(argv) {
  const flags = {};
  let cmd = '';
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!cmd && !tok.startsWith('-')) {
      cmd = tok;
      continue;
    }
    if (tok === '--json') flags.json = true;
    else if (tok === '-h' || tok === '--help') flags.help = true;
    else if (tok.startsWith('--target-dir=')) flags.targetDir = tok.slice('--target-dir='.length);
    else if (tok === '--target-dir' && argv[i + 1]) {
      flags.targetDir = argv[i + 1];
      i += 1;
    }
  }
  return { cmd: cmd || 'status', flags };
}

function printHelp() {
  console.log(`ghang-antigravity-local-ui installer

Usage:
  node install.mjs install [--target-dir <dir>] [--json]
  node install.mjs uninstall [--target-dir <dir>] [--json]
  node install.mjs status [--target-dir <dir>] [--json]

Default target dir: ${DEFAULT_TARGET_DIR}`);
}

function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    process.exit(0);
  }
  const targetDir = flags.targetDir ? resolve(flags.targetDir) : DEFAULT_TARGET_DIR;

  if (cmd === 'install') {
    const res = installPlugin({ targetDir });
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`✔ Installed ghang-antigravity-local-ui into ${res.targetDir}`);
      console.log(`  custom.js : ${res.jsChanged ? 'updated' : 'already up-to-date'}`);
      console.log(`  custom.css: ${res.cssChanged ? 'updated' : 'already up-to-date'}`);
      if (res.patchDisabled || res.customCssDisabled || res.customJsDisabled) {
        console.warn('! Note: user/config.json currently disables enabled/modules.customCss/modules.customJs.');
      }
      console.log('  Hot-reload will apply within ~2.5s if theme-patch daemon is running.');
    }
    return;
  }

  if (cmd === 'uninstall') {
    const res = uninstallPlugin({ targetDir });
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`✔ Uninstalled ghang-antigravity-local-ui from ${res.targetDir}`);
      console.log(`  custom.js removed : ${res.jsRemoved}`);
      console.log(`  custom.css removed: ${res.cssRemoved}`);
    }
    return;
  }

  if (cmd === 'status') {
    const res = getPluginStatus({ targetDir });
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Target: ${res.targetDir}`);
      console.log(`  custom.js : ${res.jsInstalled ? 'installed' : 'not installed'}`);
      console.log(`  custom.css: ${res.cssInstalled ? 'installed' : 'not installed'}`);
    }
    return;
  }

  printHelp();
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
