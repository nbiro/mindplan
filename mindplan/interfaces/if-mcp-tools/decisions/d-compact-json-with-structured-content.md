### d-compact-json-with-structured-content

- Decision: Successful object results are compact JSON text plus a structuredContent mirror, with no outputSchema declared.
- Alternatives:
  - Keep pretty-printed text only (about a third more tokens on every result, and a client has to parse prose)
  - Declare an outputSchema per tool as well (twenty-seven more schemas in tools/list, which the host loads into context, for validation no client asked for)
- Why: structuredContent lets a client read the result without parsing and costs nothing, while the text copy stays for hosts that ignore it; the schema would cost context on every session.
- Consequences: A test that compares result text byte for byte must parse it instead; string payloads and error results stay text-only.
- Change: mcp-audit-fixes
- Date: 2026-10-20
