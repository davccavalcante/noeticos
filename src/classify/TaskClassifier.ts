/**
 * Deterministic, explainable task classifier for NoeticOS.
 *
 * Pure text heuristics over the prompt plus structural descriptor fields. No model
 * calls, no randomness, no dependencies: the same descriptor always yields the same
 * {@link Classification}, and every fired feature is reported as a named signal.
 */

import type { Classification, TaskDescriptor, TaskKind } from '../types.js';

/**
 * Default task taxonomy recognized by {@link TaskClassifier}, in the declaration order
 * of the {@link TaskKind} contract.
 */
export const DEFAULT_TASK_KINDS: readonly TaskKind[] = [
  'factual-qa',
  'creative-writing',
  'code-generation',
  'extraction',
  'summarization',
  'translation',
  'planning',
  'tool-execution',
  'conversation',
  'classification',
  'unknown',
];

/** Confidence ceiling for heuristic matches; only an explicit caller kind reports 1. */
const HEURISTIC_CONFIDENCE_CAP = 0.95;
const FALLBACK_CONFIDENCE = 0.3;
const SHORT_FACTUAL_LIMIT = 400;
const LONG_PROMPT_LIMIT = 2000;
const SHORT_CHAT_LIMIT = 120;
/** Window, in characters, inspected at the end of long prompts for a trailing instruction. */
const TAIL_WINDOW = 240;

interface Feature {
  readonly signal: string;
  readonly pattern: RegExp;
}

interface RuleContext {
  readonly text: string;
  readonly length: number | undefined;
  readonly toolsAvailable: number | undefined;
}

interface RuleResult {
  readonly kind: TaskKind;
  readonly signals: readonly string[];
}

type Rule = (ctx: RuleContext) => RuleResult | undefined;

