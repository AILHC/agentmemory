export async function runStagePipeline(items, {
  mode = 'single-step',
  concurrency = 1,
  bufferLimit = Math.max(1, concurrency * 2),
  signal,
  execute,
  prepare,
  commit,
  onOutcome = async () => {},
} = {}) {
  if (!['single-step', 'independent', 'ordered-commit'].includes(mode)) {
    throw new Error(`unsupported pipeline mode: ${mode}`);
  }
  if (mode === 'ordered-commit' && (typeof prepare !== 'function' || typeof commit !== 'function')) {
    throw new Error('ordered-commit requires prepare and commit');
  }
  if (mode !== 'ordered-commit' && typeof execute !== 'function') {
    throw new Error(`${mode} requires execute`);
  }

  const ordered = [...items];
  const results = new Array(ordered.length);
  let nextStart = 0;
  let nextCommit = 0;
  let inFlight = 0;
  let stopped = false;
  const prepared = new Map();

  return new Promise((resolve, reject) => {
    const finish = () => {
      if ((stopped || nextCommit >= ordered.length) && inFlight === 0) resolve(results.filter(Boolean));
    };
    const fail = (error) => {
      stopped = true;
      reject(error);
    };
    const commitReady = async () => {
      while (!stopped && prepared.has(nextCommit)) {
        const proposal = prepared.get(nextCommit);
        prepared.delete(nextCommit);
        const outcome = await commit(ordered[nextCommit], proposal, { signal, sequence: nextCommit });
        results[nextCommit] = outcome;
        await onOutcome(ordered[nextCommit], outcome, { sequence: nextCommit, phase: 'commit' });
        nextCommit += 1;
      }
    };
    const launch = () => {
      if (signal?.aborted) stopped = true;
      while (
        !stopped
        && nextStart < ordered.length
        && inFlight < concurrency
        && (mode !== 'ordered-commit' || prepared.size + inFlight < bufferLimit)
      ) {
        const sequence = nextStart++;
        const item = ordered[sequence];
        inFlight += 1;
        Promise.resolve(mode === 'ordered-commit'
          ? prepare(item, { signal, sequence })
          : execute(item, { signal, sequence }))
          .then(async (value) => {
            if (mode === 'ordered-commit') {
              prepared.set(sequence, value);
              await onOutcome(item, value, { sequence, phase: 'prepare' });
              await commitReady();
            } else {
              results[sequence] = value;
              nextCommit += 1;
              await onOutcome(item, value, { sequence, phase: 'execute' });
            }
          })
          .catch(fail)
          .finally(() => {
            inFlight -= 1;
            launch();
            finish();
          });
      }
      finish();
    };
    launch();
  });
}
