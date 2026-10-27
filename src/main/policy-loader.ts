/**
 * Main-process policy loading. The implementation lives in `src/policy-node/policy-files.ts`
 * (Electron-free) so the headless `geode-wiki` CLI shares it; this module keeps the original
 * import path stable for the main process and its tests.
 */
export {
  VAULT_POLICY_REL,
  loadEffectivePolicy,
  loadManagedPolicy,
  loadVaultPolicy,
  policyFilePath,
  readPolicyFile,
} from "../policy-node/policy-files";
