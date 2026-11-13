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
    const originalRenderStage = renderStage;
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
  runInNewContext(
    `originalRenderStage({ orders: [], chips: [], judge: ['Wrong account. Denied before it ran.'] });`,
    context,
  );
  expect(nodes.get('#denied-stamp').hidden).toBe(false);
  runInNewContext(
    `originalRenderStage({ orders: [], chips: [], judge: ['Wrong account. Denied before it ran.', 'Executed: issue_refund ord_03.'] });`,
    context,
  );
  expect(nodes.get('#denied-stamp').hidden).toBe(true);
  await runInNewContext(
    `
    playCase = () => Promise.resolve();
    allCases = [
      { invocationId: '2', scenario: 'refund-wrong-account', status: 'running', events: [] },
      { invocationId: '1', scenario: 'refund-three', status: 'succeeded', events: [] }
    ];
    selectCase();
    if (currentCase.invocationId !== '2') throw Error('latest not selected');
    selectedMission = 'refund-three'; selectCase();
    allCases.unshift({ invocationId: '3', scenario: 'ask', status: 'failed', events: [] });
    selectCase();
    if (currentCase.invocationId !== '1') throw Error('selection stolen');
    selectedMission = 'email-claim'; selectCase();
    if (currentCase !== undefined) throw Error('empty mission retained case');
    selectedMission = null; selectCase();
    if (currentCase.invocationId !== '3') throw Error('follow not restored');
  `,
    context,
  );
});
