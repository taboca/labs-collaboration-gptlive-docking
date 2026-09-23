export function createServerApplet({ mission, gptLive }) {
  return {
    init() { return { mission }; },
    destroy() { gptLive.close(); },
  };
}

export function createServerOperations({ mission, gptLive }) {
  return {
    async handle({ operation, data }) {
      if (operation === 'Connect') {
        if (data.missionId !== mission.id) throw new Error('Stale mission');
        if (!mission.active) throw new Error('Mission is not active');
        const missionId = data.missionId;
        return gptLive.start(data.sdp, {
          execute: command => missionId === mission.id && mission.active
            ? mission.execute(command, 'model')
            : Promise.resolve({ status: 'failed', reason: 'mission_ended' }),
          status: status => mission.setChannelStatus(status, missionId)?.catch(() => {}),
        });
      }
      if (operation === 'Ready') return mission.ready(data.missionId);
      if (operation === 'Closed') {
        return data.missionId === mission.id
          ? mission.end(typeof data.message === 'string' ? data.message.slice(0, 200) : '')
          : undefined;
      }
      throw new Error(`Unknown operation: ${operation}`);
    },
  };
}
