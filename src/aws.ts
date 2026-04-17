// Backward compatibility re-exports from credentials module
// This file is kept for existing imports - new code should use src/credentials/

export type { QBCredentials } from "./credentials/types.js";
export { getSecret, putSecret, getCompanyId } from "./credentials/aws-provider.js";
