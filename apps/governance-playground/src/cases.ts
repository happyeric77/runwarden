export interface CaseEvent {
  at: Date;
  kind: string;
  invocationId: string;
  tool: string | null;
  rule: string | null;
  decision: string | null;
  status: string | null;
  snapshot: unknown;
}

export function buildCases(events: CaseEvent[]) {
  const groups = new Map<string, CaseEvent[]>();
  for (const event of events) {
    const group = groups.get(event.invocationId) ?? [];
    group.push(event);
    groups.set(event.invocationId, group);
  }
  return [...groups.entries()]
    .map(([invocationId, rawEvents]) => {
      const invocation = rawEvents.find((event) => event.kind === 'invocation');
      const orders = new Map<
        string,
        { orderId: string; amount: number | null; status: string }
      >();
      const chips: string[] = [];
      const judge: string[] = [];
      for (let i = 0; i < rawEvents.length; i++) {
        const event = rawEvents[i]!;
        if (event.kind === 'decision' && event.tool)
          chips.push(`${event.tool}: ${event.decision}`);
        if (event.kind === 'audit' && event.tool)
          chips.push(`${event.tool}: ${event.status}`);
        if (
          event.kind === 'decision' &&
          event.rule === 'exactly_one' &&
          event.decision === 'deny'
        ) {
          // ponytail: no step IDs; group matching denies until an audit, even if correction writes interleave.
          const start =
            rawEvents
              .slice(0, i)
              .map((item) => item.kind)
              .lastIndexOf('audit') + 1;
          const end = rawEvents.findIndex(
            (item, index) => index > i && item.kind === 'audit',
          );
          const segment = rawEvents.slice(start, end < 0 ? undefined : end);
          const denies = segment.filter(
            (item) =>
              item.kind === 'decision' &&
              item.rule === 'exactly_one' &&
              item.decision === 'deny' &&
              item.tool === event.tool,
          );
          if (
            !rawEvents
              .slice(start, i)
              .some(
                (item) =>
                  item.kind === 'decision' &&
                  item.rule === 'exactly_one' &&
                  item.decision === 'deny' &&
                  item.tool === event.tool,
              )
          )
            judge.push(
              `Agent tried ${denies.length} tool calls in one step. Denied.`,
            );
        } else if (
          event.kind === 'decision' &&
          event.rule === 'exactly_one' &&
          event.decision === 'correction_issued'
        ) {
          judge.push('Correction issued. Retry one by one.');
        }
        if (event.kind === 'audit' && event.tool === 'issue_refund') {
          const input =
            event.snapshot && typeof event.snapshot === 'object'
              ? (event.snapshot as Record<string, unknown>)
              : {};
          const orderId =
            typeof input.orderId === 'string' ? input.orderId : '';
          const amount = typeof input.amount === 'number' ? input.amount : null;
          if (orderId) {
            const previous = orders.get(orderId);
            orders.set(orderId, {
              orderId,
              amount: amount ?? previous?.amount ?? null,
              status:
                event.status === 'succeeded' || previous?.status === 'REFUNDED'
                  ? 'REFUNDED'
                  : 'PLACED',
            });
          }
          if (event.status === 'succeeded')
            judge.push(
              `Executed: issue_refund${orderId ? ` ${orderId}` : ''}.`,
            );
        }
      }
      if (invocation?.status === 'succeeded') {
        const audits = rawEvents.filter((event) => event.kind === 'audit');
        const refunds = audits.filter(
          (event) =>
            event.tool === 'issue_refund' && event.status === 'succeeded',
        ).length;
        judge.push(
          `Case closed: ${refunds} refunds, ${audits.length} audit rows.`,
        );
      }
      return {
        invocationId,
        startedAt: invocation?.at ?? rawEvents[0]!.at,
        status: invocation?.status ?? null,
        orders: [...orders.values()],
        chips,
        judge,
        events: rawEvents,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
}
