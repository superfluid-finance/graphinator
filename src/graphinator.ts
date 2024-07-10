import { ethers } from "ethers";
import SubGraphReader from "./subgraph.ts";
const ISuperToken = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/interfaces/superfluid/ISuperToken.sol/ISuperToken.json").abi;
const BatchContract = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/BatchLiquidator.sol/BatchLiquidator.json").abi;
const GDAv1Forwarder = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/GDAv1Forwarder.sol/GDAv1Forwarder.json").abi;
import metadata from "@superfluid-finance/metadata";

const replacer = (k, v) => typeof v === 'bigint' ? v.toString() : v;

export default class Graphinator {
    private subgraph: SubGraphReader;
    private token: string;

    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private batchContract: ethers.Contract;
    private gdaForwarder: ethers.Contract;

    constructor(network: string, token: string) {
        this.provider = new ethers.JsonRpcProvider(`https://${network}.rpc.x.superfluid.dev/`);
        this.subgraph = new SubGraphReader(`https://${network}.subgraph.x.superfluid.dev`, this.provider);
        this.token = token;
        const __privateKey = import.meta.env.PRIVATE_KEY;
        if(!__privateKey) {
            throw new Error("No private key provided");
        }
        // default 20% - which is well into pleb period
        this.depositConsumedPctThreshold = import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD
            ? Number(import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD)
            : 20;
        console.log(`(Graphinator) depositConsumedPctThreshold: ${this.depositConsumedPctThreshold}`);
        this.wallet = new ethers.Wallet(__privateKey, this.provider);

        this.batchContractAddr = metadata.getNetworkByName(network)?.contractsV1?.batchLiquidator;
        if (this.batchContractAddr === undefined) {
            throw new Error(`Batch liquidator contract address not found for network ${network}`);
        }
        this.batchContract = new ethers.Contract(this.batchContractAddr, BatchContract, this.wallet);
        this.gdaForwarder = new ethers.Contract('0x6DA13Bde224A05a288748d857b9e7DDEffd1dE08', GDAv1Forwarder, this.wallet);
    }

    async runLiquidations(batchSize:number, gasMultiplier:number): Promise<any> {
        try {
            const accounts = await this.subgraph.getCriticalPairs(ISuperToken, this.token, this.gdaForwarder, this.depositConsumedPctThreshold);
            if (accounts.length === 0) {
                console.log(`${new Date().toISOString()} - (Graphinator) no accounts to liquidate found`);
                return;
            }
            console.log(`--- ${new Date().toISOString()} - (Graphinator) found ${accounts.length} streams to liquidate ---`);
            //const filteredAccounts = accounts.filter(account => account.token.toLowerCase() === this.token.toLowerCase());
            // TODO: allow token to be undefined for "no filter"
            const filteredAccounts = this.token !== "0x0000000000000000000000000000000000000000"
                ? accounts.filter(account => account.token.toLowerCase() === this.token.toLowerCase())
                : accounts; // filter nothing

            // split into chunks
            const chunks = [];
            for (let i = 0; i < filteredAccounts.length; i += batchSize) {
                chunks.push(filteredAccounts.slice(i, i + batchSize));
            }

            for (const chunk of chunks) {
                const txData = await this.generateBatchLiquidationTxDataNewBatch(this.token, chunk);

                const gasEstimate = await this.provider.estimateGas({
                    to: txData.target.toString(),
                    data: txData.tx
                });

                const gasLimit = Math.floor(Number(gasEstimate) * gasMultiplier);
                const initialGasPrice = (await this.provider.getFeeData()).gasPrice;
                const maxGasPriceMwei = process.env.MAX_GAS_PRICE_MWEI || '500'; // default: 500 mwei = 0.5 gwei
                if(initialGasPrice && initialGasPrice <= (ethers.parseUnits(maxGasPriceMwei, 'mwei'))) {
                    // send tx
                    const tx = {
                        to: txData.target.toString(),
                        data: txData.tx,
                        gasLimit: gasLimit,
                        gasPrice: initialGasPrice,
                        chainId: (await this.provider.getNetwork()).chainId,
                        nonce: await (this.provider.getTransactionCount(this.wallet.address))
                    };

                    if (process.env.DRY_RUN) {
                        console.log(`${new Date().toISOString()} - (Graphinator) dry run - tx: ${JSON.stringify(tx, replacer)}`);
                    } else {
                        const signedTx = await this.wallet.signTransaction(tx);
                        try {
                            const transactionResponse = await this.provider.broadcastTransaction(signedTx);
                            const receipt = await transactionResponse.wait();
                            console.log(`${new Date().toISOString()} - (Graphinator) txhash ${receipt?.hash} - gas price ${initialGasPrice}`);
                        } catch(e) {
                            console.error(`### tx err: ${e}`);
                        }
                    }
                } else {
                    console.log(`${new Date().toISOString()} - (Graphinator) gas price ${initialGasPrice} too high, skipping tx`);
                    const sleep = (ms: number | undefined) => new Promise(resolve => setTimeout(resolve, ms));
                    await sleep(1000);
                }
            }
            // TODO: we abolish this internal loop. That ok?
            /*
            console.log(`${new Date().toISOString()} - (Graphinator) run complete... waiting 30 seconds before next run`);
            // sleep for 30 seconds
            await new Promise(resolve => setTimeout(resolve, 10000));
            // self run until no more accounts to liquidate
            return this.runLiquidations(batchSize, gasMultiplier);
            */
        } catch (error) {
            console.log(error);
        }
    }

    async generateBatchLiquidationTxDataNewBatch(superToken: any, liquidationParams: string | any[]) {
        try {
            let structParams = [];
            for(let i = 0; i < liquidationParams.length; i++) {
                structParams.push({
                    agreementOperation: liquidationParams[i].source === "CFA" ? "0" : "1",
                    sender: liquidationParams[i].sender,
                    receiver: liquidationParams[i].receiver
                })
            }
            const tx = this.batchContract.interface.encodeFunctionData('deleteFlows', [superToken, structParams]);
            return { tx: tx, target: await this.batchContract.getAddress() };
        } catch (error) {
            throw error;
        }
    }
}
