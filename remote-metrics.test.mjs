import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  PLUGIN_MARKER_END,
  PLUGIN_MARKER_START,
  installPlugin,
  uninstallPlugin,
} from './install.mjs';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const JS_PATH = join(PLUGIN_DIR, 'remote-metrics.js');

function loadLogicHelpers() {
  const src = readFileSync(JS_PATH, 'utf8');
  const start = '/* REMOTE_METRICS_LOGIC_START */';
  const end = '/* REMOTE_METRICS_LOGIC_END */';
  const s = src.indexOf(start);
  const e = src.indexOf(end);
  assert.ok(s !== -1 && e > s, 'REMOTE_METRICS_LOGIC markers missing');
  const block = src.slice(s + start.length, e);
  const factory = new Function(
    `${block}\nreturn {
      toNum,
      parseDurationSec,
      fmtTok,
      fmtNum,
      formatContextCeiling,
      parseGeneratorMetadataItem,
      classifyStep,
      createStepTurnState,
      accumulateSteps,
      createGenIncState,
      mergeGenMetadataDelta,
      buildMetricsPayload
    };`,
  );
  return factory();
}

test('remote-metrics.js compiles in new Function(ctx, boot) sandbox with 0 MutationObserver', () => {
  const src = readFileSync(JS_PATH, 'utf8');
  const codeNoComments = src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.doesNotThrow(() => new Function('ctx', 'boot', src));
  assert.doesNotThrow(() => new vm.Script(src));
  assert.doesNotMatch(codeNoComments, /\bMutationObserver\b/, 'must not use MutationObserver');
  assert.ok(src.includes('ctx.onCleanup'), 'must register cleanup via ctx.onCleanup');
});

test('parseGeneratorMetadataItem and buildMetricsPayload handle BigInt protobuf-es fields accurately', () => {
  const h = loadLogicHelpers();
  const inc = h.createGenIncState();
  const rawEntries = [
    {
      metadata: {
        case: 'chatModel',
        value: {
          responseModel: 'gemini-4-neon',
          usage: {
            inputTokens: 10000n,
            outputTokens: 1200n,
            thinkingOutputTokens: 600n,
            responseOutputTokens: 600n,
            cacheReadTokens: 2000n,
            apiProvider: 24,
          },
          chatStartMetadata: {
            contextWindowMetadata: { estimatedTokensUsed: 12000, maxContextTokens: 512000 },
          },
          timeToFirstToken: { seconds: 2n, nanos: 0 },
          streamingDuration: { seconds: 10n, nanos: 0 },
        },
      },
    },
    {
      metadata: {
        case: 'chatModel',
        value: {
          responseModel: 'gemini-4-neon',
          usage: {
            inputTokens: 2496n,
            outputTokens: 9127n,
            thinkingOutputTokens: 5158n,
            responseOutputTokens: 3969n,
            cacheReadTokens: 29972n,
            apiProvider: 24,
          },
          chatStartMetadata: {
            contextWindowMetadata: { estimatedTokensUsed: 39626, maxContextTokens: 512000 },
          },
          timeToFirstToken: { seconds: 5n, nanos: 613691334 },
          streamingDuration: { seconds: 108n, nanos: 817133041 },
        },
      },
    },
  ];
  h.mergeGenMetadataDelta(inc, rawEntries, 0);
  const stepState = h.createStepTurnState();
  const turnMeta = h.accumulateSteps(
    stepState,
    [
      { type: 14, step: { case: 'userInput' } },
      { type: 15, step: { case: 'plannerResponse' } },
      { type: 15, step: { case: 'plannerResponse' } },
    ],
    0,
  );
  assert.equal(turnMeta.effectiveTurnsCount, 1);
  assert.equal(turnMeta.rawTurnSteps, 2);
  assert.equal(turnMeta.isSubagentWakeTurns, false);

  const payload = h.buildMetricsPayload({
    cascadeId: '05f4233b-31de-4f19-b258-4fedfc51dd8d',
    inc,
    userStepsCount: turnMeta.effectiveTurnsCount,
    isSubagentWakeTurns: turnMeta.isSubagentWakeTurns,
    rawTurnSteps: turnMeta.rawTurnSteps,
    config: { metricsMode: 'compact', contextLimit: 256000 },
    isEnMetrics: false,
    stepCount: stepState.totalSteps,
  });

  assert.equal(payload.hasData, true);
  assert.equal(payload.dbFound, true);
  assert.equal(payload.__agRemoteFallback, true);
  assert.ok(payload.inlineHtml.includes('84 tok/s'), payload.inlineHtml);
  assert.ok(payload.inlineHtml.includes('TTFT 5.6s'), payload.inlineHtml);
  assert.ok(payload.tooltipHtml.includes('第1轮 总2步'), payload.tooltipHtml);
  assert.ok(payload.tooltipHtml.includes('流式 83.9 tok/s | 端到端 79.8 tok/s'), payload.tooltipHtml);
  assert.ok(payload.tooltipHtml.includes('缓存率 92.3%'), payload.tooltipHtml);
  assert.ok(payload.tooltipHtml.includes('32k/512k (6%)'), payload.tooltipHtml);
  assert.ok(payload.tooltipHtml.includes('1 轮提问 / 2 次调用'), payload.tooltipHtml);

  const enFullPayload = h.buildMetricsPayload({
    cascadeId: '05f4233b-31de-4f19-b258-4fedfc51dd8d',
    inc,
    userStepsCount: 1,
    isSubagentWakeTurns: false,
    rawTurnSteps: 2,
    config: { metricsMode: 'full', contextLimitOverride: 1000000 },
    isEnMetrics: true,
    stepCount: 3,
  });
  assert.ok(enFullPayload.inlineHtml.includes('Ctx 32k/1M <span class="ag-ctx-ok">(3%)</span>'));
  assert.ok(enFullPayload.tooltipHtml.includes('Session Total (1 turn / 2 calls)'));
});

