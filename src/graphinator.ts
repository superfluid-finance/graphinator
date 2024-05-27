import {type AddressLike, ethers} from "ethers";
import RPC, {ContractManager} from "./rpc.ts";
import type SubGraphReader from "./subgraph.ts";
import type { Pair } from "./subgraph.ts";


type ContractConfig = {
    batchContractAddress: string,
    gdaForwarderAddress: string,
    superTokenAddress: string
}


const log = (msg: string, lineDecorator="") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);

enum Priority {
    HIGH,
    NORMAL,
    LOW
}

export default class Graphinator {

    private subgraph: SubGraphReader;
    private rpc: RPC;
    private contractManager: ContractManager;

    constructor(network: string, config: ContractConfig) {
        if(!network) {
            throw new Error("No network provided");
        }
        if(!config.superTokenAddress) {
            throw new Error("No token provided");
        }

        this.rpc = new RPC(network, config);
        this.subgraph = this.rpc.getSubgraphReader(`https://${network}.subgraph.x.superfluid.dev`);
        this.contractManager = this.rpc.getContractManager();
    }

    async chunkAndLiquidate(priority: Priority, pairs: Pair[], batchSize: number, gasMultiplier: number, maxGasPrice: bigint) {
        // split into chunks
        const chunks = [];
        for (let i = 0; i < pairs.length; i += batchSize) {
            chunks.push(pairs.slice(i, i + batchSize));
        }

        for (const chunk of chunks) {
            const txData = await this.contractManager.generateBatchLiquidationTxDataNewBatch(chunk);
            const gasEstimate = await this.rpc.estimateGas({
                to: txData.target.toString(),
                data: txData.tx
            });
            const gasLimit = Math.floor(Number(gasEstimate) * gasMultiplier);

            const initialGasPrice = (await this.rpc.getFeeData()).gasPrice;
            let gasPrice = maxGasPrice;
            if(import.meta.env.MAX_GAS_PRICE_MWEI) {
                log(`max gas price set to ${import.meta.env.MAX_GAS_PRICE_MWEI} mwei`, "⛽️")
                gasPrice = ethers.parseUnits(import.meta.env.MAX_GAS_PRICE_MWEI, 'mwei');
            }

            let adjustedGasPrice = Number(gasPrice);
            if(priority === Priority.HIGH) {
                adjustedGasPrice = 2.5;
            } else if(priority === Priority.LOW) {
                adjustedGasPrice = 0.5;
            }

            if(initialGasPrice && initialGasPrice <= adjustedGasPrice) {
                // send tx
                const tx = {
                    to: txData.target.toString(),
                    data: txData.tx,
                    gasLimit: gasLimit,
                    gasPrice: initialGasPrice,
                    chainId: (await this.rpc.getNetwork()).chainId,
                    nonce: await this.rpc.getTransactionCount()
                };
                const hash = await this.rpc.signAndSendTransaction(tx);
                log(`hash ${hash}`, "✅");
                // sleep for 3 seconds
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                log(`gas price ${initialGasPrice} too high, skipping tx`, "⛽️");
            }
        }
    }

    async run(batchSize:number, gasMultiplier:number, maxGasPrice:bigint, netFlowThreshold:bigint): Promise<any> {
        try {
            netFlowThreshold = BigInt(72685368696059);
            const pairs = await this.subgraph.getCriticalPairs(netFlowThreshold);

            if (pairs.length === 0) {
                log("no streams to liquidate found");
                return;
            }

            const highPriorityPairs = pairs.filter(pair => pair.priority >= 80);
            const normalPriorityPairs = pairs.filter(pair => pair.priority >= 65 && pair.priority < 80);
            const lowPriorityPairs = pairs.filter(pair => pair.priority < 65);

            console.log("High Priority Pairs: ", highPriorityPairs.length);
            console.log("Normal Priority Pairs: ", normalPriorityPairs.length);
            console.log("Low Priority Pairs: ", lowPriorityPairs.length);


            await this.chunkAndLiquidate(Priority.HIGH, highPriorityPairs, batchSize, gasMultiplier, maxGasPrice);
            await this.chunkAndLiquidate(Priority.NORMAL, normalPriorityPairs, batchSize, gasMultiplier, maxGasPrice);
            await this.chunkAndLiquidate(Priority.LOW, lowPriorityPairs, batchSize, gasMultiplier, maxGasPrice);


        } catch (error) {
            console.error(error);
        }
    }
}
