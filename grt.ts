#!/usr/bin/env bun

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import Graphinator from './src/graphinator';

const log = (msg: string, lineDecorator="") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);

const argv = await yargs(hideBin(process.argv))
    .option('network', {
        alias: 'n',
        type: 'string',
        description: 'Set the network',
        default: 'base-mainnet'
    })
    .option('batchSize', {
        alias: 'b',
        type: 'number',
        description: 'Set the batch size',
        default: 15
    })
    .option('gasMultiplier', {
        alias: 'g',
        type: 'number',
        description: 'Set the gas multiplier',
        default: 1.2
    })
    .option('token', {
        alias: 't',
        type: 'string',
        description: 'Set the token to liquidate',
        demandOption: true
    })
    .option('loop', {
        alias: 'l',
        type: 'boolean',
        description: 'Set to true to loop forever, false to run once',
        default: false
    })
    .option('maxGasPrice', {
        alias: 'm',
        type: 'number',
        description: 'Set the max gas price',
        default: 500000000
    })
    .parse();

const runAgainIn = 15 * 60 * 1000;
const network = argv.network;
const batchSize = argv.batchSize;
const gasMultiplier = argv.gasMultiplier;
const token = argv.token.toLowerCase();
const loop = argv.loop;
const maxGasPrice = BigInt(argv.maxGasPrice);


const config = {
    batchContractAddress: '0x6b008BAc0e5846cB5d9Ca02ca0e801fCbF88B6f9',
    gdaForwarderAddress: '0x6DA13Bde224A05a288748d857b9e7DDEffd1dE08',
    superTokenAddress: token
}

const ghr = new Graphinator(network, config);
if(loop) {
    log("run liquidations forever...", "🤖");
    await ghr.run(batchSize, gasMultiplier, maxGasPrice);
    setInterval(async () => {
        try {
            await ghr.run(batchSize, gasMultiplier, maxGasPrice);
        } catch (error) {
            console.error(error);
        }
    }, runAgainIn);
} else {
    log("run liquidations once...", "🤖");
    await ghr.run(batchSize, gasMultiplier, maxGasPrice);
}
