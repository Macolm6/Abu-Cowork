/**
 * Real Electron + sidecar coverage for what a later turn can see of an image
 * tool result: after `read_file` returns a PNG, a follow-up question in the
 * same conversation must reach the model with that image in its history, and
 * the conversation ledger must keep the image block (as a snapshot reference)
 * rather than a note claiming the result was left out.
 *
 * The provider is a loopback-only OpenAI-compatible SSE server: no real
 * credential or network endpoint is involved. The PNG is produced by the app
 * window's own canvas encoder.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  startOpenAiMock,
  taskRequests,
  waitForApp,
  type OpenAiMock,
} from './openAiMock';

const PROVIDER_OPTIONS = {
  permissionMode: 'standard',
  supportsReasoning: null,
  supportsTools: true,
} as const;
const OMITTED_NOTE = '[Rich tool result omitted from durable history to stay within the storage budget]';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

test.afterEach(async () => {
  if (app) {
    await closeAbuElectron(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (dataRoot) {
    removeElectronDataRoot(dataRoot);
    dataRoot = undefined;
  }
});

/** A 1280x720 PNG with a noisy upper band, encoded by the app window's canvas. */
async function writeProbeImage(page: Page, target: string): Promise<number> {
  const dataUrl = await page.evaluate(() => {
    const width = 1280;
    const height = 720;
    const noiseRows = 365;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas 2d context unavailable');
    const image = context.createImageData(width, height);
    const noiseBytes = width * noiseRows * 4;
    // crypto.getRandomValues caps one call at 65536 bytes.
    for (let offset = 0; offset < noiseBytes; offset += 65_536) {
      crypto.getRandomValues(image.data.subarray(offset, Math.min(offset + 65_536, noiseBytes)));
    }
    for (let y = noiseRows; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        image.data[index] = Math.floor((x / width) * 255);
        image.data[index + 1] = Math.floor((y / height) * 255);
        image.data[index + 2] = 128;
        image.data[index + 3] = 255;
      }
    }
    for (let offset = 3; offset < noiseBytes; offset += 4) image.data[offset] = 255;
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  });
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  return fs.statSync(target).size;
}

/** Runtime event names the main process currently holds for this launch. */
async function runtimeEventNames(page: Page): Promise<string[]> {
  const diagnostics = await page.evaluate(async () => {
    const shell = (window as unknown as {
      __ABU_SHELL__: { getRuntimeDiagnostics: () => Promise<{ recentEventLines: string[] }> };
    }).__ABU_SHELL__;
    return shell.getRuntimeDiagnostics();
  });
  return diagnostics.recentEventLines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { event?: unknown };
      return typeof event.event === 'string' ? [event.event] : [];
    } catch {
      return [];
    }
  });
}

async function waitForCompletedRuns(page: Page, count: number): Promise<void> {
  await expect.poll(
    async () => (await runtimeEventNames(page)).filter((name) => name === 'renderer.agent_run_completed').length,
    { timeout: READY_TIMEOUT },
  ).toBeGreaterThanOrEqual(count);
}

function findLedgerFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...findLedgerFiles(full));
    else if (entry.name === 'messages.jsonl') found.push(full);
  }
  return found;
}

interface LedgerImageBlock {
  type?: string;
  source?: { data?: string };
  outputRef?: { relPath?: string };
}

interface LedgerToolCall {
  name?: string;
  result?: string;
  resultContent?: LedgerImageBlock[];
}

/** The last ledger revision of the message carrying the read_file call. */
function lastReadFileRevision(appDataDir: string): { result: string; blocks: LedgerImageBlock[] } | undefined {
  let found: { result: string; blocks: LedgerImageBlock[] } | undefined;
  for (const file of findLedgerFiles(appDataDir)) {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      const row = JSON.parse(raw) as { toolCalls?: LedgerToolCall[] };
      const call = row.toolCalls?.find((candidate) => candidate.name === 'read_file');
      if (call) found = { result: call.result ?? '', blocks: call.resultContent ?? [] };
    }
  }
  return found;
}

function toolMessagesOf(body: unknown): string[] {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages ?? [];
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
}

test.describe.serial('Electron image tool result in later history', () => {
  test('a same-conversation follow-up sends the image again and the ledger keeps its snapshot reference', async () => {
    test.setTimeout(180_000);
    const answer = `abu-e2e-image-answer-${randomUUID().slice(0, 8)}`;
    const followUp = `abu-e2e-image-follow-${randomUUID().slice(0, 8)}`;
    dataRoot = createElectronDataRoot();
    const imagePath = path.join(dataRoot.rootDir, `probe-${randomUUID().slice(0, 8)}.png`);
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: { path: imagePath },
        toolCallId: `call-image-${randomUUID()}`,
        toolName: 'read_file',
      },
      { kind: 'complete', responseText: answer },
      { kind: 'complete', responseText: followUp },
    ]);

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    const imageBytes = await writeProbeImage(page, imagePath);
    expect(imageBytes).toBeGreaterThan(1_000_000);
    await configureLocalMockProvider(page, mock.baseUrl, PROVIDER_OPTIONS);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(`abu-e2e-read-the-image-${randomUUID().slice(0, 8)}`);
    await input.press('Enter');
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    await waitForCompletedRuns(page, 1);
    await expect(page.getByText(answer, { exact: false }).first()).toBeVisible({ timeout: READY_TIMEOUT });

    // The turn's ledger checkpoint keeps the image as a snapshot reference.
    await expect.poll(() => {
      const revision = lastReadFileRevision(dataRoot!.appDataDir);
      return revision?.blocks.some((block) => block.type === 'image' && !!block.outputRef?.relPath) ?? false;
    }, { timeout: READY_TIMEOUT }).toBe(true);
    const revision = lastReadFileRevision(dataRoot.appDataDir);
    expect(revision?.result).not.toContain(OMITTED_NOTE);

    await input.fill(`abu-e2e-ask-about-the-image-${randomUUID().slice(0, 8)}`);
    await input.press('Enter');
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(3);
    await waitForCompletedRuns(page, 2);
    await expect(page.getByText(followUp, { exact: false }).first()).toBeVisible({ timeout: READY_TIMEOUT });

    // The follow-up's history carries the image bytes, not a note about them.
    const followUpBody = JSON.stringify(taskRequests(mock)[2].body);
    expect(followUpBody).toContain('data:image/png;base64,');
    expect(followUpBody).not.toContain(OMITTED_NOTE);
    expect(toolMessagesOf(taskRequests(mock)[2].body).join('\n')).not.toContain(OMITTED_NOTE);
  });
});
