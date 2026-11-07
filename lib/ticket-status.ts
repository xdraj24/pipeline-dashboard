import type { Stage } from './state.ts';

export type TicketStatus = 'merged' | 'approved' | 'blocked' | 'attention' | 'review' | 'progress' | 'todo';

const stageState = (stages: Stage[], key: string) => stages.find((s) => s.key === key)?.state ?? 'pending';

export function ticketProgress(stages: Stage[]): number {
  let furthest = 0;
  stages.forEach((s, i) => {
    if (s.state === 'done' || s.state === 'skipped') furthest = i + 1;
    else if (s.state !== 'pending') furthest = Math.max(furthest, i + 0.5);
  });
  return furthest;
}

export function ticketStatus(stages: Stage[]): TicketStatus {
  if (stageState(stages, 'merged') === 'done') return 'merged';
  if (stages.some((s) => s.state === 'failed')) return 'blocked';
  if (stageState(stages, 'pr-review') === 'done') return 'approved';
  if (stages.some((s) => s.state === 'warn')) return 'attention';
  if (stageState(stages, 'pr-review') === 'active') return 'review';
  if (stages.some((s) => s.state === 'done' || s.state === 'active')) return 'progress';
  return 'todo';
}
