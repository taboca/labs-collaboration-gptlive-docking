export function createServerOperations({ mission }) { return { async handle({ operation, data }) {

throw new Error(`Unknown operation: ${operation}`);
} }; }
