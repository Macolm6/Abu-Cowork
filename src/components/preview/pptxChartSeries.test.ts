// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getInstanceByDom } from 'echarts';
import JSZip from 'jszip';
import { init } from 'pptx-preview';

// The deck of pptxChartTitle.test.ts: a column, a pie, a line and a titled column chart, one
// series of four points each (12, 18, 15, 22). python-pptx writes no fill on a series or a data
// point, so PowerPoint colors them from the theme: series n (and pie point n) takes accentN+1.
const FIXTURE_PATH = path.resolve(__dirname, '__fixtures__/chart-titles.pptx');

// accent1..accent4 of the fixture's Office theme (4F81BD, C0504D, 9BBB59, 8064A2).
const ACCENT1 = 'rgba(79,129,189,1)';
const ACCENT2 = 'rgba(192,80,77,1)';
const ACCENT3 = 'rgba(155,187,89,1)';
const ACCENT4 = 'rgba(128,100,162,1)';
const RED = 'rgba(255,0,0,1)';

const RED_FILL = '<c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr>';

interface ChartOption {
  series: Array<{ type: string; data: unknown[] }>;
  color: string[];
}

function readFixture(): Buffer {
  return fs.readFileSync(FIXTURE_PATH);
}

/** The fixture with an explicit red fill on the column series and on the pie's third point. */
async function fixtureWithExplicitFills(): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(readFixture());
  const column = await zip.file('ppt/charts/chart1.xml')!.async('string');
  const pie = await zip.file('ppt/charts/chart2.xml')!.async('string');
  expect(column).toContain('</c:tx><c:cat>');
  expect(pie).toContain('</c:tx><c:cat>');
  zip.file('ppt/charts/chart1.xml', column.replace('</c:tx><c:cat>', `</c:tx>${RED_FILL}<c:cat>`));
  zip.file('ppt/charts/chart2.xml', pie.replace('</c:tx><c:cat>', `</c:tx><c:dPt><c:idx val="2"/>${RED_FILL}</c:dPt><c:cat>`));
  return zip.generateAsync({ type: 'arraybuffer' });
}

async function renderedChartOptions(deck: ArrayBuffer): Promise<ChartOption[]> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const previewer = init(container, { width: 960, height: 540, mode: 'list' });
  await previewer.preview(deck);
  // The renderer creates each chart's echarts instance in a zero-delay timeout.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const options = Array.from(container.querySelectorAll<HTMLElement>('.chart-node')).map((el) => {
    const instance = getInstanceByDom(el);
    if (!instance) throw new Error('chart node has no echarts instance');
    return instance.getOption() as unknown as ChartOption;
  });
  previewer.destroy();
  return options;
}

describe('pptx chart series', () => {
  let themeFilled: ChartOption[];
  let explicitlyFilled: ChartOption[];

  // Rendering loads echarts and the library cold, which takes seconds: both decks are rendered
  // under the hook timeout (TESTING.md, "Heavy module loading belongs in beforeAll").
  beforeAll(async () => {
    const bytes = readFixture();
    themeFilled = await renderedChartOptions(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    document.body.innerHTML = '';
    explicitlyFilled = await renderedChartOptions(await fixtureWithExplicitFills());
    document.body.innerHTML = '';
  });

  it('draws the series of charts whose fills are left to the theme, in the theme accent colors', () => {
    const options = themeFilled;

    expect(options.map((option) => option.series.map((series) => series.type))).toEqual([['bar'], ['pie'], ['line'], ['bar']]);
    expect(options[0].series[0].data).toEqual([12, 18, 15, 22]);
    expect(options[1].series[0].data).toEqual([
      { name: 'Q1', value: 12 },
      { name: 'Q2', value: 18 },
      { name: 'Q3', value: 15 },
      { name: 'Q4', value: 22 },
    ]);
    expect(options[2].series[0].data).toEqual([12, 18, 15, 22]);
    expect(options[3].series[0].data).toEqual([12, 18, 15, 22]);

    expect(options.map((option) => option.color)).toEqual([
      [ACCENT1],
      [ACCENT1, ACCENT2, ACCENT3, ACCENT4],
      [ACCENT1],
      [ACCENT1],
    ]);
  });

  it('keeps an explicit fill on a series and on a pie data point', () => {
    const options = explicitlyFilled;

    expect(options[0].color).toEqual([RED]);
    expect(options[1].color).toEqual([ACCENT1, ACCENT2, RED, ACCENT4]);
    expect(options[1].series[0].data).toHaveLength(4);
  });
});
