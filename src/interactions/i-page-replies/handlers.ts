/**
 * Page a long reply — owned by i-page-replies: next_page reads the rest of a list the reply budget
 * cut (f-tool-kit pages), as many items as fit the budget.
 */

import { nextPage } from "../../foundations/f-tool-kit/pages.js";
import { loadProjectConfig, replySettings } from "../../foundations/f-source-index/config.js";

export function nextPageHandler(args: { cursor: string }): Record<string, unknown> {
  return nextPage(args.cursor, replySettings(loadProjectConfig()).budget_bytes);
}
