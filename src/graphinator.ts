import { ethers } from "ethers";
import SubGraphReader from "./subgraph.ts";
const ISuperToken = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/interfaces/superfluid/ISuperToken.sol/ISuperToken.json").abi;
const BatchContract = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/BatchLiquidator.sol/BatchLiquidator.json").abi;


export default class Graphinator {
    private subgraph: SubGraphReader;
    private token: string;

    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private batchContract: ethers.Contract;

    constructor(network: string, token: string) {
        this.provider = new ethers.JsonRpcProvider(`https://${network}.rpc.x.superfluid.dev/`);
        this.subgraph = new SubGraphReader(`https://${network}.subgraph.x.superfluid.dev`, this.provider);
        this.token = token;
        const __privateKey = import.meta.env.PRIVATE_KEY;
        if(!__privateKey) {
            throw new Error("No private key provided");
        }
        this.wallet = new ethers.Wallet(__privateKey, this.provider);
        this.batchContract = new ethers.Contract('0x6b008BAc0e5846cB5d9Ca02ca0e801fCbF88B6f9', BatchContract, this.wallet);
    }

    async runLiquidations(batchSize:number, gasMultiplier:number, maxGasPrice:number): Promise<any> {
        try {
            const accounts = await this.subgraph.getCriticalPairs(ISuperToken, this.token);
            if (accounts.length === 0) {
                console.log(`${new Date().toISOString()} - (Graphinator) no accounts to liquidate found`);
                return;
            }
            const filteredAccounts = accounts.filter(account => account.token.toLowerCase() === this.token.toLowerCase());

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
                if(initialGasPrice && initialGasPrice <= maxGasPrice) {
                    // send tx
                    const tx = {
                        to: txData.target.toString(),
                        data: txData.tx,
                        gasLimit: gasLimit,
                        gasPrice: initialGasPrice,
                        chainId: (await this.provider.getNetwork()).chainId,
                        nonce: await (this.provider.getTransactionCount(this.wallet.address))
                    };

                    const signedTx = await this.wallet.signTransaction(tx);
                    const transactionResponse = await this.provider.broadcastTransaction(signedTx);
                    const receipt = await transactionResponse.wait();
                    console.log(`${new Date().toISOString()} - (Graphinator) txhash ${receipt?.hash}`);
                    // sleep for 3 seconds
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } else {
                    console.log(`${new Date().toISOString()} - (Graphinator) gas price too high, skipping tx`);
                }
            }
            console.log(`${new Date().toISOString()} - (Graphinator) run complete... waiting 30 seconds before next run`);
            // sleep for 30 seconds
            await new Promise(resolve => setTimeout(resolve, 10000));
            // self run until no more accounts to liquidate
            return this.runLiquidations(batchSize, gasMultiplier);
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