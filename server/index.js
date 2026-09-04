/**
 * Local entry point.
 *
 * Everything that matters is in app.js, which the Vercel function imports too,
 * so there is one routing table rather than two that agree until they do not.
 */

import { createServer } from 'node:http';
import { handler, PORT, describeState, keyConfigured } from './app.js';
import { adapterStatus } from '../adapters/index.js';

createServer(handler).listen(PORT, () => {
  console.log(`Signal Box  →  http://localhost:${PORT}`);
  console.log(`  state: ${describeState()}`);
  for (const problem of adapterStatus().problems) console.log(`  ⚠ ${problem}`);
  if (!keyConfigured()) {
    console.log('\n  ASSEMBLYAI_API_KEY is not set. Everything except the voice');
    console.log('  connection still works: policy, evaluator, adapters and audit');
    console.log('  all run offline. To enable voice, put the key in .env.\n');
  }
});
