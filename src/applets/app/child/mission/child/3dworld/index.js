import { fileURLToPath } from 'node:url';

export const world = Object.freeze({
  path: "app/mission/world",
  parentPath: "app/mission",
  parentAnchor: "world",
  clientModule: '/applets/app/child/mission/child/3dworld/client/index.js',
  clientFile: fileURLToPath(new URL('./client/index.js', import.meta.url)),
  accepts: Object.freeze({}),
  createWithServices({ mission }) {
    return {
      ...world,
      createServer: () => import('./server/index.js')
        .then(m => m.createServerApplet({ mission })),
      createServerOperations: () => import('./server/operations.js')
        .then(m => m.createServerOperations({ mission })),
    };
  },
});
