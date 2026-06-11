/**
 * Unit tests for src/classify/TaskClassifier: explicit overrides, one representative
 * prompt per taxonomy class, determinism, fallback, and confidence bounds.
 */

import { describe, expect, it } from 'vitest';
import { TaskClassifier } from '../../src/classify/TaskClassifier.js';
import type { TaskDescriptor, TaskKind } from '../../src/types.js';

interface RepresentativeCase {
  readonly label: string;
  readonly task: TaskDescriptor;
  readonly expected: TaskKind;
}

const LONG_REPORT = `${'The committee reviewed the annual budget and the harbor renovation timeline. '.repeat(
  27,
)}Please summarize the key points.`;

const AMBIGUOUS_PROMPT =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ' +
  'ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco';

const CODE_TASK: TaskDescriptor = {
  agentId: 'agent-rep',
  prompt:
    'Implement a function in src/dedupe.ts that removes duplicates.\n```ts\nexport const dedupe = (xs: number[]) => [...new Set(xs)];\n```',
};

const REPRESENTATIVE_CASES: readonly RepresentativeCase[] = [
  {
    label: 'a code request with fences',
    task: CODE_TASK,
    expected: 'code-generation',
  },
  {
    label: 'an extraction request mentioning JSON fields',
    task: {
      agentId: 'agent-rep',
      prompt:
        'Extract the customer name, email, and order id fields from this invoice and return JSON following the schema.',
    },
    expected: 'extraction',
  },
  {
    label: 'a translation into French',
    task: {
      agentId: 'agent-rep',
      prompt: 'Translate the following announcement into French for the press release.',
    },
    expected: 'translation',
  },
  {
    label: 'a summarization request over a long text',
    task: { agentId: 'agent-rep', prompt: LONG_REPORT },
    expected: 'summarization',
  },
  {
    label: 'a classification request',
    task: {
      agentId: 'agent-rep',
      prompt:
        'Classify and label each incoming support ticket into one category: billing, bug, or feature.',
    },
    expected: 'classification',
  },
  {
    label: 'a short factual question',
    task: {
      agentId: 'agent-rep',
      prompt: 'When did the first transatlantic telegraph cable enter service?',
    },
    expected: 'factual-qa',
  },
  {
    label: 'a planning request',
    task: {
      agentId: 'agent-rep',
      prompt:
        'Plan the migration roadmap with milestones and the steps to retire the legacy service.',
    },
    expected: 'planning',
  },
  {
    label: 'a creative writing request',
    task: {
      agentId: 'agent-rep',
      prompt: 'Write a whimsical short story about a lighthouse keeper befriending the fog.',
    },
    expected: 'creative-writing',
  },
  {
    label: 'a tool-execution descriptor with tools available and an imperative',
    task: {
      agentId: 'agent-rep',
      prompt: 'Run the nightly export job and send the results to the operators.',
      toolsAvailable: 3,
    },
    expected: 'tool-execution',
  },
  {
    label: 'a greeting',
    task: { agentId: 'agent-rep', prompt: 'Hello there, thanks again for yesterday!' },
    expected: 'conversation',
  },
];

describe('TaskClassifier', () => {
  it('honors an explicit kind override with confidence 1', () => {
    const result = new TaskClassifier().classify({
      agentId: 'agent-explicit',
      kind: 'translation',
      prompt: 'Implement a function with ```ts fences``` that looks like code.',
    });
    expect(result).toEqual({ kind: 'translation', confidence: 1, signals: ['explicit-kind'] });
  });

  for (const { label, task, expected } of REPRESENTATIVE_CASES) {
    it(`classifies ${label} as ${expected}`, () => {
      const result = new TaskClassifier().classify(task);
      expect(result.kind).toBe(expected);
      expect(result.signals.length).toBeGreaterThan(0);
    });
  }

  it('verifies the long summarization prompt actually exceeds the long-prompt limit', () => {
    expect(LONG_REPORT.length).toBeGreaterThan(2000);
  });

  it('is deterministic, identical input yields identical output including signal order', () => {
    const first = new TaskClassifier().classify(CODE_TASK);
    const second = new TaskClassifier().classify({ ...CODE_TASK });
    expect(second).toEqual(first);
    expect(second.signals).toEqual(first.signals);
    expect(second.confidence).toBe(first.confidence);
  });

  it('falls back to unknown with confidence 0.3 for empty input', () => {
    const classifier = new TaskClassifier();
    for (const task of [
      { agentId: 'agent-empty' },
      { agentId: 'agent-empty', prompt: '' },
    ] satisfies TaskDescriptor[]) {
      const result = classifier.classify(task);
      expect(result).toEqual({ kind: 'unknown', confidence: 0.3, signals: ['fallback'] });
    }
  });

  it('falls back to unknown with confidence 0.3 for ambiguous input', () => {
    const result = new TaskClassifier().classify({
      agentId: 'agent-ambiguous',
      prompt: AMBIGUOUS_PROMPT,
    });
    expect(result).toEqual({ kind: 'unknown', confidence: 0.3, signals: ['fallback'] });
  });

  it('keeps confidence within [0, 1] and caps heuristic confidence at 0.95', () => {
    const classifier = new TaskClassifier();
    const tasks: readonly TaskDescriptor[] = [
      ...REPRESENTATIVE_CASES.map((c) => c.task),
      { agentId: 'agent-ambiguous', prompt: AMBIGUOUS_PROMPT },
      { agentId: 'agent-empty' },
      { agentId: 'agent-explicit', kind: 'planning' },
    ];
    for (const task of tasks) {
      const result = classifier.classify(task);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      if (!result.signals.includes('explicit-kind')) {
        expect(result.confidence).toBeLessThanOrEqual(0.95);
      }
    }
  });
});
