/**
 * Fan-out signal — how many other unshipped changes a pre-ship node depends on, and the warning
 * that suggests inverting it onto a Foundation contract.
 */

export {
  fanOut,
  fanOutContext,
  fanOutFor,
  fanOuts,
  fanOutWarning,
  type FanOut,
  type FanOutContext,
  type FanOutCount,
} from "./fan-out.js";
