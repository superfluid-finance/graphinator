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
        demandOption: true,
        default: process.env.NETWORK
    })
    /*
    Note: there's currently no scientific way to determine a safe batch size.
    That's because the gas consumed by an individual flow's liquidation can vary widely, 
    especially if SuperApp callbacks are involved.
    The safe and default choice is thus 1.
    Most of the time considerably higher values (e.g. 10) will work and may be used.
    But since the logic is currently such that a failing batch could stall any progress,
    setting this differently should be a conscious choice.
    */
    .option('token', {
        alias: 't',
        type: 'string',
        description: 'Address of the Super Token to process. If not set, all "listed" (curated) Super Tokens will be processed',
        default: process.env.TOKEN
    })
    .option('maxGasPriceMwei', {
        alias: 'm',
        type: 'number',
        description: 'Set the max gas price in mwei (milli wei). Default: 10000 (10 gwei)',
        default: process.env.MAX_GAS_PRICE_MWEI ? parseInt(process.env.MAX_GAS_PRICE_MWEI) : 10000
    })
    .option('gasMultiplier', {
        alias: 'g',
        type: 'number',
        description: 'Set the gas multiplier - allows to define the gas limit margin set on top of the estimation',
        default: process.env.GAS_MULTIPLIER ? parseFloat(process.env.GAS_MULTIPLIER) : 1.2
    })
    .option('batchSize', {
        alias: 'b',
        type: 'number',
        description: 'Set the batch size',
        default: process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE) : 1
    })
    .option('loop', {
        alias: 'l',
        type: 'boolean',
        description: 'Set to true to loop forever, false to run once.',
        default: process.env.LOOP === 'true'
    })
    .parse();

const runAgainIn = 30000 //15 * 60 * 1000;
const network = argv.network;
const batchSize = argv.batchSize;
const gasMultiplier = argv.gasMultiplier;
const token = argv.token;
const loop = argv.loop;
const maxGasPrice = argv.maxGasPriceMwei * 1000000;

const ghr = new Graphinator(network, batchSize, gasMultiplier, maxGasPrice);
if(loop) {
    const executeLiquidations = async () => {
        try {
            await ghr.processAll(token);
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
    await ghr.processAll(token);
}
