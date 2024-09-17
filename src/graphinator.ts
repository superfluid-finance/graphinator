import {type AddressLike, ethers, type TransactionLike} from "ethers";
import DataFetcher from "./datafetcher.ts";
import type {Flow} from "./types/types.ts";
import sfMeta from "@superfluid-finance/metadata";
const BatchLiquidatorAbi = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/BatchLiquidator.sol/BatchLiquidator.json").abi;
const GDAv1ForwarderAbi = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/GDAv1Forwarder.sol/GDAv1Forwarder.json").abi;  

const bigIntToStr = (key: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);
const log = (msg: string, lineDecorator="") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);
/**
 * Graphinator is responsible for processing and liquidating flows.
 */
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

    /**
     * Creates an instance of Graphinator.
     * @param networkName - The name of the network.
     * @param batchSize - The size of the batch for processing flows.
     * @param gasMultiplier - The gas multiplier for estimating gas limits.
     * @param maxGasPrice - The maximum gas price allowed.
     */
    constructor(networkName: string, batchSize: number, gasMultiplier: number, maxGasPrice: number) {
        this.batchSize = batchSize;
        this.gasMultiplier = gasMultiplier;
        this.maxGasPrice = maxGasPrice;
        log(`maxGasPrice: ${maxGasPrice} (${maxGasPrice / 1000000000} gwei)`);

        const network = sfMeta.getNetworkByName(networkName);
        if (network === undefined) {
            throw new Error(`network ${networkName} unknown - not in metadata. If the name is correct, you may need to update.`);
        }
        this.provider = new ethers.JsonRpcProvider(`https://rpc-endpoints.superfluid.dev/${networkName}?app=graphinator`);
        this.dataFetcher = new DataFetcher(`https://subgraph-endpoints.superfluid.dev/${networkName}/protocol-v1`, this.provider);

        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("No private key provided");
        }
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        if (!network.contractsV1.gdaV1Forwarder) {
            throw new Error("GDA Forwarder contract address not found in metadata");
        }
        log(`Initialized wallet: ${this.wallet.address}`);

        this.gdaForwarder = new ethers.Contract(network.contractsV1.gdaV1Forwarder!, GDAv1ForwarderAbi, this.wallet);
        if (!network.contractsV1.gdaV1Forwarder) {
            throw new Error("Batch Liquidator contract address not found in metadata");
        }
        this.batchLiquidator = new ethers.Contract(network.contractsV1.batchLiquidator!, BatchLiquidatorAbi, this.wallet);
        log(`Initialized batch contract at ${network.contractsV1.batchLiquidator}`);

        this.depositConsumedPctThreshold = import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD
            ? Number(import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD)
            : 20;
        log(`Will liquidate outflows of accounts with more than ${this.depositConsumedPctThreshold}% of the deposit consumed`);
    }

    // If no token is provided: first get a list of all tokens.
    // Then for the provided or all tokens:
    // get the outgoing flows of all critical accounts, then chunk and batch-liquidate them
    /**
     * Processes all tokens or a specific token to find and liquidate flows.
     * @param token - The address of the token to process. If not provided, all tokens will be processed.
     */
    async processAll(token?: AddressLike): Promise<void> {
        const tokenAddrs = token ? [token] : await this._getSuperTokens();
        for (const tokenAddr of tokenAddrs) {
            const flowsToLiquidate = await this.dataFetcher.getFlowsToLiquidate(tokenAddr, this.gdaForwarder, this.depositConsumedPctThreshold);
            if (flowsToLiquidate.length > 0) {
                log(`Found ${flowsToLiquidate.length} flows to liquidate`);
                const chunks = this._chunkArray(flowsToLiquidate, this.batchSize);
                for (const chunk of chunks) {
                    await this.batchLiquidateFlows(tokenAddr, chunk);
                }
            } else {
                log(`No critical accounts for token: ${tokenAddr}`);
            }
        }
    }

    // Liquidate all flows in one batch transaction.
    // The caller is responsible for sizing the array such that it fits into one transaction.
    // (Note: max digestible size depends on chain and context like account status, SuperApp receiver etc.)
    /**
     * Liquidates all flows in one batch transaction.
     * @param token - The address of the token.
     * @param flows - The array of flows to liquidate.
     */
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
                    log(`Dry run - tx: ${JSON.stringify(tx, bigIntToStr)}`);
                } else {
                    const signedTx = await this.wallet.signTransaction(tx);
                    const transactionResponse = await this.provider.broadcastTransaction(signedTx);
                    const receipt = await transactionResponse.wait();
                    log(`Transaction successful: ${receipt?.hash}`);
                }
            } else {
                log(`Gas price ${initialGasPrice} too high, skipping transaction`);
                await this._sleep(1000);
            }
        } catch (error) {
            console.error(`(Graphinator) Error processing chunk: ${error}`);
        }
    }

    /**
     * Fetches all super tokens.
     * @returns A promise that resolves to an array of super token addresses.
     */
    private async _getSuperTokens(): Promise<AddressLike[]> {
        return (await this.dataFetcher.getSuperTokens())
                .map(token => token.id);
    }

    /**
     * Splits an array into chunks of a specified size.
     * @param array - The array to split.
     * @param size - The size of each chunk.
     * @returns An array of chunks.
     */
    private _chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    /**
     * Generates the transaction data for batch liquidation.
     * @param token - The address of the token.
     * @param flows - The array of flows to liquidate.
     * @returns A promise that resolves to the transaction data.
     */
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

    /**
     * Estimates the gas limit for a transaction.
     * @param transaction - The transaction to estimate the gas limit for.
     * @returns A promise that resolves to the estimated gas limit.
     */
    private async _estimateGasLimit(transaction: TransactionLike): Promise<number> {
        const gasEstimate = await this.provider.estimateGas({
            to: transaction.to,
            data: transaction.data,
        });
        return Math.floor(Number(gasEstimate) * this.gasMultiplier);
    }

    /**
     * Pauses execution for a specified amount of time.
     * @param ms - The number of milliseconds to pause.
     * @returns A promise that resolves after the specified time.
     */
    private async _sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
