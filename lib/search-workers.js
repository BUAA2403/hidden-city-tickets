'use strict';

async function mapLimit(items, limit, fn, deadline = Infinity) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length && Date.now() < deadline) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { mapLimit };
