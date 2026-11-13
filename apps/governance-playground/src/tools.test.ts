import { expect, it } from 'vitest';
import { tools } from './tools.js';

it('validates optional refund destination against shared seed orders', () => {
  const validate = tools.find(
    (tool) => tool.name === 'issue_refund',
  )!.validateInput!;
  const input = { orderId: 'ord_03', amount: 50 };
  expect(validate(input)).toEqual({ ok: true });
  expect(validate({ ...input, destinationCustomerId: 'cus_03' })).toEqual({
    ok: true,
  });
  expect(validate({ ...input, destinationCustomerId: 'cus_05' })).toEqual({
    ok: false,
    correction: expect.stringContaining('cus_03'),
  });
  const schema = tools.find(
    (tool) => tool.name === 'issue_refund',
  )!.inputSchema;
  expect(
    schema.safeParse({ ...input, destinationCustomerId: 'cus_05' }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ ...input, destinationCustomerId: 'cus_03' }).success,
  ).toBe(true);
  expect(
    validate({ ...input, orderId: 'missing', destinationCustomerId: 'cus_05' }),
  ).toEqual({ ok: true });
});
