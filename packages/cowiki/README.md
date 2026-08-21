# cowiki

The public command-line client for CoWikiHarness.

```bash
npx --yes cowiki@latest --help
```

The client talks to an already deployed Knowledge Gateway through its public A2A and Graph REST interfaces. It does not start the Gateway, create a database, or store credentials in npm or in command arguments.

```bash
export COWIKIHARNESS_URL="https://knowledge.example.com"
npx --yes cowiki@latest ask "知识中心里有哪些关于交付的内容？" \
  --token-file "$HOME/.config/cowikiharness/credentials/agent.token"

npx --yes cowiki@latest graph \
  --depth 2 \
  --include tags,locations,versions \
  --token-file "$HOME/.config/cowikiharness/credentials/owner.token"
```

Remote HTTP is rejected. Use a token file with permission `0600`; never paste a token into a command or commit it to a repository.

For the server deployment path, see the [Linux Gateway deployment guide](https://github.com/MetaInFLow/CoWikiHarness/blob/main/docs/deployment/linux-gateway.md).