test('Claude thinkUnreported, incremental delta, and subagent wake turns match daemon semantics', () => {
  const h = loadLogicHelpers();
  const inc = h.createGenIncState();
  h.mergeGenMetadataDelta(
    inc,
    [
      {
        metadata: {
          case: 'chatModel',
          value: {
            responseModel: 'claude-sonnet-4-6',
            usage: {
              inputTokens: 1000n,
              outputTokens: 500n,
              thinkingOutputTokens: 0n,
              responseOutputTokens: 0n,
              cacheReadTokens: 9000n,
              apiProvider: 26,
            },
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } },
            timeToFirstToken: { seconds: 1n, nanos: 0 },
            streamingDuration: { seconds: 5n, nanos: 0 },
          },
        },
      },
    ],
    0,
  );
  // Simulate delta re-fetch from offset 0 with updated outputTokens
  h.mergeGenMetadataDelta(
    inc,
    [
      {
        metadata: {
          case: 'chatModel',
          value: {
            responseModel: 'claude-sonnet-4-6',
            usage: {
              inputTokens: 1000n,
              outputTokens: 800n,
              thinkingOutputTokens: 0n,
              responseOutputTokens: 0n,
              cacheReadTokens: 9000n,
              apiProvider: 26,
            },
            chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } },
            timeToFirstToken: { seconds: 1n, nanos: 0 },
            streamingDuration: { seconds: 8n, nanos: 0 },
          },
        },
      },
    ],
    0,
  );
  assert.equal(inc.validItems.length, 1);
  assert.equal(inc.totalOut, 800);

  const stepState = h.createStepTurnState();
  const turnMeta = h.accumulateSteps(
    stepState,
    [
      { type: 101, step: { case: 'sendMessage', value: { text: '[Message] from coordinator' } } },
      { type: 101, step: { case: 'sendMessage', value: { text: '[Message] consecutive' } } },
      { type: 101, step: { case: 'sendMessage', value: { text: '[Message] /task-ignored' } } },
      { type: 15, step: { case: 'plannerResponse' } },
    ],
    0,
  );
  assert.equal(turnMeta.isSubagentWakeTurns, true);
  assert.equal(turnMeta.effectiveTurnsCount, 1);
  assert.equal(turnMeta.rawTurnSteps, 1);

  const payload = h.buildMetricsPayload({
    cascadeId: '9d105aba-b929-4523-a341-96e2ef55a3aa',
    inc,
    userStepsCount: turnMeta.effectiveTurnsCount,
    isSubagentWakeTurns: turnMeta.isSubagentWakeTurns,
    rawTurnSteps: turnMeta.rawTurnSteps,
    config: { metricsMode: 'compact' },
    isEnMetrics: false,
    stepCount: stepState.totalSteps,
  });
  assert.ok(payload.tooltipHtml.includes('第1次唤醒 总1步'));
  assert.ok(payload.tooltipHtml.includes('(接口合并计入思考链)'));
});

