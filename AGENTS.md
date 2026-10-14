# Code navigation

Before searching or changing multiple source files, query the Graphify index. If the index is missing or stale, run `/home/paperclip/.local/bin/graphify update . --code-only`, then query again. Read the returned file ranges and verify behavior in source.

Keep Graphify output out of commits. Check `.graphifyignore` before building; it must exclude environment files, credentials, keys, certificates, and kubeconfig files.
