#!/usr/bin/env bun

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import Graphinator from './src/graphinator';

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
        default: 90000000
    })
    .parse();

const runAgainIn = 15 * 60 * 1000;
const network = argv.network;
const batchSize = argv.batchSize;
const gasMultiplier = argv.gasMultiplier;
const token = argv.token.toLowerCase();
const loop = argv.loop;
const maxGasPrice = argv.maxGasPrice;

const ghr = new Graphinator(network, token);
if(loop) {
    console.log(new Date().toISOString() + " - run liquidations forever...");
    await ghr.runLiquidations(batchSize, gasMultiplier, maxGasPrice);
    setInterval(async () => {
        try {
            await ghr.runLiquidations(batchSize, gasMultiplier, maxGasPrice);
        } catch (error) {
            console.error(error);
        }
    }, runAgainIn);
} else {
    console.log(new Date().toISOString() + " - run liquidations...");
    await ghr.runLiquidations(batchSize, gasMultiplier, maxGasPrice);
}
