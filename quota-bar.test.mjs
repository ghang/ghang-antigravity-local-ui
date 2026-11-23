import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  PLUGIN_MARKER_END,
  PLUGIN_MARKER_START,
  getPluginStatus,
  installPlugin,
  uninstallPlugin,
} from './install.mjs';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const JS_PATH = join(PLUGIN_DIR, 'quota-bar.js');
const CSS_PATH = join(PLUGIN_DIR, 'quota-bar.css');

function loadLogicHelpers() {
  const src = readFileSync(JS_PATH, 'utf8');
  const start = '/* QUOTA_BAR_LOGIC_START */';
  const end = '/* QUOTA_BAR_LOGIC_END */';
  const s = src.indexOf(start);
  const e = src.indexOf(end);
  assert.ok(s !== -1 && e > s, 'QUOTA_BAR_LOGIC markers missing');
  const block = src.slice(s + start.length, e);
  const factory = new Function(
    `${block}\nreturn {
      normalizeQuotaBarStyleValue,
      normalizeQuotaBarClickValue,
      normalizeQuotaBarReset5hValue,
      readBucketRemainingFraction,
      readResetSec,
      calcRemainingPct,
      levelOfRemaining,
      formatCompactCountdown,
      formatSpacedCountdown,
      formatResetCountdown,
      formatShortGroupName,
      getBucketByWindow,
      findGlobalGroup,
      matchGroupForModel,
      formatSidebarResetStatus,
      maskEmail,
      normalizeAccountInfo,
      normalizeGroupsForCache,
      detectTurnFinishedSignal
    };`,
  );
  return factory();
}

function checkCssBraces(css) {
  let depth = 0;
  let inComment = false;
  let inStr = null;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    const next = css[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      assert.ok(depth >= 0, `Unmatched closing brace at offset ${i}`);
    }
  }
  assert.equal(inComment, false, 'Unclosed CSS comment');
  assert.equal(depth, 0, `Unclosed CSS brace depth=${depth}`);
}

test('quota-bar.js compiles in new Function(ctx, boot) sandbox and uses 0 MutationObserver', () => {
  const src = readFileSync(JS_PATH, 'utf8');
  const codeNoComments = src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeNoComments, /\bMutationObserver\b/, 'quota-bar.js must not use MutationObserver');
  assert.doesNotMatch(codeNoComments, /isGenerating\s*===/, 'legacy payload.isGenerating check must be removed');
  assert.match(src, /window\.__agQuotaBarHooks/, 'extension hooks must be exposed');
  assert.doesNotThrow(() => new Function('ctx', 'boot', src));
  assert.doesNotThrow(() => new vm.Script(src));
});

test('quota-bar.css has balanced braces and covers all 5 upstream presets', () => {
  const css = readFileSync(CSS_PATH, 'utf8');
  checkCssBraces(css);
  for (const needle of [
    '--ag-qb-card-bg',
    'data-ag-preset="absolutely"',
    'data-ag-preset="native"',
    'data-ag-dark-preset="claude-warm"',
    '#ag-sidebar-quota-wrap',
    '#ag-titlebar-quota-pill',
    '#ag-quota-tooltip',
    '[data-ag-qb-reset5h-switch="1"]',
  ]) {
    assert.ok(css.includes(needle), `Expected CSS selector/token: ${needle}`);
  }
});

test('quota logic helpers handle percentages, pool matching, dual countdowns, and PII-free cache normalization', () => {
  const h = loadLogicHelpers();

  assert.equal(h.calcRemainingPct(0.843, false), 84);
  assert.equal(h.calcRemainingPct(0.843, true), '84.3%');
  assert.equal(h.levelOfRemaining(26), 'ok');
  assert.equal(h.levelOfRemaining(25), 'warn');
  assert.equal(h.levelOfRemaining(11), 'warn');
  assert.equal(h.levelOfRemaining(10), 'crit');

  const groups = [
    {
      displayName: 'Gemini Models',
      description: 'Gemini 4',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remaining: { case: 'remainingFraction', value: 0.72 }, resetTime: { seconds: 2000000 } },
        { bucketId: 'gemini-5h', window: '5h', remaining: { case: 'remainingFraction', value: 0.2 }, resetTime: { seconds: 1007200 } },
      ],
    },
    {
      displayName: 'Claude / GPT',
      description: 'Claude Sonnet 4.5, GPT-OSS',
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', remaining: { case: 'remainingFraction', value: 0.91 }, resetTime: { seconds: 2000000 } },
      ],
    },
  ];
  const globalG = h.findGlobalGroup(groups);
  assert.equal(globalG.displayName, 'Gemini Models');
  assert.equal(h.matchGroupForModel(groups, 'Claude Sonnet 4.5', globalG).displayName, 'Claude / GPT');
  assert.equal(h.matchGroupForModel(groups, 'Gemini 4 Argon', globalG).displayName, 'Gemini Models');

  // Auto-switch countdown to 5h when 5h <= 25% and weekly > 25%
  const auto5h = h.formatSidebarResetStatus({
    remWeekly: 72,
    resetWeeklySec: 1000 + 3 * 86400,
    rem5h: 25,
    reset5hSec: 1000 + 3600,
    prefer5h: false,
    nowMs: 1000 * 1000,
    hasData: true,
    isZh: true,
  });
  assert.match(auto5h.text, /^5h限额/);
  assert.equal(auto5h.level, 'warn');

  // Dual countdown when prefer5h=true
  const dual = h.formatSidebarResetStatus({
    remWeekly: 72,
    resetWeeklySec: 1000 + 3 * 86400,
    rem5h: 88,
    reset5hSec: 1000 + 5400,
    prefer5h: true,
    nowMs: 1000 * 1000,
    hasData: true,
    isZh: true,
  });
  assert.match(dual.text, /^周限额/);
  assert.match(dual.secondaryText, /^5h限额/);

  // PII masking and normalized cache shape
  const acct = h.normalizeAccountInfo({ email: 'alice.smith@example.com', userTier: { name: 'Google AI Ultra' } });
  assert.deepEqual(acct, { maskedEmail: 'al***@example.com', tierLabel: 'Ultra' });

  const normGroups = h.normalizeGroupsForCache(groups);
  assert.equal(normGroups[0].buckets[0].remainingFraction, 0.72);
  assert.equal(normGroups[0].buckets[0].resetSec, 2000000);
});

