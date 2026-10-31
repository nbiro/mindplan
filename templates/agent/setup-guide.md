# Set up MindPlan in this repository

`setup_project` created the graph (`mindplan/`: config, an empty brief, the version stamp). The rest needs you and the user, because it touches files the user owns. Work through these steps in order and tell the user what you are doing. Write `mindplan/` only through MindPlan tools.

## 1. Wire the agent files

The `pointer` field of the `setup_project` result is the text every agent session must see first.

1. Write it to `MINDPLAN.md` at the repository root (replace the file if it exists and differs).
2. Claude Code reads `CLAUDE.md`: add a line `@MINDPLAN.md` to it (create the file with just that line if it does not exist). Keep everything else in it.
3. If the repository has an `AGENTS.md` (Codex, Cursor, and others read it), add one line: `Read and follow MINDPLAN.md before answering or writing code.` Do not create `AGENTS.md` just for this unless the user uses one of those agents.
4. If either file still holds an older MindPlan stub (a section that starts `# MindPlan` and mentions "init-installed host copies"), remove that section; the line from step 2 or 3 replaces it.

## 2. Ignores

- Add `.mindplan-cache/` to `.gitignore` (create it if missing) unless an entry for it is already there: it is the derived search and graph cache.
- If the user works in Cursor, add `mindplan/**` to `.cursorignore`, so Cursor never edits the graph with its own file tools.

## 3. Move standing rules into the brief

Read the agent instruction files the repository already has: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`. Sort what they say into three groups:

- **Rules for the whole repository** (how to test, branch, review, release; language and style rules that apply everywhere) → candidates for `patch_project_rules`.
- **Rules about one area** (one service, one package, one feature) → keep a list; once that area is a node in the graph, they go on it with `patch_node_rules`.
- **Information** (what the project is, how to run it, links) → stays where it is.

Show the user the proposed rules list and, for each source file, the lines you would remove. Write the approved rules with `patch_project_rules`, then remove the moved lines from their source files only after the user approves that diff. A rule must live in one place, or the copies drift.

## 4. Describe the product

Ask the user what the product does, for whom, and what is out of scope, in two or three sentences. Write it with `patch_project_description`, then call `get_project` again so you hold the new brief.

## 5. Offer the merge gate

Ask whether the repository uses GitHub pull requests. If it does and the user wants the gate, call `setup_project({ ci: "github" })`: it writes `.github/workflows/mindplan-merge-gate.yml`, which fails a pull request to the default branch while work is still in review. Tell the user to make its `mindplan merge gate` job a required status check (Settings → Branches).

## 6. Check and hand off

Run `run_check` and fix every `Blocked:` line. Then tell the user what changed (the files you wrote, the rules you moved) and suggest the next step: map the first areas with the `plan-project` skill (`get_skill({ name: "plan-project" })`).
