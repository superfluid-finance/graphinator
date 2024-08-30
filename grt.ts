#!/usr/bin/env bun

import path from "path";
import dotenv from "dotenv";

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import Graphinator from './src/graphinator';

const log = (msg: string, lineDecorator="") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);

dotenv.config();

const argv = await yargs(hideBin(process.argv))
    .option('network', {
        alias: 'n',
        type: 'string',
        description: 'Set the network',
        default: process.env.NETWORK || 'base-mainnet'
    })
    .option('batchSize', {
        alias: 'b',
        type: 'number',
        description: 'Set the batch size',
        default: process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE) : 15
    })
    .option('gasMultiplier', {
        alias: 'g',
        type: 'number',
        description: 'Set the gas multiplier',
        default: process.env.GAS_MULTIPLIER ? parseFloat(process.env.GAS_MULTIPLIER) : 1.2
    })
    .option('token', {
        alias: 't',
        type: 'string',
        description: 'Set the token to liquidate',
        default: process.env.TOKEN
    })
    .option('loop', {
        alias: 'l',
        type: 'boolean',
        description: 'Set to true to loop forever, false to run once',
        default: process.env.LOOP === 'true'
    })
    .option('maxGasPrice', {
        alias: 'm',
        type: 'number',
        description: 'Set the max gas price',
        default: process.env.MAX_GAS_PRICE ? parseInt(process.env.MAX_GAS_PRICE) : 500000000
    })
    .parse();

const runAgainIn = 30000 //15 * 60 * 1000;
const network = argv.network;
const batchSize = argv.batchSize;
const gasMultiplier = argv.gasMultiplier;
const token = argv.token;
const loop = argv.loop;
const maxGasPrice = argv.maxGasPrice;

const ghr = new Graphinator(network);
if(loop) {
    const executeLiquidations = async () => {
        try {
            await ghr.executeLiquidations(batchSize, gasMultiplier, maxGasPrice, token);
        } catch (error) {
            console.error(error);
        } finally {
            log(`run again in ${runAgainIn}`);
            setTimeout(executeLiquidations, runAgainIn); // Schedule the next run
        }
    };
    await executeLiquidations();
} else {
    log(new Date().toISOString() + " - run liquidations...");
    await ghr.executeLiquidations(batchSize, gasMultiplier, maxGasPrice, token);
}
