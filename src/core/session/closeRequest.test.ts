import { describe, expect, it } from 'vitest';
import { answerCloseRequest } from './closeRequest';

describe('closeRequest', () => {
  describe('answerCloseRequest', () => {
    it('asks with the background command count the main process sent', () => {
      expect(answerCloseRequest({ backgroundCommandCount: 3 }, 'ask')).toEqual({ kind: 'ask', backgroundCommandCount: 3 });
      expect(answerCloseRequest({ backgroundCommandCount: 0 }, 'ask')).toEqual({ kind: 'ask', backgroundCommandCount: 0 });
    });

    it('quits or minimizes without asking under those settings', () => {
      expect(answerCloseRequest({ backgroundCommandCount: 2 }, 'quit')).toEqual({ kind: 'quit' });
      expect(answerCloseRequest({ backgroundCommandCount: 2 }, 'minimize')).toEqual({ kind: 'minimize' });
    });
  });
});
