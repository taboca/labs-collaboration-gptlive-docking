import { fileURLToPath } from 'node:url';

export const mission = Object.freeze({
  path: "app/mission",
  parentPath: "app",
  parentAnchor: "mission",
  clientModule: '/applets/app/child/mission/client/index.js',
  clientFile: fileURLToPath(new URL('./client/index.js', import.meta.url)),
  accepts: Object.freeze({"channel": "channel", "starship": "starship", "environment": "environment", "world": "world"}),
  createWithServices({ mission: missionService }) {
    return {
      ...mission,
      createServer: () => import('./server/index.js')
        .then(m => m.createServerApplet({ mission: missionService })),
      createServerOperations: () => import('./server/index.js')
        .then(m => m.createServerOperations({ mission: missionService })),
    };
  },
});
