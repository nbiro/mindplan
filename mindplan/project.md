# Project

## Description

MindPlan is an AI-first SDLC framework: agents and humans work from a persistent, machine-queryable product graph under `mindplan/`, not from chat history or an external ticket list. The Model Context Protocol server is the single write path to graph state. The systems dialect (playbook) and this project's description and rules load through `get_project`; MCP server instructions only point agents at that call.

## Rules

- `SPEC.md` is normative for this package.
- `GRAPH_VERSION` stays `1`. There is no consumer compatibility layer for the former Workflow-centric schema.
- Implementation language is TypeScript under `src/`.
- Verify changes with `npm test`.
