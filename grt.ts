#!/usr/bin/env bun

import path from "path";
import dotenv from "dotenv";

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
        default: undefined
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

const runAgainIn = 30000//15 * 60 * 1000;
const network = argv.network;
const batchSize = argv.batchSize;
const gasMultiplier = argv.gasMultiplier;
const token = argv.token;
const loop = argv.loop;
const maxGasPrice = BigInt(argv.maxGasPrice);


if (network === undefined) {
    // TODO: probably not a valid code path
    dotenv.config();
} else {
    dotenv.config({ path: path.resolve(__dirname, `.env_${network}`) });


const ghr = new Graphinator(network, config);
if(loop) {

    const executeLiquidations = async () => {
        console.log(`running`);

        try {
            await ghr.run(batchSize, gasMultiplier, maxGasPrice, BigInt(0));
        } catch (error) {
            console.error(error);
        } finally {
            console.log(`run again in ${runAgainIn}`);
            setTimeout(executeLiquidations, runAgainIn); // Schedule the next run
        }
    };
    executeLiquidations();
} else {

    console.log(new Date().toISOString() + " - run liquidations...");
    await ghr.runLiquidations(batchSize, gasMultiplier);
}