// All patterns are alternations of literals with bounded quantifiers only, so matching
// is linear in the prompt length and free of catastrophic backtracking.
const CODE_FEATURES: readonly Feature[] = [
  { signal: 'code-fence', pattern: /```/ },
  { signal: 'keyword:function', pattern: /\bfunction\b/i },
  { signal: 'keyword:class', pattern: /\bclass\b/i },
  { signal: 'keyword:import', pattern: /\bimport\b/i },
  { signal: 'keyword:def', pattern: /\bdef\b/i },
  { signal: 'keyword:const', pattern: /\bconst\b/i },
  { signal: 'keyword:implement', pattern: /\bimplement(?:ation|ing|ed|s)?\b/i },
  { signal: 'keyword:refactor', pattern: /\brefactor(?:ing|ed|s)?\b/i },
  { signal: 'keyword:fix-the-bug', pattern: /\bfix(?:ing)?\s+(?:the|this|a)\s+bug\b/i },
  {
    signal: 'file-extension',
    pattern:
      /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|cpp|cc|cs|php|html|css|scss|sql|sh|yml|yaml|toml)\b/i,
  },
];

const EXTRACTION_FEATURES: readonly Feature[] = [
  { signal: 'keyword:extract', pattern: /\bextract(?:ion|ing|ed|s)?\b/i },
  { signal: 'keyword:parse', pattern: /\bpars(?:e|es|ed|ing|er)\b/i },
  { signal: 'keyword:json', pattern: /\bjson\b/i },
  { signal: 'keyword:csv', pattern: /\bcsv\b/i },
  { signal: 'keyword:xml', pattern: /\bxml\b/i },
  { signal: 'keyword:fields', pattern: /\bfields?\b/i },
  { signal: 'keyword:schema', pattern: /\bschemas?\b/i },
];

const LANGUAGE_ALTERNATION =
  'english|spanish|french|german|italian|portuguese|dutch|russian|polish|ukrainian|turkish' +
  '|swedish|norwegian|danish|finnish|czech|greek|hebrew|arabic|hindi|bengali|chinese|mandarin' +
  '|cantonese|japanese|korean|vietnamese|thai|indonesian|malay|swahili|latin';

const TRANSLATION_FEATURES: readonly Feature[] = [
  { signal: 'keyword:translate', pattern: /\btranslat(?:e|es|ed|ing|ion|or)\b/i },
  {
    signal: 'into-language',
    pattern: new RegExp(`\\binto\\s+(?:${LANGUAGE_ALTERNATION})\\b`, 'i'),
  },
  {
    signal: 'language-pair',
    pattern: new RegExp(
      `\\bfrom\\s+(?:${LANGUAGE_ALTERNATION})\\s+(?:in)?to\\s+(?:${LANGUAGE_ALTERNATION})\\b`,
      'i',
    ),
  },
];

const SUMMARIZATION_FEATURES: readonly Feature[] = [
  {
    signal: 'keyword:summarize',
    pattern: /\bsummar(?:y|ies|i[sz]es?|i[sz]ed|i[sz]ing|i[sz]ation)\b/i,
  },
  { signal: 'keyword:tldr', pattern: /\btl;?dr\b/i },
  { signal: 'keyword:shorten', pattern: /\bshorten(?:ed|ing|s)?\b/i },
  { signal: 'keyword:key-points', pattern: /\bkey\s+points\b/i },
];

const TAIL_INSTRUCTION =
  /\b(?:please|summari[sz]e|shorten|condense|rewrite|describe|explain|list|give|provide|what|briefly)\b/i;

const CLASSIFICATION_FEATURES: readonly Feature[] = [
  { signal: 'keyword:classify', pattern: /\bclassif(?:y|ies|ied|ying|ication)\b/i },
  { signal: 'keyword:categorize', pattern: /\bcategori[sz](?:e|es|ed|ing|ation)\b/i },
  { signal: 'keyword:label', pattern: /\blabel(?:s|ed|ing|led|ling)?\b/i },
  { signal: 'keyword:which-category', pattern: /\bwhich\s+categor(?:y|ies)\b/i },
];

const INTERROGATIVE_FEATURES: readonly Feature[] = [
  { signal: 'interrogative:who', pattern: /\bwho\b/i },
  { signal: 'interrogative:what', pattern: /\bwhat\b/i },
  { signal: 'interrogative:when', pattern: /\bwhen\b/i },
  { signal: 'interrogative:where', pattern: /\bwhere\b/i },
  { signal: 'interrogative:which', pattern: /\bwhich\b/i },
  { signal: 'interrogative:how-many', pattern: /\bhow\s+many\b/i },
];

const PLANNING_FEATURES: readonly Feature[] = [
  { signal: 'keyword:plan', pattern: /\bplan(?:s|ned|ning)?\b/i },
  { signal: 'keyword:roadmap', pattern: /\broadmaps?\b/i },
  { signal: 'keyword:steps-to', pattern: /\bsteps\s+to\b/i },
  { signal: 'keyword:strategy', pattern: /\bstrateg(?:y|ies|ic)\b/i },
  { signal: 'keyword:milestones', pattern: /\bmilestones?\b/i },
];

const CREATIVE_FEATURES: readonly Feature[] = [
  {
    signal: 'creative-request',
    pattern:
      /\bwrite\s[^.!?\n]{0,40}\b(?:story|stories|poem|poems|essay|essays|post|posts|novel|haiku|song)\b/i,
  },
  { signal: 'keyword:imagine', pattern: /\bimagin(?:e|ed|ing|ative)\b/i },
  { signal: 'keyword:creative', pattern: /\bcreativ(?:e|ity|ely)\b/i },
  {
    signal: 'tone-word',
    pattern: /\b(?:whimsical|dramatic|humorous|poetic|playful|romantic|funny|witty|lyrical)\b/i,
  },
];

const TOOL_VERB_FEATURES: readonly Feature[] = [
  { signal: 'keyword:run', pattern: /\brun(?:s|ning)?\b/i },
  { signal: 'keyword:execute', pattern: /\bexecut(?:e|es|ed|ing|ion)\b/i },
  { signal: 'keyword:call', pattern: /\bcall(?:s|ed|ing)?\b/i },
  { signal: 'keyword:fetch', pattern: /\bfetch(?:es|ed|ing)?\b/i },
  { signal: 'keyword:send', pattern: /\bsend(?:s|ing)?\b/i },
];

const GREETING_FEATURES: readonly Feature[] = [
  {
    signal: 'greeting',
    pattern:
      /\b(?:hello|hi|hey|howdy|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|how\s+are\s+you|greetings)\b/i,
  },
];

const ANY_INTERROGATIVE = /\b(?:who|what|when|where|which|why|how)\b/i;
const ANY_IMPERATIVE =
  /\b(?:run|execute|call|fetch|send|write|create|make|build|list|give|explain|show|generate|translate|summari[sz]e|extract|parse|classify|implement|refactor|fix|plan|describe|tell)\b/i;

const matchFeatures = (text: string, features: readonly Feature[]): string[] => {
  const signals: string[] = [];
  for (const feature of features) {
    if (feature.pattern.test(text)) {
      signals.push(feature.signal);
    }
  }
  return signals;
};

const featureRule = (kind: TaskKind, features: readonly Feature[]): Rule => {
  return (ctx) => {
    if (ctx.text === '') {
      return undefined;
    }
    const signals = matchFeatures(ctx.text, features);
    return signals.length > 0 ? { kind, signals } : undefined;
  };
};

const summarizationRule: Rule = (ctx) => {
  if (ctx.text === '') {
    return undefined;
  }
  const signals = matchFeatures(ctx.text, SUMMARIZATION_FEATURES);
  if (ctx.text.length > LONG_PROMPT_LIMIT && TAIL_INSTRUCTION.test(ctx.text.slice(-TAIL_WINDOW))) {
    signals.push('long-prompt-instruction');
  }
  return signals.length > 0 ? { kind: 'summarization', signals } : undefined;
};

const factualQaRule: Rule = (ctx) => {
  if (ctx.text === '' || ctx.length === undefined || ctx.length >= SHORT_FACTUAL_LIMIT) {
    return undefined;
  }
  const signals = matchFeatures(ctx.text, INTERROGATIVE_FEATURES);
  if (signals.length === 0) {
    return undefined;
  }
  signals.push('short-prompt');
  if (ctx.text.includes('?')) {
    signals.push('question-mark');
  }
  return { kind: 'factual-qa', signals };
};

const toolExecutionRule: Rule = (ctx) => {
  if (ctx.text === '' || ctx.toolsAvailable === undefined || ctx.toolsAvailable <= 0) {
    return undefined;
  }
  const verbs = matchFeatures(ctx.text, TOOL_VERB_FEATURES);
  if (verbs.length === 0) {
    return undefined;
  }
  return { kind: 'tool-execution', signals: ['tools-available', ...verbs] };
};

const conversationRule: Rule = (ctx) => {
  if (ctx.text === '') {
    return undefined;
  }
  const signals = matchFeatures(ctx.text, GREETING_FEATURES);
  if (
    ctx.length !== undefined &&
    ctx.length < SHORT_CHAT_LIMIT &&
    !ctx.text.includes('?') &&
    !ANY_INTERROGATIVE.test(ctx.text) &&
    !ANY_IMPERATIVE.test(ctx.text)
  ) {
    signals.push('short-casual');
  }
  return signals.length > 0 ? { kind: 'conversation', signals } : undefined;
};

/**
 * Heuristic rules in priority order. Selection keeps the result with the highest hit
 * count and resolves ties in favor of the earlier rule, so output is deterministic.
 */
const RULES: readonly Rule[] = [
  featureRule('code-generation', CODE_FEATURES),
  featureRule('extraction', EXTRACTION_FEATURES),
  featureRule('translation', TRANSLATION_FEATURES),
  summarizationRule,
  featureRule('classification', CLASSIFICATION_FEATURES),
  factualQaRule,
  featureRule('planning', PLANNING_FEATURES),
  featureRule('creative-writing', CREATIVE_FEATURES),
  toolExecutionRule,
  conversationRule,
];

/**
 * Classifies a {@link TaskDescriptor} into a {@link TaskKind} with explainable signals.
 *
 * A caller-asserted `kind` short-circuits every heuristic and reports confidence 1.
 * Otherwise each rule counts its fired features as hits, the hit count is normalized
 * into a confidence of `hits / (hits + 1)` capped at 0.95, and when no rule fires the
 * classifier falls back to `'unknown'` with confidence 0.3.
 */
export class TaskClassifier {
  classify(task: TaskDescriptor): Classification {
    if (task.kind !== undefined) {
      return { kind: task.kind, confidence: 1, signals: ['explicit-kind'] };
    }
    const text = task.prompt ?? '';
    const length = task.prompt !== undefined ? task.prompt.length : task.promptLength;
    const ctx: RuleContext = { text, length, toolsAvailable: task.toolsAvailable };
    let best: RuleResult | undefined;
    for (const rule of RULES) {
      const result = rule(ctx);
      if (
        result !== undefined &&
        (best === undefined || result.signals.length > best.signals.length)
      ) {
        best = result;
      }
    }
    if (best === undefined) {
      return { kind: 'unknown', confidence: FALLBACK_CONFIDENCE, signals: ['fallback'] };
    }
    const hits = best.signals.length;
    return {
      kind: best.kind,
      confidence: Math.min(HEURISTIC_CONFIDENCE_CAP, hits / (hits + 1)),
      signals: best.signals,
    };
  }
}
