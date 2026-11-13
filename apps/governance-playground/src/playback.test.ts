import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { expect, it } from 'vitest';

it('continues updated evidence without replaying completed calls', async () => {
  const html = readFileSync(
    new URL('./feed-page.html', import.meta.url),
    'utf8',
  );
  const script = html.split('<script>')[1]!.split('</script>')[0]!;
  const nodes = new Map();
  const node = () => ({
    children: [] as unknown[],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    replaceChildren(...children: unknown[]) {
      this.children = children;
    },
    append(child: unknown) {
      this.children.push(child);
    },
    animate() {
      return { finished: Promise.resolve() };
    },
  });
  const context = {
    document: {
      querySelector(selector: string) {
        if (!nodes.has(selector)) nodes.set(selector, node());
        return nodes.get(selector);
      },
      querySelectorAll() {
        return [];
      },
      createElement: node,
    },
    matchMedia: () => ({ matches: true }),
    setTimeout: (resolve: () => void) => resolve(),
  };
  const source = script.slice(0, script.indexOf('      refresh();'));
  const run = (code: string) => runInNewContext(source + code, context);
  await run(`
    renderStage = () => {};
    currentCase = { invocationId: '1', status: 'running', orders: [{ orderId: 'ord_01', status: 'REFUNDED' }], chips: [], judge: ['Executed: issue_refund ord_01.'] };
    (async () => {
      await playCase(currentCase);
      currentCase.judge.push('Executed: issue_refund ord_02.');
      await playCase(currentCase, false);
      await playCase(currentCase, false);
      currentCase.judge.push('Executed: issue_refund ord_03.');
      await playCase(currentCase, false);
    })();
  `);
  expect(nodes.get('#record-lines').children).toHaveLength(3);
});
