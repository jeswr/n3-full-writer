import { jest } from '@jest/globals';

describe('Loading with an unsupported version of N3.js', () => {
  it('should fail when the Writer lacks the members this package builds on', async () => {
    jest.unstable_mockModule('n3', () => ({
      Term: class { constructor(id) { this.id = id; } },
      Writer: class { constructor() { this._outputStream = {}; this._endStream = true; } },
    }));
    await expect(import('../src/n3.js')).rejects.toThrow('n3-full-writer does not support this version of n3');
  });
});
