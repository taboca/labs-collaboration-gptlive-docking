import { fileURLToPath } from 'node:url';

export const starship = Object.freeze({
  path: "app/mission/starship",
  parentPath: "app/mission",
  parentAnchor: "starship",
  clientModule: '/applets/app/child/mission/child/starship/client/index.js',
  clientFile: fileURLToPath(new URL('./client/index.js', import.meta.url)),
  accepts: Object.freeze({}),
  createWithServices({ mission }) {
    return {
      ...starship,
      createServer: () => import('./server/index.js')
        .then(m => m.createServerApplet({ mission })),
      createServerOperations: () => import('./server/index.js')
        .then(m => m.createServerOperations({ mission })),
    };
  },
});
