# About

The **graphinator** is a lightweight alternative to the [superfluid-sentinel](https://github.com/superfluid-finance/superfluid-sentinel).
It looks for [critical or insolvent accounts](https://docs.superfluid.finance/docs/protocol/advanced-topics/solvency/liquidations-and-toga) and liquidates their outgoing flows (CFA and GDA).
Unlike the sentinel, it is stateless and relies on the [Superfluid Subgraph](https://console.superfluid.finance/subgraph) as data source.

By default, the graphinator operates in a _one-shot_ mode, meaning: it checks and liquidates once, then exits.
For continued operation, it's recommended to set up a cronjob.

Once graphinator instance operates for a to-be-specified chain.
By default, it operates on all [listed Super Token](https://console.superfluid.finance/supertokens), but also allows to operate only on a single Super Token.

## Prerequisites

Install Bun:
```bash
curl -fsSL https://bun.sh/install | bash
```

Set up the repo and install dependencies:
```bash
git clone https://github.com/superfluid-finance/graphinator
cd graphinator
bun install
```

## Run

```
PRIVATE_KEY=... ./grt.ts -n <network>
```

_network_ needs to be the canonical name of a chain where Superfluid is deployed. See [metadata/networks.json](https://github.com/superfluid-finance/protocol-monorepo/blob/dev/packages/metadata/networks.json) (field _name_). For example `base-mainnet`.

You can also provide `PRIVATE_KEY` via an `.env` file.

Make sure `grt.ts` is executable.

See `./grt.ts --help` for more config options.

## License

[MIT](https://choosealicense.com/licenses/mit/)