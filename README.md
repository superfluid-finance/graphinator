# graphinator

Graphinator is a small tool to execute liquidations based on graph data.


## Prerequisites

- [Bun](https://bun.sh/)

## Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

To install dependencies:

```bash
bun install
```

## Run

- Set your environment variables in a `.env` file. You'll need to provide your private key. (check ```.env.example```)
- Make the `grt.ts` file executable: `chmod +x grt.ts`

Fast run:

```bash
./grt.ts -t 0x1eff3dd78f4a14abfa9fa66579bd3ce9e1b30529 
```

### OR
 
```bash
./grt.ts -t 0x1eff3dd78f4a14abfa9fa66579bd3ce9e1b30529 -l true
```

### Options

- `--network`: The network to use. Defaults to `base-mainnet`.
- `--token`: The token to liquidate.
- `--batchSize`: The number of accounts to liquidate in each batch. Defaults to `15`.
- `--gasMultiplier`: A multiplier to apply to the estimated gas cost for each transaction. Defaults to `1.2`.
- `--loop`: If set, the script will run indefinitely, checking for new accounts to liquidate every 15min.


## License

[MIT](https://choosealicense.com/licenses/mit/)