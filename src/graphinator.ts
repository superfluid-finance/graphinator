import {type AddressLike, ethers, type TransactionLike} from "ethers";
import SubGraphReader from "./subgraph.ts";

const BatchContract = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/BatchLiquidator.sol/BatchLiquidator.json").abi;
const GDAv1Forwarder = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/GDAv1Forwarder.sol/GDAv1Forwarder.json").abi;  
const sentinelManifest = require("./sentinel-manifest.json");

const replacer = (key: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);

export default class Graphinator {

    private subgraph: SubGraphReader;

    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private batchContract?: ethers.Contract;
    private gdaForwarder: ethers.Contract;

    constructor(network: string) {
        this.provider = new ethers.JsonRpcProvider(`https://${network}.rpc.x.superfluid.dev/`);
        this.subgraph = new SubGraphReader(`https://${network}.subgraph.x.superfluid.dev`, this.provider);
        this.wallet = new ethers.Wallet(this._getPrivateKey(), this.provider);
        // TODO: Refactor to use sentinel manifest
        this.gdaForwarder = new ethers.Contract('0x6DA13Bde224A05a288748d857b9e7DDEffd1dE08', GDAv1Forwarder, this.wallet);
        console.log(`(Graphinator) Initialized wallet: ${this.wallet.address}`);
    }

    async executeLiquidations(batchSize: number, gasMultiplier: number, token?: AddressLike): Promise<void> {
        try {
            await this._initializeBatchContract();
            if(token) {
                await this._liquidateToken(token, batchSize, gasMultiplier);
            } else {
                const tokens = await this._getSuperTokens();
                for (const token of tokens) {
                    await this._liquidateToken(token, batchSize, gasMultiplier);
                }
            }
        } catch (error) {
            console.error(`(Graphinator) Error running liquidations: ${error}`);
        }
    }

    private _getPrivateKey(): string {
        const privateKey = import.meta.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("No private key provided");
        }
        return privateKey;
    }

    private _getDepositConsumedPctThreshold(): number {
        return import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD
            ? Number(import.meta.env.DEPOSIT_CONSUMED_PCT_THRESHOLD)
            : 20;
    }

    private async _initializeBatchContract(): Promise<void> {
        const chainId: string = (await this.provider.getNetwork()).chainId.toString();
        const batchContractAddr = sentinelManifest.networks[chainId]?.batch_contract;
        if (!batchContractAddr) {
            throw new Error(`Batch liquidator contract address not found for network ${chainId}`);

        }
        this.batchContract = new ethers.Contract(batchContractAddr, BatchContract, this.wallet);
        console.log(`(Graphinator) Initialized batch contract at ${batchContractAddr}`);
    }

    private async _getSuperTokens(): Promise<AddressLike[]> {
            const tokens = await this.subgraph.getSuperTokens();
            return tokens.map(token => token.id);
    }

    private async _liquidateToken(tokenAddr: AddressLike, batchSize: number, gasMultiplier: number): Promise<void> {
        const accounts = await this.subgraph.getCriticalPairs(tokenAddr, this.gdaForwarder, this._getDepositConsumedPctThreshold());
        if (accounts.length > 0) {
            console.log(`Found ${accounts.length} streams to liquidate`);
            const accountChunks = this._chunkArray(accounts, batchSize);

            for (const chunk of accountChunks) {
                await this._processChunk(tokenAddr, chunk, gasMultiplier);
            }
        } else {
            console.log(`(Graphinator) No streams to liquidate for token: ${tokenAddr}`);
        }

    }

    private _chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    private async _processChunk(token: AddressLike, chunk: any[], gasMultiplier: number): Promise<void> {
        try {
            const txData = await this._generateBatchLiquidationTxData(token, chunk);
            const gasLimit = await this._estimateGasLimit(txData, gasMultiplier);
            await this._sendTransaction(txData, gasLimit);
        } catch (error) {
            console.error(`(Graphinator) Error processing chunk: ${error}`);
        }
    }

    private async _generateBatchLiquidationTxData(token: AddressLike, liquidationParams: LiquidationParams[]): Promise<TransactionLike> {
        const structParams = liquidationParams.map(param => ({
            agreementOperation: param.source === "CFA" ? "0" : "1",
            sender: param.sender,
            receiver: param.receiver,
        }));
        const transactionData = this.batchContract!.interface.encodeFunctionData('deleteFlows', [token, structParams]);
        const transactionTo = await this.batchContract!.getAddress();
        return { data: transactionData, to: transactionTo };
    }

    private async _estimateGasLimit(transaction: TransactionLike, gasMultiplier: number): Promise<number> {
        const gasEstimate = await this.provider.estimateGas({
            to: transaction.to,
            data: transaction.data,
        });
        return Math.floor(Number(gasEstimate) * gasMultiplier);
    }

    private async _sendTransaction(transaction: TransactionLike, gasLimit: number): Promise<void> {
        const initialGasPrice = (await this.provider.getFeeData()).gasPrice;
        const maxGasPriceMwei = ethers.parseUnits(process.env.MAX_GAS_PRICE_MWEI || '500', 'mwei');

        if (initialGasPrice && initialGasPrice <= maxGasPriceMwei) {
            const tx = {
                to: transaction.to,
                data: transaction.data,
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
            await this._sleep(1000);
        }
    }

    private async _sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /*
    async getPriority(criticalAccount: AddressLike, totalNetFlow: bigint, netFlowThreshold: bigint): Promise<number> {

        const [rtb, isSolvent] = await Promise.all([
                this.superToken.realtimeBalanceOfNow(criticalAccount),
                this.superToken.isAccountSolventNow(criticalAccount)
            ]);

        let { availableBalance, deposit } = rtb;
        availableBalance = -Number(availableBalance);
        deposit = Number(deposit);

        if (deposit === 0) {
            throw new Error("Deposit is zero, can't calculate priority.");
        }
        const consumedDepositPercentage = Math.max(0, Math.min(100, Math.round(availableBalance / deposit * 100)));
        const howFastIsConsuming = Math.abs(Number(totalNetFlow)) / Number(netFlowThreshold);

        // baseline
        let priority = 50n;
        if (!isSolvent) {
            priority += 20n;
        }
        if (howFastIsConsuming > 10) {
            priority += 10n;
        }
        // adjusted to have linear growth and not a step function
        if (totalNetFlow > 0n) {
            priority += (20n * totalNetFlow) / netFlowThreshold;
        }
        // +1 is just to make sure it's not 0 and also to make it 1-100
        const progressBarLength = 50;
        const filledLength = Math.round(consumedDepositPercentage / 100 * progressBarLength);
        const progressBar = '█'.repeat(filledLength) + '-'.repeat(progressBarLength - filledLength);
        log(`acccount ${criticalAccount} deposit consumed: [${progressBar}] ${consumedDepositPercentage}%`, "⚖️");

        const priorityNumber = Number(priority);
        return Math.max(0, Math.min(100, priorityNumber));
    }
    */
}
