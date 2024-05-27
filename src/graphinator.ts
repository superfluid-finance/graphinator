import {type AddressLike, ethers} from "ethers";
import RPC, {ContractManager} from "./rpc.ts";
import type SubGraphReader from "./subgraph.ts";


type ContractConfig = {
    batchContractAddress: string,
    gdaForwarderAddress: string,
    superTokenAddress: string
}


const log = (msg: string, lineDecorator="") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);

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

    async run(batchSize:number, gasMultiplier:number, maxGasPrice:bigint): Promise<any> {
        try {
            const pairs = await this.subgraph.getCriticalPairs();
            if (pairs.length === 0) {
                log("no streams to liquidate found");
                return;
            }
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

                if(initialGasPrice && initialGasPrice <= gasPrice) {
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
            log("run complete... waiting 30 seconds before next run");
            // sleep for 30 seconds
            await new Promise(resolve => setTimeout(resolve, 10000));
            // self run until no more accounts to liquidate
            return this.run(batchSize, gasMultiplier, maxGasPrice);
        } catch (error) {
            console.error(error);
        }
    }
}
