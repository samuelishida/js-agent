// Auto-generated snapshot data for bundled tools.
// Run `node scripts/build-snapshot.mjs` to regenerate with real tool data.
window.AgentSnapshotData = {
  generatedAt: null,
  bundledTools: [
    {
      name: 'loop',
      description: 'Agent loop and iteration tools',
      whenToUse: 'For multi-step agentic workflows',
      argumentHint: 'task: string',
      usage: 'run: { task: "do something" }',
      exported: 'snapshot:loop'
    },
    {
      name: 'batch',
      description: 'Batch processing and parallel execution',
      whenToUse: 'For parallel tasks and batch operations',
      argumentHint: 'items: array',
      usage: 'run: { items: [] }',
      exported: 'snapshot:batch'
    },
    {
      name: 'remember',
      description: 'Memory and context retention',
      whenToUse: 'For long-term context and memory management',
      argumentHint: 'key: string, value: any',
      usage: 'run: { key: "context", value: {} }',
      exported: 'snapshot:remember'
    }
  ],
  promptSnippets: {},
  stats: {
    bundledTools: 3,
    totalLines: 0
  }
};

