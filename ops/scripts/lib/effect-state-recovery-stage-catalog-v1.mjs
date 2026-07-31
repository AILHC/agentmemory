export const EFFECT_STATE_RECOVERY_STAGES = Object.freeze([
  'summary',
  'lessons',
  'memory_consolidate',
  'semantic_rollup',
  'skill_extract',
  'crystal',
  'consolidation_procedural',
  'reflect_insight',
]);

export const EFFECT_STATE_RECOVERY_STAGE_MODES = Object.freeze({
  summary: 'single',
  lessons: 'single',
  memory_consolidate: 'two_phase',
  semantic_rollup: 'single',
  skill_extract: 'two_phase',
  crystal: 'single',
  consolidation_procedural: 'single',
  reflect_insight: 'single',
});
