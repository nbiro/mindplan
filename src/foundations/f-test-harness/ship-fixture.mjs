/**
 * Ship fixtures shared by suites that walk create_node scaffolds to ship.
 */
import * as fs from "fs";

/** The build pipeline from draft to ship, one update_node_status target per step. */
export const SHIP = ["ready", "in-progress", "in-review", "ship"];

/** Fill a create_node scaffold's stubs with real text and tick every checkbox (before first ship). */
export function fillAndTick(file, filler = "Filled territory.") {
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : filler));
  text = text.replace(/^## Checklist\s*$/m, "## Atomic Ops");
  if (!/^\s*[-*+]\s+\[[ xX]\]/m.test(text)) text += "\n- [ ] Done\n";
  fs.writeFileSync(file, text.replaceAll("- [ ]", "- [x]"));
}