test('review fix #1: detectTurnFinishedSignal fires on cancel button removal and metrics sig change', () => {
  const h = loadLogicHelpers();

  // Initial observation: no spurious trigger
  let s = { wasCancelBtnVisible: false, lastMetricsSig: null };
  let r = h.detectTurnFinishedSignal(s, { hasCancelBtn: false, metricsSig: 'sig-1' });
  assert.equal(r.triggered, false);
  s = r.nextState;

  // Generating starts
  r = h.detectTurnFinishedSignal(s, { hasCancelBtn: true, metricsSig: 'sig-1' });
  assert.equal(r.triggered, false);
  s = r.nextState;

  // Cancel button removed -> turn finished
  r = h.detectTurnFinishedSignal(s, { hasCancelBtn: false, metricsSig: 'sig-1' });
  assert.equal(r.triggered, true);
  s = r.nextState;

  // Metrics sig changes -> turn finished
  r = h.detectTurnFinishedSignal(s, { hasCancelBtn: false, metricsSig: 'sig-2' });
  assert.equal(r.triggered, true);
});

test('review fixes #2, #3, #4: multi-window storage sync throttle, session account meta cache, and decoupled Fiber cache', async () => {
  const src = readFileSync(JS_PATH, 'utf8');
  // Check source implementation markers for the 4 fixes
  assert.match(src, /lastFetchMs = Math\.max\(lastFetchMs, syncedAtMs\)/, 'handleStorageSync must update lastFetchMs');
  assert.match(src, /accountMetaResolved && cachedAccountMeta/, 'resolveAccountMetadata must cache per session');
  assert.match(src, /cachedServices\?\.cloudCodeService && \(cachedServices\.authService \|\| fiberAuthScanDone\)/, 'findFrontendServices must cache without authService');

  // Behavioral simulation in vm sandbox
  let quotaCalls = 0;
  let userStatusCalls = 0;
  let authChangeCb = null;
  const storageMap = new Map();
  const windowListeners = new Map();
  const intervals = [];

  const mockCloudCodeService = {
    async retrieveUserQuotaSummary() {
      quotaCalls += 1;
      return {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                { bucketId: 'gemini-weekly', window: 'weekly', remaining: { case: 'remainingFraction', value: 0.8 }, resetTime: { seconds: Math.floor(Date.now() / 1000) + 3600 } },
                { bucketId: 'gemini-5h', window: '5h', remaining: { case: 'remainingFraction', value: 0.9 }, resetTime: { seconds: Math.floor(Date.now() / 1000) + 1800 } },
              ],
            },
          ],
        },
      };
    },
  };
  const mockAuthService = {
    _lsClient: {
      async getUserStatus() {
        userStatusCalls += 1;
        return { userStatus: { email: 'dev@example.com', userTier: { name: 'Pro' } } };
      },
    },
    onDidChangeLoginSession(cb) {
      authChangeCb = cb;
      return { dispose() {} };
    },
  };

  const makeEl = (tag = 'div') => ({
    tagName: tag.toUpperCase(),
    nodeType: 1,
    style: {},
    attrs: new Map(),
    children: [],
    className: '',
    textContent: '',
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    },
    getAttribute(k) {
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    },
    hasAttribute(k) {
      return this.attrs.has(k);
    },
    removeAttribute(k) {
      this.attrs.delete(k);
    },
    appendChild(c) {
      c.parentElement = this;
      this.children.push(c);
      return c;
    },
    insertBefore(c) {
      c.parentElement = this;
      this.children.push(c);
      return c;
    },
    replaceChildren() {
      this.children = [];
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 200, height: 30, left: 0, top: 0, right: 200, bottom: 30 };
    },
    remove() {},
  });

  const rootEl = makeEl('div');
  rootEl.id = 'root';
  // Provide cloudCodeService + authService on React fiber root
  rootEl['__reactContainer$test'] = {
    current: {
      memoizedProps: { value: { core: { cloudCodeService: mockCloudCodeService, authService: mockAuthService } } },
    },
  };

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    WeakSet,
    Map,
    Set,
    Element: class Element {},
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) {
      const id = intervals.length + 1;
      intervals.push({ id, fn, ms });
      return id;
    },
    clearInterval() {},
    document: {
      hidden: false,
      visibilityState: 'visible',
      documentElement: makeEl('html'),
      body: makeEl('body'),
      getElementById(id) {
        return id === 'root' ? rootEl : null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      createElement: makeEl,
      createElementNS: (_ns, tag) => makeEl(tag),
      addEventListener() {},
      removeEventListener() {},
    },
    window: null,
  };
  sandbox.window = {
    location: { protocol: 'vscode-file:' },
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
    },
    addEventListener(ev, fn) {
      if (!windowListeners.has(ev)) windowListeners.set(ev, []);
      windowListeners.get(ev).push(fn);
    },
    removeEventListener() {},
  };
  sandbox.window.top = sandbox.window;

  const cleanups = [];
  const ctx = {
    config: { enabled: true },
    modules: { metrics: false, quotaBar: true, tokenAnalytics: true },
    onCleanup: (fn) => cleanups.push(fn),
  };

  const compiled = vm.runInNewContext(`(function(ctx, boot) {\n${src}\n})`, sandbox);
  compiled(ctx, ctx);

  // Wait for initial async fetchQuota to finish
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(quotaCalls, 1, 'initial quota fetch should run even when modules.metrics is false');
  assert.equal(userStatusCalls, 1, 'initial account metadata should be queried once');

  // Simulate another window updating localStorage right now -> storage event should throttle our 60s poll
  const freshUpdatedSec = Math.floor(Date.now() / 1000) + 1;
  storageMap.set(
    'ag-quota-cache-v1',
    JSON.stringify({
      v: 1,
      updatedAtSec: freshUpdatedSec,
      account: { maskedEmail: 'de***@example.com', tierLabel: 'Pro' },
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75, resetSec: freshUpdatedSec + 3600 }],
        },
      ],
    }),
  );
  for (const fn of windowListeners.get('storage') || []) {
    fn({ key: 'ag-quota-cache-v1', newValue: storageMap.get('ag-quota-cache-v1') });
  }
  const poll60s = intervals.find((i) => i.ms === 60000);
  assert.ok(poll60s, '60s poll interval should exist');
  poll60s.fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(quotaCalls, 1, '60s poll must skip fetch when another window just synced');

  // Trigger auth session change -> clears account cache and re-fetches both quota & userStatus
  assert.equal(typeof authChangeCb, 'function');
  authChangeCb();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(quotaCalls, 2);
  assert.equal(userStatusCalls, 2, 'account metadata cache must reset on auth change');

  // Cleanup
  for (const c of cleanups) c();
});

