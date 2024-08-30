import {type AddressLike, ethers, type TransactionLike} from "ethers";
import DataFetcher from "./datafetcher.ts";
import type {Flow} from "./types/types.ts";
import sfMeta from "@superfluid-finance/metadata";

const BatchLiquidatorAbi = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/BatchLiquidator.sol/BatchLiquidator.json").abi;
const GDAv1ForwarderAbi = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/GDAv1Forwarder.sol/GDAv1Forwarder.json").abi;  

const bigIntToStr = (key: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);

export default class Graphinator {

    private dataFetcher: DataFetcher;
    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private gdaForwarder: ethers.Contract;
    private batchLiquidator: ethers.Contract;
    private depositConsumedPctThreshold: number;
    private batchSize: number;
    private gasMultiplier: number;
    private maxGasPrice: number;

    constructor(networkName: string, batchSize: number, gasMultiplier: number, maxGasPrice: number) {
        this.batchSize = batchSize;
        this.gasMultiplier = gasMultiplier;
        this.maxGasPrice = maxGasPrice;
        console.log(`maxGasPrice: ${maxGasPrice} (${maxGasPrice / 1000000000} gwei)`);

        const network = sfMeta.getNetworkByName(networkName);
        if (network === undefined) {
            throw new Error(`network ${networkName} unknown - not in metadata. If the name is correct, you may need to update.`);
        }
        this.provider = new ethers.JsonRpcProvider(`https://rpc-endpoints.superfluid.dev/${networkName}?app=graphinator`);
        this.dataFetcher = new DataFetcher(`https://subgraph-endpoints.superfluid.dev/${networkName}/protocol-v1`, this.provider);

        const privateKey = import.meta.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("No private key provided");
        }
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        if (!network.contractsV1.gdaV1Forwarder) {
            throw new Error("GDA Forwarder contract address not found in metadata");
        }
        console.log(`(Graphinator) Initialized wallet: ${this.wallet.address}`);

        this.gdaForwarder = new ethers.Contract(network.contractsV1.gdaV1Forwarder!, GDAv1ForwarderAbi, this.wallet);
        if (!network.contractsV1.gdaV1Forwarder) {
            throw new Error("Batch Liquidator contract address not found in metadata");
        }
        this.batchLiquidator = new ethers.Contract(network.contractsV1.batchLiquidator!, BatchLiquidatorAbi, this.wallet);
        console.log(`(Graphinator) Initialized batch contract at ${network.contractsV1.batchLiquidator}`);

        this.depositConsumedPctThreshold = import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD
            ? Number(import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD)
            : 20;
        console.log(`(Graphinator) Will liquidate outflows of accounts with more than ${this.depositConsumedPctThreshold}% of the deposit consumed`);
    }

    // If no token is provided: first get a list of all tokens.
    // Then for the provided or all tokens:
    // get the outgoing flows of all critical accounts, then chunk and batch-liquidate them
    async processAll(token?: AddressLike): Promise<void> {
        const tokenAddrs = token ? [token] : await this._getSuperTokens();
        for (const tokenAddr of tokenAddrs) {
            const flowsToLiquidate = await this.dataFetcher.getFlowsToLiquidate(tokenAddr, this.gdaForwarder, this.depositConsumedPctThreshold);
            if (flowsToLiquidate.length > 0) {
                console.log(`Found ${flowsToLiquidate.length} flows to liquidate`);
                const chunks = this._chunkArray(flowsToLiquidate, this.batchSize);
                for (const chunk of chunks) {
                    await this.batchLiquidateFlows(tokenAddr, chunk);
                }
            } else {
                console.log(`(Graphinator) No critical accounts for token: ${tokenAddr}`);
            }
        }
    }

    // Liquidate all flows in one batch transaction.
    // The caller is responsible for sizing the array such that it fits into one transaction.
    // (Note: max digestible size depends on chain and context like account status, SuperApp receiver etc.)
    private async batchLiquidateFlows(token: AddressLike, flows: Flow[]): Promise<void> {
        try {
            const txData = await this._generateBatchLiquidationTxData(token, flows);
            const gasLimit = await this._estimateGasLimit(txData);
            const initialGasPrice = (await this.provider.getFeeData()).gasPrice;

            if (initialGasPrice && initialGasPrice <= this.maxGasPrice) {
                const tx = {
                    to: txData.to,
                    data: txData.data,
                    gasLimit,
                    gasPrice: initialGasPrice,
                    chainId: (await this.provider.getNetwork()).chainId,
                    nonce: await this.provider.getTransactionCount(this.wallet.address),
                };

                if (process.env.DRY_RUN) {
                    console.log(`(Graphinator) Dry run - tx: ${JSON.stringify(tx, bigIntToStr)}`);
                } else {
                    const signedTx = await this.wallet.signTransaction(tx);
                    const transactionResponse = await this.provider.broadcastTransaction(signedTx);
                    const receipt = await transactionResponse.wait();
                    console.log(`(Graphinator) Transaction successful: ${receipt?.hash}`);
                }
            } else {
                console.log(`(Graphinator) Gas price ${initialGasPrice} too high, skipping transaction`);
                await this._sleep(1000);
            }
        } catch (error) {
            console.error(`(Graphinator) Error processing chunk: ${error}`);
        }
    }

    private async _getSuperTokens(): Promise<AddressLike[]> {
        return (await this.dataFetcher.getSuperTokens())
                .map(token => token.id);
    }

    private _chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }


    private async _generateBatchLiquidationTxData(token: AddressLike, flows: Flow[]): Promise<TransactionLike> {
        if (!flows.every(flow => flow.token === token)) {
            throw new Error("flow with wrong token");
        }
        const structParams = flows.map(flows => ({
            agreementOperation: flows.agreementType,
            sender: flows.sender,
            receiver: flows.receiver,
        }));
        const transactionData = this.batchLiquidator!.interface.encodeFunctionData('deleteFlows', [token, structParams]);
        const transactionTo = await this.batchLiquidator!.getAddress();
        return { data: transactionData, to: transactionTo };
    }

    private async _estimateGasLimit(transaction: TransactionLike): Promise<number> {
        const gasEstimate = await this.provider.estimateGas({
            to: transaction.to,
            data: transaction.data,
        });
        return Math.floor(Number(gasEstimate) * this.gasMultiplier);
    }

    private async _sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
