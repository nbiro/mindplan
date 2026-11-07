### d-mirror-embedder-runtime

- Decision: The embedder imports transformers.js from a per-machine mirror under ~/.cache/mindplan/runtime/<key> (the installed package and its dependency closure, this platform's native binaries only), never from the project's node_modules; when the mirror cannot be made or loaded, it imports in place as before.
- Alternatives:
  - A long-lived embedder child process (it loads the same native DLLs from node_modules, so npm ci still hits EPERM while it runs)
  - An embedder child that exits when idle (locks still held while indexing and right after a search, and the first search after it exits is keyword-only while the model reloads)
  - Documentation only: run the server through npx -y without a devDependency (does not help a project that keeps the devDependency)
- Why: Windows locks a loaded native DLL (onnxruntime-node, sharp) for the life of the process, so a server running from a project's node_modules makes npm ci and npm install fail with EPERM, and agents then kill every node process, MindPlan servers included. Loading the DLLs from a copy outside the project leaves node_modules free while search keeps working exactly as before.
- Consequences: The first model load copies about 100 MB per installed transformers.js dependency set into the user cache; old mirrors are not pruned. onnxruntime-web is left out of the mirror because the Node build never imports it.
- Change: search-runtime-mirror
- Date: 2026-11-07
