import {type AddressLike, ethers} from "ethers";
import RPC, {ContractManager} from "./rpc.ts";
import type SubGraphReader from "./subgraph.ts";
import type { Pair } from "./subgraph.ts";

const sentinelManifest = require("./sentinel-manifest.json");
console.log(sentinelManifest);

const replacer = (key: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);

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
    private token?: string;

    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private batchContract?: ethers.Contract;
    private gdaForwarder: ethers.Contract;
    private depositConsumedPctThreshold: number;
    private batchContractAddr: string = '';

    constructor(network: string, token?: string) {
        this.provider = new ethers.JsonRpcProvider(`https://${network}.rpc.x.superfluid.dev/`);
        this.subgraph = new SubGraphReader(`https://${network}.subgraph.x.superfluid.dev`, this.provider);
        this.token = token?.toLowerCase();

        const privateKey = this.getPrivateKey();
        this.wallet = new ethers.Wallet(privateKey, this.provider);

        this.depositConsumedPctThreshold = this.getDepositConsumedPctThreshold();
        this.gdaForwarder = new ethers.Contract('0x6DA13Bde224A05a288748d857b9e7DDEffd1dE08', GDAv1Forwarder, this.wallet);

        console.log(`(Graphinator) Initialized for token: ${this.token || 'all tokens'}, wallet: ${this.wallet.address}`);
    }

    private getPrivateKey(): string {
        const privateKey = import.meta.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("No private key provided");
        }
        return privateKey;
    }

    private getDepositConsumedPctThreshold(): number {
        return import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD
            ? Number(import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD)
            : 20;
    }

    async runLiquidations(batchSize: number, gasMultiplier: number): Promise<void> {
        try {
            await this.initializeBatchContract();

            const tokens = await this.getTokensToLiquidate();
            for (const token of tokens) {
                await this.liquidateToken(token, batchSize, gasMultiplier);
            }
        } catch (error) {
            console.error(`(Graphinator) Error running liquidations: ${error}`);
        }
    }

    private async initializeBatchContract(): Promise<void> {
        const chainId: string = (await this.provider.getNetwork()).chainId.toString();
        // @ts-ignore
        this.batchContractAddr = sentinelManifest.networks[chainId]?.batch_contract;
        if (!this.batchContractAddr) {
            throw new Error(`Batch liquidator contract address not found for network ${chainId}`);

        }
        this.batchContract = new ethers.Contract(this.batchContractAddr, BatchContract, this.wallet);
        console.log(`(Graphinator) Initialized batch contract at ${this.batchContractAddr}`);
    }


    private async getTokensToLiquidate(): Promise<string[]> {
        if (!this.token) {
            const tokens = await this.subgraph.getAllTokens(true);
            console.log(`(Graphinator) Found ${tokens.length} tokens to liquidate`);
            return tokens.map(token => token.id);
        } else {
            return [this.token];
        }
    }

    private async liquidateToken(token: string, batchSize: number, gasMultiplier: number): Promise<void> {
        console.log(`(Graphinator) Processing token: ${token}`);
        const accounts = await this.subgraph.getCriticalPairs(ISuperToken, token, this.gdaForwarder, this.depositConsumedPctThreshold);

        if (accounts.length === 0) {
            console.log(`(Graphinator) No accounts to liquidate for token: ${token}`);
            return;
        }

        console.log(`(Graphinator) Found ${accounts.length} streams to liquidate`);
        const accountChunks = this.chunkArray(accounts, batchSize);

        for (const chunk of accountChunks) {
            await this.processChunk(token, chunk, gasMultiplier);
        }
    }

    private chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    private async processChunk(token: string, chunk: any[], gasMultiplier: number): Promise<void> {
        try {
            const txData = await this.generateBatchLiquidationTxData(token, chunk);
            const gasLimit = await this.estimateGasLimit(txData, gasMultiplier);
            await this.sendTransaction(txData, gasLimit);
        } catch (error) {
            console.error(`(Graphinator) Error processing chunk: ${error}`);
        }
    }

    private async generateBatchLiquidationTxData(token: string, liquidationParams: any[]): Promise<{ tx: string, target: string }> {
        const structParams = liquidationParams.map(param => ({
            agreementOperation: param.source === "CFA" ? "0" : "1",
            sender: param.sender,
            receiver: param.receiver,
        }));

        const tx = this.batchContract!.interface.encodeFunctionData('deleteFlows', [token, structParams]);
        return { tx, target: await this.batchContract!.getAddress() };
    }

    private async estimateGasLimit(txData: { tx: string, target: string }, gasMultiplier: number): Promise<number> {
        const gasEstimate = await this.provider.estimateGas({
            to: txData.target,
            data: txData.tx,
        });
        return Math.floor(Number(gasEstimate) * gasMultiplier);
    }

    private async sendTransaction(txData: { tx: string, target: string }, gasLimit: number): Promise<void> {
        const initialGasPrice = (await this.provider.getFeeData()).gasPrice;
        const maxGasPriceMwei = ethers.parseUnits(process.env.MAX_GAS_PRICE_MWEI || '500', 'mwei');

        if (initialGasPrice && initialGasPrice <= maxGasPriceMwei) {
            const tx = {
                to: txData.target,
                data: txData.tx,
                gasLimit,
                gasPrice: initialGasPrice,
                chainId: (await this.provider.getNetwork()).chainId,
                nonce: await this.provider.getTransactionCount(this.wallet.address),
            };

            if (process.env.DRY_RUN) {
                console.log(`(Graphinator) Dry run - tx: ${JSON.stringify(tx, replacer)}`);
            } else {
                const signedTx = await this.wallet.signTransaction(tx);
                const transactionResponse = await this.provider.broadcastTransaction(signedTx);
                const receipt = await transactionResponse.wait();
                console.log(`(Graphinator) Transaction successful: ${receipt?.hash}`);
            }
        } else {
            console.log(`(Graphinator) Gas price ${initialGasPrice} too high, skipping transaction`);
            await this.sleep(1000);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
