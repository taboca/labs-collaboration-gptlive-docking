import { createAppletRegistry } from '@taboca/inner-browsing';
import { assertAppletClientFiles } from '@taboca/inner-browsing/node';

import { app } from './applets/app/index.js';
import { mission } from './applets/app/child/mission/index.js';
import { channel } from './applets/app/child/mission/child/channel/index.js';
import { starship } from './applets/app/child/mission/child/starship/index.js';
import { environment } from './applets/app/child/mission/child/environment/index.js';
import { world } from './applets/app/child/mission/child/3dworld/index.js';

const definitions = Object.freeze([app, mission, channel, starship, environment, world]);

export function registryFor(services = {}) {
  return assertAppletClientFiles(createAppletRegistry({
    services,
    definitions,
  }));
}
