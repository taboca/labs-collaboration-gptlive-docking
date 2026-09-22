export function createServerApplet({ mission }) {
  return {
    destroy() {
      mission.close();
    },
  };
}

export function createServerOperations({ mission }) {
  return {
    async handle({ operation }) {
      if (operation === 'End mission') return mission.end();
      throw new Error(`Unknown operation: ${operation}`);
    },
  };
}