test('install.mjs idempotently installs, preserves existing user code, reports status, and uninstalls cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-qb-plugin-'));
  try {
    const jsPath = join(dir, 'custom.js');
    const cssPath = join(dir, 'custom.css');
    const userJs = '// user custom js\nconsole.log("keep me");\n';
    const userCss = '/* user custom css */\n:root { --my-var: 1px; }\n';
    writeFileSync(jsPath, userJs, 'utf8');
    writeFileSync(cssPath, userCss, 'utf8');

    const res1 = installPlugin({ targetDir: dir });
    assert.equal(res1.ok, true);
    assert.equal(res1.jsChanged, true);
    assert.equal(res1.cssChanged, true);

    const installedJs = readFileSync(jsPath, 'utf8');
    const installedCss = readFileSync(cssPath, 'utf8');
    assert.ok(installedJs.includes('console.log("keep me");'));
    assert.ok(installedJs.includes(PLUGIN_MARKER_START) && installedJs.includes(PLUGIN_MARKER_END));
    assert.ok(installedCss.includes('--my-var: 1px;'));
    assert.ok(installedCss.includes(PLUGIN_MARKER_START) && installedCss.includes(PLUGIN_MARKER_END));

    // Re-install is idempotent
    const res2 = installPlugin({ targetDir: dir });
    assert.equal(res2.jsChanged, false);
    assert.equal(res2.cssChanged, false);

    const st = getPluginStatus({ targetDir: dir });
    assert.equal(st.jsInstalled, true);
    assert.equal(st.cssInstalled, true);

    const uRes = uninstallPlugin({ targetDir: dir });
    assert.equal(uRes.jsRemoved, true);
    assert.equal(uRes.cssRemoved, true);
    assert.equal(readFileSync(jsPath, 'utf8'), userJs);
    assert.equal(readFileSync(cssPath, 'utf8'), userCss);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
