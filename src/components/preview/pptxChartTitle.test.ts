// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getInstanceByDom } from 'echarts';
import JSZip from 'jszip';
import { init } from 'pptx-preview';

// Made with python-pptx: four slides, one chart each, in this order — a clustered column,
// a pie and a line chart with `chart.has_title = False`, then a clustered column titled
// "Quarterly revenue". The series of every chart is named "Revenue".
const FIXTURE_PATH = path.resolve(__dirname, '__fixtures__/chart-titles.pptx');

function readFixture(): ArrayBuffer {
  const bytes = fs.readFileSync(FIXTURE_PATH);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** The title option of each chart the renderer drew, in slide order. */
async function renderedChartTitles(): Promise<unknown[]> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const previewer = init(container, { width: 960, height: 540, mode: 'list' });
  await previewer.preview(readFixture());
  // The renderer creates each chart's echarts instance in a zero-delay timeout.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const charts = Array.from(container.querySelectorAll<HTMLElement>('.chart-node'));
  const titles = charts.map((el) => {
    const instance = getInstanceByDom(el);
    if (!instance) throw new Error('chart node has no echarts instance');
    return (instance.getOption() as { title?: unknown }).title;
  });
  previewer.destroy();
  return titles;
}

function shownTitleTexts(title: unknown): string[] {
  const entries = (Array.isArray(title) ? title : [title]) as Array<{ show?: boolean; text?: string }>;
  return entries.filter((entry) => entry.show !== false && entry.text).map((entry) => entry.text as string);
}

describe('pptx chart titles', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('the fixture marks the three untitled charts autoTitleDeleted=1', async () => {
    const zip = await JSZip.loadAsync(readFixture());
    const flags = await Promise.all([1, 2, 3, 4].map(async (n) => {
      const xml = await zip.file(`ppt/charts/chart${n}.xml`)!.async('string');
      return { autoTitleDeleted: /<c:autoTitleDeleted val="1"\/>/.test(xml), hasTitle: xml.includes('<c:title>') };
    }));
    expect(flags).toEqual([
      { autoTitleDeleted: true, hasTitle: false },
      { autoTitleDeleted: true, hasTitle: false },
      { autoTitleDeleted: true, hasTitle: false },
      { autoTitleDeleted: false, hasTitle: true },
    ]);
  });

  it('draws no title on a chart whose title was deleted, and the authored title on the one that has it', async () => {
    const titles = await renderedChartTitles();

    expect(titles).toHaveLength(4);
    expect(shownTitleTexts(titles[0])).toEqual([]);
    expect(shownTitleTexts(titles[1])).toEqual([]);
    expect(shownTitleTexts(titles[2])).toEqual([]);
    expect(shownTitleTexts(titles[3])).toEqual(['Quarterly revenue']);
  });
});
