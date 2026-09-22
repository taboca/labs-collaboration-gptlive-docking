// Deliberately isolated from the CLI server: no config file, key or external API.
import { createServer } from '../server.mjs';
createServer({ config: { port: 4497 }, integrationFactory: () => ({
  close() {}, context() {},
  async start(sdp, { execute, status }) {
    status('Mock sideband connected');
    setTimeout(async () => {
      await execute('analyzeRotationSpeed');
      await execute('inspect');
    }, 1000);
    return { session: { id: 'mock-live' }, transport: { sdp: 'mock-answer' } };
  },
}) });
