export function createServerApplet({ mission, gptLive }) {
  return {
    init() {
      return { mission };
    },

    destroy() {
      gptLive.close();
    },
  };
}

export function createServerOperations({ mission, gptLive }) {
  return {
    async handle({ operation, data }) {
      if (operation === 'Connect') {
        if (data.missionId !== mission.id) {
          throw new Error('Stale mission');
        }
        if (!mission.active) {
          throw new Error('Mission is not active');
        }

        const missionId = data.missionId;
        // Hook delegated Channel commands into Mission's authoritative handler.
        // OpenAILiveService calls this after mapping the tool to an app command.
        const executeDelegatedCommand = command => {
          if (missionId === mission.id && mission.active) {
            return mission.execute(command, 'model');
          }
          return Promise.resolve({
            status: 'failed',
            reason: 'mission_ended',
          });
        };
        const reportChannelStatus = statusText => {
          const update = mission.setChannelStatus(statusText, missionId);
          if (update) {
            return update.catch(() => {});
          }
        };

        return gptLive.start(data.sdp, {
          executeCommand: executeDelegatedCommand,
          status: reportChannelStatus,
        });
      }

      if (operation === 'Ready') {
        return mission.ready(data.missionId);
      }

      if (operation === 'Closed') {
        if (data.missionId !== mission.id) {
          return;
        }

        let message = '';
        if (typeof data.message === 'string') {
          message = data.message.slice(0, 200);
        }
        return mission.end(message);
      }

      throw new Error(`Unknown operation: ${operation}`);
    },
  };
}
