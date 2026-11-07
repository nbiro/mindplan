# Set up MindPlan in this repository

`setup_project` created the graph (`mindplan/`: config, an empty brief, the version stamp). The rest touches files the user owns: work through these steps in order and tell the user what you do. Write `mindplan/` only through MindPlan tools.

First call `get_project`: setup seeded the brief's rules, and MindPlan writes wait (`Blocked: Rules`) until the rules reached you.

## 1. Wire the agent files

The `pointer` field of the result is the text every agent session must see first.

1. Write it to `MINDPLAN.md` at the repository root (replace the file if it exists and differs).
2. Add the line `@MINDPLAN.md` to `CLAUDE.md`, which Claude Code reads (create the file with just that line if it is missing). Keep everything else in it.
3. If the repository has an `AGENTS.md` (Codex, Cursor, and others read it), add one line: `Read and follow MINDPLAN.md before answering or writing code.` Do not create `AGENTS.md` for this unless the user uses one of those agents. A host that reads neither file gets that line in its own rules file.
4. If either file holds a MindPlan stub section (it starts `# MindPlan` and mentions "init-installed host copies"), remove it; the line from step 2 or 3 replaces it.

## 2. Ignores

- Add `.mindplan-cache/` (the derived search and graph cache) to `.gitignore` unless it is listed; create the file if missing. The server rewrites `mindplan/map.md` after every graph change, so it must not be tracked: if `mindplan/.gitignore` does not list it, add `mindplan/map.md` to `.gitignore`.
- If the user works in Cursor, add `mindplan/**` to `.cursorignore`, so Cursor never edits the graph with its own file tools.

## 3. Move standing rules into the brief

Read the agent instruction files the repository has (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`) and sort what they say:

- **Rules for the whole repository** (how to test, branch, review, release; language and style rules that apply everywhere) → candidates for `patch_project_rules`.
- **Rules about one part** (one service, package, or feature) → keep a list; once that part is a node, they go on it with `patch_node_rules`.
- **Information** (what the project is, how to run it, links) → stays where it is.

Show the user the proposed rules and, for each source file, the lines you would remove. Write the approved rules with `patch_project_rules`; remove the moved lines only after the user approves that diff. A rule lives in one place, or the copies drift.

## 4. Describe the product

Ask the user what the product does, for whom, and what is out of scope, in two or three sentences. Write it with `patch_project_description`, then call `get_project` again so you hold the new brief.

## 5. Offer the merge gate

Ask whether the repository uses GitHub pull requests. If it does and the user wants the gate, call `setup_project({ ci: "github" })`: it writes `.github/workflows/mindplan-merge-gate.yml`, which fails a pull request to the default branch while work is still in review. Tell the user to make its `mindplan merge gate` job a required status check (Settings → Branches).

## 6. Check and hand off

Run `run_check` and fix every `Blocked:` line. Tell the user what changed (the files you wrote, the rules you moved) and suggest the next step: map the first Capabilities with the `plan-project` skill (`get_skill({ name: "plan-project" })`).
