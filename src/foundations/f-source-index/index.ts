/**
 * Source index — config, universe, claim expansion, import lexer/resolver.
 */

export {
  CONFIG_FILENAME,
  DEFAULT_DECISION_SETTINGS,
  decisionGateSettings,
  loadProjectConfig,
  projectConfigPath,
  projectConfigRelativePath,
  writeProjectConfig,
  type DecisionGateSettings,
  type MindPlanProjectConfig,
  type WriteProjectConfigResult,
} from "./config.js";

export { defaultBaseRef, matchesSchemaFile, newFilesSinceBase } from "./git.js";

export {
  claimCoversPath,
  claimEntryExists,
  expandClaims,
  isGlobClaim,
  normalizeClaimList,
  validateClaimPath,
} from "./claims.js";

export { isInUniverse, listUniverseFiles, matchGlob } from "./universe.js";

export {
  lexImports,
  listResolvedImports,
  resolveImport,
  type ResolvedImport,
} from "./imports.js";

export {
  buildOwnershipIndex,
  claimantsOf,
  exclusiveOwner,
  nodeOwnedFiles,
  ownerOfFile,
  releasedClaimEntries,
  type Claimant,
  type OwnershipBuckets,
} from "./ownership.js";
