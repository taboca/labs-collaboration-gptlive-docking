import { fileURLToPath } from 'node:url';

export const environment = Object.freeze({
  path: "app/mission/environment",
  parentPath: "app/mission",
  parentAnchor: "environment",
  clientModule: '/applets/app/child/mission/child/environment/client/index.js',
  clientFile: fileURLToPath(new URL('./client/index.js', import.meta.url)),
  accepts: Object.freeze({}),
  createWithServices({ mission }) {
    return {
      ...environment,
      createServer: () => import('./server/index.js')
        .then(m => m.createServerApplet({ mission })),
    };
  },
});
