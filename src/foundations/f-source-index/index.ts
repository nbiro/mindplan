/**
 * Source index — config, universe, claim expansion, import lexer/resolver.
 */

export {
  CONFIG_FILENAME,
  DEFAULT_DECISION_SETTINGS,
  decisionGateSettings,
  DEFAULT_HOTSPOT_SETTINGS,
  hotspotSettings,
  loadProjectConfig,
  projectConfigPath,
  projectConfigRelativePath,
  writeProjectConfig,
  type DecisionGateSettings,
  type HotspotSettings,
  type MindPlanProjectConfig,
  type WriteProjectConfigResult,
} from "./config.js";

export {
  defaultBaseRef,
  fileHistory,
  matchesSchemaFile,
  newFilesSinceBase,
  type FileVersion,
} from "./git.js";

export {
  claimCoversPath,
  claimEntryExists,
  claimListKeeps,
  expandClaims,
  isGlobClaim,
  namesPath,
  normalizeClaimList,
  validateClaimPath,
} from "./claims.js";

export {
  collectOtherClaims,
  folderClaimSuggestions,
  isDominatedFolder,
  schemaClaimEntries,
  type FolderClaimSuggestion,
  type OtherClaims,
} from "./dominance.js";

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
