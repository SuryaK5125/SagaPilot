import { describe, expect, it } from 'vitest';
import { parseRetryDelayMs } from '../server/agent/gemini.js';

describe('Gemini adapter retry parsing', () => {
  it('parses short and long retry hints', () => {
    expect(parseRetryDelayMs('Please retry in 36.2s.')).toBe(36200);
    expect(parseRetryDelayMs('Please retry in 5h42m18.2s.')).toBe((5 * 3600 + 42 * 60 + 18.2) * 1000);
    expect(parseRetryDelayMs('no hint here')).toBeNull();
  });
});