test('runtime wrapper avoids Fiber scan on local dbs and falls back cleanly on dbFound: false', async () => {
  const src = readFileSync(JS_PATH, 'utf8');
  const cidLocal = '11111111-1111-4111-8111-111111111111';
  const cidRemote = '05f4233b-31de-4f19-b258-4fedfc51dd8d';
  const delivered = [];
  let lsCalls = 0;

  const lsClient = {
    async getCascadeTrajectoryGeneratorMetadata({ cascadeId }) {
      lsCalls += 1;
      assert.equal(cascadeId, cidRemote);
      return {
        generatorMetadata: [
          {
            metadata: {
              case: 'chatModel',
              value: {
                responseModel: 'gemini-4-neon',
                usage: {
                  inputTokens: 1500n,
                  outputTokens: 500n,
                  thinkingOutputTokens: 200n,
                  responseOutputTokens: 300n,
                  cacheReadTokens: 8500n,
                  apiProvider: 24,
                },
                chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } },
                timeToFirstToken: { seconds: 1n, nanos: 500000000 },
                streamingDuration: { seconds: 5n, nanos: 0 },
              },
            },
          },
        ],
      };
    },
    async getCascadeTrajectorySteps({ cascadeId, startIndex }) {
      lsCalls += 1;
      assert.equal(cascadeId, cidRemote);
      if (startIndex > 0) return { steps: [] };
      return {
        steps: [
          { type: 14, step: { case: 'userInput' } },
          { type: 15, step: { case: 'plannerResponse' } },
        ],
      };
    },
  };

  const rootEl = {
    __reactContainer$test: {
      current: {
        memoizedProps: { value: { authService: { _lsClient: lsClient } } },
        child: null,
        sibling: null,
      },
    },
  };

  const intervals = [];
  const doc = {
    hidden: false,
    getElementById: (id) => (id === 'root' ? rootEl : null),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const origRender = (p) => {
    delivered.push(p);
  };
  const cleanups = [];
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
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    setInterval: (fn) => {
      const id = intervals.length + 1;
      intervals.push({ id, fn });
      return id;
    },
    clearInterval: () => {},
    document: doc,
    window: null,
  };
  sandbox.window = {
    location: { protocol: 'https:' },
    __ag_render_metrics: origRender,
    __ag_watched_cascade_ids: [cidLocal],
  };
  sandbox.window.top = sandbox.window;

  const ctx = {
    config: { enabled: true, metricsMode: 'compact', contextLimit: 256000 },
    modules: { metrics: true, i18n: true },
    onCleanup: (fn) => cleanups.push(fn),
  };
  const compiled = vm.runInNewContext(`(function(ctx, boot) {\n${src}\n})`, sandbox);
  compiled(ctx, ctx);

  assert.equal(sandbox.window.__ag_render_metrics.__agRemoteMetricsWrapper, true);
  assert.equal(intervals.length, 0, 'watcher must stay idle until dbFound: false arrives');

  // Local conversation push must NOT invoke _lsClient
  sandbox.window.__ag_render_metrics({ cascadeId: cidLocal, hasData: true, dbFound: true, inlineHtml: 'local' });
  assert.equal(lsCalls, 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].inlineHtml, 'local');

  // Remote SSH conversation push triggers fallback
  sandbox.window.__ag_watched_cascade_ids = [cidRemote];
  sandbox.window.__ag_render_metrics({ cascadeId: cidRemote, hasData: false, dbFound: false });
  assert.equal(intervals.length, 1, 'watcher starts when remote cid is tracked');

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lsCalls, 2);
  const lastDelivered = delivered[delivered.length - 1];
  assert.equal(lastDelivered.__agRemoteFallback, true);
  assert.equal(lastDelivered.hasData, true);
  assert.equal(lastDelivered.dbFound, true);
  assert.ok(lastDelivered.inlineHtml.includes('100 tok/s'));

  // Subsequent daemon dbFound: false resync must NOT overwrite with hasData: false
  const countBefore = delivered.length;
  sandbox.window.__ag_render_metrics({ cascadeId: cidRemote, hasData: false, dbFound: false });
  assert.equal(delivered.length, countBefore + 1);
  assert.equal(delivered[delivered.length - 1].hasData, true);
  assert.equal(delivered[delivered.length - 1].__agRemoteFallback, true);

  // Cleanup restores original __ag_render_metrics
  cleanups.forEach((fn) => fn());
  assert.equal(sandbox.window.__ag_render_metrics, origRender);
});

test('installPlugin bundles remote-metrics.js and uninstallPlugin removes it cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-remote-install-'));
  try {
    const res = installPlugin({ targetDir: dir });
    assert.equal(res.ok, true);
    const customJs = readFileSync(join(dir, 'custom.js'), 'utf8');
    assert.ok(customJs.includes(PLUGIN_MARKER_START));
    assert.ok(customJs.includes(PLUGIN_MARKER_END));
    assert.ok(customJs.includes('__ag_teardown_quota_bar_fn'));
    assert.ok(customJs.includes('__ag_teardown_remote_metrics_fn'));

    const un = uninstallPlugin({ targetDir: dir });
    assert.equal(un.jsRemoved, true);
    const afterJs = readFileSync(join(dir, 'custom.js'), 'utf8');
    assert.equal(afterJs, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
