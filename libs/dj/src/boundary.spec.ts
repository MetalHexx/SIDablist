import { describe, expect, it } from 'vitest';
import * as main from './index.js';
import { Rig } from './testing/harness.js';

// The static guard is `tsconfig.main.json` (no DOM lib, no `browser/`). This is the run-time half:
// under plain Node, with no `window`, `document` or `Worker`, the main path loads and plays a deck
// on the inline heavy work. `navigator` is not asserted absent: Node defines one.
describe('the main path with no browser global', () => {
  it('loads and plays a deck on inline heavy work', async () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof Worker).toBe('undefined');
    expect(main.createDj).toBeTypeOf('function');
    expect(main.createInlineHeavyWork).toBeTypeOf('function');
    expect(Object.keys(main)).not.toContain('createBrowserWake');

    const rig = new Rig();
    rig.addDeck('a');
    await rig.load('a', 'still-time', { ends: 'playing' });
    rig.advance(200);

    expect(rig.frames('a').length).toBeGreaterThan(0);
    expect(rig.ofKind('update').length).toBeGreaterThan(0);
    rig.dispose();
  });
});
