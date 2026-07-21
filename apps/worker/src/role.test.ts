import { describe, expect, it } from 'vitest';

import type { WorkerConfig, WorkerRole } from './config';
import { consumersForRole, RoleBootstrap, type ConsumerToken } from './role';

describe('consumersForRole (role isolation IS the point: downloads never interrupt live capture)', () => {
  it('archive registers the job:control subscriber', () => {
    expect(consumersForRole('archive')).toContain('job:control-subscriber');
  });

  it('archive registers the BullMQ enumerate consumer (P5)', () => {
    expect(consumersForRole('archive')).toContain('bullmq:enumerate');
  });

  it('archive registers the BullMQ download + verify consumers (P6)', () => {
    expect(consumersForRole('archive')).toContain('bullmq:download');
    expect(consumersForRole('archive')).toContain('bullmq:verify');
  });

  it('archive registers the CR-20 completeness re-check sweep scheduler', () => {
    expect(consumersForRole('archive')).toContain('bullmq:completeness-scan');
  });

  it('live registers the control subscriber + live-scan/probe/capture consumers (P10)', () => {
    const live = consumersForRole('live');
    // The control subscriber must run here too: a cancel aimed at a RUNNING
    // live capture arrives over the same job:control channel.
    expect(live).toContain('job:control-subscriber');
    expect(live).toContain('bullmq:live-scan');
    expect(live).toContain('bullmq:live-probe');
    expect(live).toContain('bullmq:live-capture');
  });

  it('ROLE ISOLATION PIN: live never consumes the archive queues…', () => {
    const live = consumersForRole('live');
    for (const archiveOnly of ['bullmq:download', 'bullmq:verify', 'bullmq:enumerate']) {
      expect(live).not.toContain(archiveOnly);
    }
  });

  it('…and archive never consumes the live queues (single replica per role, PLAN.md)', () => {
    const archive = consumersForRole('archive');
    for (const liveOnly of ['bullmq:live-scan', 'bullmq:live-probe', 'bullmq:live-capture']) {
      expect(archive).not.toContain(liveOnly);
    }
  });
});

// ---------------------------------------------------------------------------
// TABLE-DRIVEN WIRING (the audit fix): the bootstrap must ITERATE
// consumersForRole — the table above is the single start source, so a
// live-branch typo can no longer silently start archive consumers next to a
// live capture. These tests pin the WIRING, not the banner.
// ---------------------------------------------------------------------------

interface WiringHarness {
  bootstrap: RoleBootstrap;
  /** Every observable action, in call order: 'reconcile:<role>' | 'start:<token>'. */
  order: string[];
}

function harness(role: WorkerRole): WiringHarness {
  const order: string[] = [];
  const starts = (name: ConsumerToken): { start: () => void } => ({
    start: () => {
      order.push(`start:${name}`);
    },
  });
  const startsAsync = (name: ConsumerToken): { start: () => Promise<void> } => ({
    start: async () => {
      order.push(`start:${name}`);
    },
  });
  const reconciles = (name: string): { run: () => Promise<void> } => ({
    run: async () => {
      order.push(`reconcile:${name}`);
    },
  });
  const bootstrap = new RoleBootstrap(
    { role } as WorkerConfig,
    startsAsync('job:control-subscriber') as never,
    starts('bullmq:enumerate') as never,
    starts('bullmq:download') as never,
    starts('bullmq:verify') as never,
    reconciles('archive') as never,
    startsAsync('bullmq:reenumerate-scan') as never,
    startsAsync('bullmq:source-check-scan') as never,
    starts('bullmq:source-check') as never,
    startsAsync('bullmq:completeness-scan') as never,
    reconciles('live') as never,
    startsAsync('bullmq:live-scan') as never,
    starts('bullmq:live-probe') as never,
    starts('bullmq:live-capture') as never,
  );
  return { bootstrap, order };
}

describe('RoleBootstrap wiring (table-driven — consumersForRole is the single start source)', () => {
  it('starts EXACTLY the table’s consumers, in table order, for each role', async () => {
    for (const role of ['archive', 'live'] as const) {
      const { bootstrap, order } = harness(role);
      await bootstrap.onApplicationBootstrap();
      expect(
        order.filter((entry) => entry.startsWith('start:')),
        `role=${role} must start exactly its table`,
      ).toEqual(consumersForRole(role).map((token) => `start:${token}`));
    }
  });

  it('runs the role’s OWN reconciler (and only that one) BEFORE any consumer starts', async () => {
    for (const role of ['archive', 'live'] as const) {
      const { bootstrap, order } = harness(role);
      await bootstrap.onApplicationBootstrap();
      expect(order.filter((entry) => entry.startsWith('reconcile:'))).toEqual([
        `reconcile:${role}`,
      ]);
      expect(order[0]).toBe(`reconcile:${role}`);
    }
  });

  it('startConsumer is exhaustive over every table token (a typo cannot compile)', async () => {
    const { bootstrap, order } = harness('archive');
    for (const token of [...consumersForRole('archive'), ...consumersForRole('live')]) {
      await bootstrap.startConsumer(token);
    }
    expect(new Set(order).size).toBe(11); // every token has a real starter
  });
});
