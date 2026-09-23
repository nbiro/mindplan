/**
 * Source index — config, universe, claim expansion, import lexer/resolver.
 */

export {
  CONFIG_FILENAME,
  loadProjectConfig,
  projectConfigPath,
  projectConfigRelativePath,
  writeProjectConfig,
  type MindPlanProjectConfig,
  type WriteProjectConfigResult,
} from "./config.js";

export {
  claimEntryExists,
  expandClaims,
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
  exclusiveOwner,
  nodeOwnedFiles,
  ownerOfFile,
  type OwnershipBuckets,
} from "./ownership.js";
