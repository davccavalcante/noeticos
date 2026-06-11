/**
 * Default discrete search grids, applied when the caller omits a dimension
 * from the parameter space. The `model` dimension has no default, it is tuned
 * only when candidates are declared explicitly.
 */

import type { ParameterSpace } from '../types.js';

export const DEFAULT_PARAMETER_SPACE: Required<Omit<ParameterSpace, 'model'>> = {
  temperature: [0, 0.2, 0.4, 0.7, 1.0],
  topP: [0.9, 1.0],
  maxTurns: [8, 16, 32, 64],
  retryBudget: [0, 1, 3],
  contextShare: [0.4, 0.6, 0.8],
};
