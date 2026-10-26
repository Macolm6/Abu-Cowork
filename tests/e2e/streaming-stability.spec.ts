/**
 * Real-Electron acceptance for a reply that streams in: the live message
 * group's avatar column keeps still or moves up with the text, the status
 * line moves down at most once (when 「处理中」 appears above it at its full
 * height), and the view stays at the bottom in every frame.
 *
 * Every frame is sampled in a MessageChannel callback posted from
 * requestAnimationFrame, which runs after the frame is painted.
 *
 * Deterministic per TESTING.md: a loopback mock streams the reply in many
 * small chunks on a timer.
 */
import { expect, test } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, classifyMockRequestPurpose } from './openAiMock';

const CHUNK_MS = 30;
const REASONING_CHUNKS = 20;
const TEXT_CHUNKS = 120;

interface LiveSample {
  t: number;
  scrollTop: number;
  scrollHeight: number;
  distanceToBottom: number;
  /** The live row's top, from the top of the viewport. */
  rowTop: number | null;
  /** The avatar column's top, from the top of the viewport. */
  avatarTop: number | null;
  /** The status line's top ("思考中", the step list header), from the top of the viewport. */
  statusTop: number | null;
  /** Names of the animations and transitions running inside the live row. */
  animations: string[];
  /** The reply's last words have arrived: the run is ending and its work process folds. */
  ended: boolean;
}

function sseDelta(delta: Record<string, string>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-streaming-stability',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'abu-streaming-stability-e2e',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function startStreamingMock(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const activeResponses = new Set<ServerResponse>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));
    let body = '';
    for await (const chunk of req) body += String(chunk);
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected route' }));
      return;
    }
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    const parsed = JSON.parse(body) as { messages?: { role: string; content: unknown }[] };
    if (classifyMockRequestPurpose(parsed) !== 'task') {
      res.write(sseDelta({ content: '[]' }));
      res.write(sseDelta({}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }
    const pieces = [
      ...Array.from({ length: REASONING_CHUNKS }, (_, i) => ({ reasoning_content: `先想第 ${i + 1} 点，` })),
      ...Array.from({ length: TEXT_CHUNKS }, (_, i) => ({ content: `这是第 ${i + 1} 段文字，一句一句地到。${i % 7 === 6 ? '\n\n' : ''}` })),
    ];
    let index = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (index < pieces.length) {
        res.write(sseDelta(pieces[index]));
        index += 1;
        const timer = setTimeout(() => { timers.delete(timer); tick(); }, CHUNK_MS);
        timers.add(timer);
        return;
      }
      res.write(sseDelta({ content: 'STREAM_DONE' }));
      res.write(sseDelta({}, 'stop'));
      res.end('data: [DONE]\n\n');
    };
    tick();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback mock did not bind a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      for (const response of activeResponses) response.destroy();
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: { baseUrl: string; close: () => Promise<void> } | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
  if (mock) await mock.close();
  mock = undefined;
});

test('while a reply streams in, the avatar never moves down and the status line steps down at most once', async () => {
  test.setTimeout(180_000);
  mock = await startStreamingMock();
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER).first()).toBeVisible({ timeout: READY_TIMEOUT });
  await configureLocalMockProvider(page, mock.baseUrl, {
    contextWindowSize: 200_000,
    maxOutputTokens: 8_192,
    modelId: 'abu-streaming-stability-e2e',
    supportsReasoning: true,
  });

  const input = page.getByPlaceholder(CHAT_PLACEHOLDER).first();
  await input.fill('STREAM_TEST 请慢慢回答');
  await page.evaluate(() => {
    const samples: LiveSample[] = [];
    (window as Window & { __liveSamples?: LiveSample[] }).__liveSamples = samples;
    const t0 = performance.now();
    const measure = (): LiveSample | null => {
      const scroller = document.querySelector<HTMLElement>('[data-chat-scroll-content]')?.parentElement ?? null;
      const list = document.querySelector('[data-testid="chat-message-list"]');
      if (!scroller || !list) return null;
      const view = scroller.getBoundingClientRect();
      const rows = [...list.querySelectorAll<HTMLElement>(':scope > [data-index]')];
      const row = rows.reduce<HTMLElement | null>((last, candidate) => (
        last === null || Number(candidate.dataset.index) > Number(last.dataset.index) ? candidate : last
      ), null);
      const top = (element: Element | null | undefined) => (
        element ? Math.round((element.getBoundingClientRect().top - view.top) * 100) / 100 : null
      );
      return {
        t: Math.round(performance.now() - t0),
        scrollTop: Math.round(scroller.scrollTop * 100) / 100,
        scrollHeight: scroller.scrollHeight,
        distanceToBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
        rowTop: top(row),
        avatarTop: top(row?.querySelector('.shrink-0.mt-0\\.5 > *')),
        statusTop: top(row?.querySelector('.task-block > button, .task-block')),
        animations: [...new Set(document.getAnimations()
          .filter((animation) => animation.playState === 'running'
            && animation.effect instanceof KeyframeEffect
            && animation.effect.target instanceof Element
            && row?.contains(animation.effect.target))
          .map((animation) => (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? 'animation'))],
        ended: (row?.textContent ?? '').includes('STREAM_DONE'),
      };
    };
    let stop = false;
    (window as Window & { __stopLiveSamples?: () => void }).__stopLiveSamples = () => { stop = true; };
    const frame = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const sample = measure();
        if (sample) samples.push(sample);
      };
      channel.port2.postMessage(0);
      if (!stop) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.keyboard.press('Enter');
  await expect(page.getByText('STREAM_DONE')).toBeVisible({ timeout: READY_TIMEOUT });
  await page.waitForTimeout(800);
  await page.evaluate(() => { (window as Window & { __stopLiveSamples?: () => void }).__stopLiveSamples?.(); });
  const samples = await page.evaluate(() => (window as Window & { __liveSamples?: LiveSample[] }).__liveSamples ?? []);

  // Each painted frame, while the reply streams, in which a part of the live
  // row moved down. The fold that closes the work process at the end of the
  // run shortens the row, and a reader kept at the bottom sees what is above
  // it come down; that is the end of the run, not the reply streaming.
  const streaming = samples.filter((sample) => !sample.ended);
  expect(streaming.length).toBeGreaterThan(60);
  const downward: Record<'avatarTop' | 'statusTop' | 'rowTop', string[]> = { avatarTop: [], statusTop: [], rowTop: [] };
  for (let i = 1; i < streaming.length; i += 1) {
    const before = streaming[i - 1];
    const after = streaming[i];
    for (const key of ['avatarTop', 'statusTop', 'rowTop'] as const) {
      const from = before[key];
      const to = after[key];
      if (from === null || to === null || to <= from) continue;
      downward[key].push(`${after.t}ms ${key} ${from}->${to} st ${before.scrollTop}->${after.scrollTop} sh ${before.scrollHeight}->${after.scrollHeight} anim=${after.animations.join(',')}`);
    }
  }
  const offBottom = samples.filter((sample) => sample.distanceToBottom > 2).map((sample) => `${sample.t}ms ${sample.distanceToBottom}px`);
  expect(offBottom, offBottom.join('\n')).toEqual([]);
  // The avatar and the row start never move down.
  expect(downward.avatarTop, downward.avatarTop.join('\n')).toEqual([]);
  expect(downward.rowTop, downward.rowTop.join('\n')).toEqual([]);
  // The status line moves down once, by one row, when 「处理中」 appears above
  // it at its full height; it is never pushed down over several frames.
  expect(downward.statusTop.length, downward.statusTop.join('\n')).toBeLessThanOrEqual(1);
});
