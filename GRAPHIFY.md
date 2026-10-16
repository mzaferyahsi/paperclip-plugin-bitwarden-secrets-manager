# Graphify

This checkout has a local code graph in `graphify-out/`. Graphify uses it for code navigation; the graph is generated and must stay out of commits.

Before you ask a codebase question, run `graphify query "<question>"`. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for a focused explanation. If the graph is missing or out of date, rebuild it with `graphify update .` from this checkout, then query again.

The `.graphifyignore` file excludes environment files, credentials, private keys, certificates, kubeconfig files, dependencies, and generated output. Check it before building. Do not copy secret values into Graphify queries or generated artifacts.
