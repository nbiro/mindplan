/**
 * Fan-in signal — how many direct dependents a pre-ship Foundation has, grouped by Capability, and
 * the warning that points at a per-area split.
 */

export {
  fanInContext,
  fanInFor,
  fanInGrouping,
  fanInSignals,
  fanInWarning,
  isPreShipFoundation,
  type FanInContext,
  type FanInGroup,
  type FanInGrouping,
  type FanInSignal,
} from "./fan-in.js";
