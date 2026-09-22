export function createServerOperations({ mission }) { return { async handle({ operation, data }) {
if (operation === 'Start mission') return mission.start();
if (operation === 'End mission') return mission.end();
throw new Error(`Unknown operation: ${operation}`);
} }; }
