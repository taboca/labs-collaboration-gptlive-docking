import { fileURLToPath } from 'node:url';

export const app = Object.freeze({
  path: "app",
  parentPath: null,
  parentAnchor: null,
  clientModule: '/applets/app/client/index.js',
  clientFile: fileURLToPath(new URL('./client/index.js', import.meta.url)),
  accepts: Object.freeze({"mission": "mission"}),
  createWithServices({ mission }) {
    return {
      ...app,
      createServer: () => import('./server/index.js')
        .then(m => m.createServerApplet({ mission })),
      createServerOperations: () => import('./server/operations.js')
        .then(m => m.createServerOperations({ mission })),
    };
  },
});
