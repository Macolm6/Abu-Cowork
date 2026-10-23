import { describe, expect, it } from 'vitest';
import { charsOmittedMarker } from '@/core/context/truncation';
import { webFetchView } from './webFetchView';

describe('webFetchView', () => {
  it('reads the status and the body by position', () => {
    const view = webFetchView('HTTP 200 OK\n\nhello', { status: 200, statusText: 'OK', body: [13, 18], truncated: false });
    expect(view.status).toEqual({ code: 200, text: 'OK' });
    expect(view.truncated).toBe(false);
    expect(view.body).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('shows only the number when the status text is empty', () => {
    const view = webFetchView('HTTP 599 \n\nbody', { status: 599, statusText: '', body: [11, 15], truncated: false });
    expect(view.status).toEqual({ code: 599, text: '' });
    expect(view.body).toEqual([{ kind: 'text', text: 'body' }]);
  });

  it('turns the omission line in the body into its note row', () => {
    const body = `<html>\n<head>\n\n${charsOmittedMarker(56000)}\n\n</body>\n</html>`;
    const statusLine = 'HTTP 200 OK\n\n';
    const view = webFetchView(`${statusLine}${body}`, {
      status: 200, statusText: 'OK', body: [statusLine.length, statusLine.length + body.length], truncated: true,
    });
    expect(view.truncated).toBe(true);
    expect(view.body).toEqual([
      { kind: 'text', text: '<html>' },
      { kind: 'text', text: '<head>' },
      { kind: 'note', note: 'charsNotRead', count: 56000 },
      { kind: 'text', text: '</body>' },
      { kind: 'text', text: '</html>' },
    ]);
  });

  it('shows the whole text without a record', () => {
    const view = webFetchView('HTTP 404 Not Found\n\nmissing', undefined);
    expect(view.status).toBeNull();
    expect(view.truncated).toBe(false);
    expect(view.body).toEqual([
      { kind: 'text', text: 'HTTP 404 Not Found' },
      { kind: 'text', text: '' },
      { kind: 'text', text: 'missing' },
    ]);
  });
});
