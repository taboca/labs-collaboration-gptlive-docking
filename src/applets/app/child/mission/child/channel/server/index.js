export function createServerApplet({ mission }) {
  return {
    init() {
      // Channel owns the application-facing lifecycle; GPT Live details stay in services/gptLive.js.
      return { mission };
    },
  };
}

export function createServerOperations({ mission }) {
  return {
    async handle({ operation, data }) {
      if (operation === 'Connect') return mission.createChannel(data.sdp, data.missionId);
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
