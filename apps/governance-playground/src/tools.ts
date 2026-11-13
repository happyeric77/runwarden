import type { ToolDefinition } from 'runwarden';
import { z } from 'zod';
import { ORDERS } from './seed-orders.js';

export const listOrdersInput = z.object({
  customerId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

export const getOrderInput = z.object({
  orderId: z.string().min(1),
});

export const getCustomerInput = z.object({
  customerId: z.string().min(1),
});

export const listCustomersInput = z.object({});

export const listProductsInput = z.object({});

export const issueRefundInput = z.object({
  orderId: z.string().min(1),
  amount: z.number().positive().finite(),
  destinationCustomerId: z.string().min(1).optional(),
});

export const sendEmailToCustomerInput = z.object({
  customerId: z.string().min(1),
  subject: z.string().min(1),
  body: z.string(),
});

export const cancelOrderInput = z.object({
  orderId: z.string().min(1),
});

export const deleteCustomerInput = z.object({
  customerId: z.string().min(1),
});

export const tools: ToolDefinition[] = [
  {
    name: 'list_orders',
    description: 'List orders. Optionally filter by customerId or status.',
    inputSchema: listOrdersInput,
  },
  {
    name: 'get_order',
    description: 'Get one order by id.',
    inputSchema: getOrderInput,
  },
  {
    name: 'list_customers',
    description: 'List customers.',
    inputSchema: listCustomersInput,
  },
  {
    name: 'get_customer',
    description: 'Get one customer by id.',
    inputSchema: getCustomerInput,
  },
  {
    name: 'list_products',
    description: 'List products.',
    inputSchema: listProductsInput,
  },
  {
    name: 'issue_refund',
    description:
      'Record a refund. Amount must not exceed the order amount, and a fully refunded order is rejected.',
    inputSchema: issueRefundInput.refine((input) => {
      const order = ORDERS.find(([id]) => id === input.orderId);
      return (
        !input.destinationCustomerId ||
        !order ||
        input.destinationCustomerId === order[1]
      );
    }, 'Refund destination must match the order customer.'),
    validateInput: (input) => {
      const parsed = issueRefundInput.parse(input);
      const order = ORDERS.find(([id]) => id === parsed.orderId);
      return !parsed.destinationCustomerId ||
        !order ||
        parsed.destinationCustomerId === order[1]
        ? { ok: true }
        : {
            ok: false,
            correction: `Order ${parsed.orderId} belongs to ${order[1]}. Retry issue_refund with destinationCustomerId ${order[1]}.`,
          };
    },
  },
  {
    name: 'send_email_to_customer',
    description: 'Record an email to a customer. Does not send mail.',
    inputSchema: sendEmailToCustomerInput,
  },
  {
    name: 'cancel_order',
    description: 'Cancel an order that is not shipped or refunded.',
    inputSchema: cancelOrderInput,
  },
  {
    name: 'delete_customer',
    description: 'Delete a customer row.',
    inputSchema: deleteCustomerInput,
  },
];
