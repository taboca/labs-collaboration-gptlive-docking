import { fileURLToPath } from 'node:url';

export const channel = Object.freeze({
  path: "app/mission/channel",
  parentPath: "app/mission",
  parentAnchor: "channel",
  clientModule: '/applets/app/child/mission/child/channel/client/index.js',
  clientFile: fileURLToPath(new URL('./client/index.js', import.meta.url)),
  accepts: Object.freeze({}),
  createWithServices({ mission, gptLive }) {
    return {
      ...channel,
      createServer: () => import('./server/index.js')
        .then(m => m.createServerApplet({ mission, gptLive })),
      createServerOperations: () => import('./server/index.js')
        .then(m => m.createServerOperations({ mission, gptLive })),
    };
  },
});
