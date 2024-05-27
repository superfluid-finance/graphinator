import {ethers, type AddressLike, Interface, type InterfaceAbi, type TransactionRequest} from "ethers";
import SubGraphReader from "./subgraph.ts";

const ISuperToken = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/interfaces/superfluid/ISuperToken.sol/ISuperToken.json").abi;
const BatchContract = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/BatchLiquidator.sol/BatchLiquidator.json").abi;
const GDAv1Forwarder = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/utils/GDAv1Forwarder.sol/GDAv1Forwarder.json").abi;

type TransactionData = {
    data: string,
    to: AddressLike
}

// Manages RPC calls and smart contract interactions
export default class RPC {

    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private contractManager: ContractManager;

    constructor(networkName: string, config: { batchContractAddress: string; gdaForwarderAddress: string; superTokenAddress: string; } ) {
        this.provider = new ethers.JsonRpcProvider(`https://${networkName}.rpc.x.superfluid.dev/`);
        const __privateKey = import.meta.env.PRIVATE_KEY;
        if(!__privateKey) {
            throw new Error("No private key provided");
        }

        this.wallet = new ethers.Wallet(__privateKey, this.provider);
        this.contractManager = new ContractManager(config, this.wallet);
    }

    async estimateGas(txData: TransactionData): Promise<bigint> {
        return await this.provider.estimateGas(txData);
    }

    async getFeeData(): Promise<ethers.FeeData> {
        return await this.provider.getFeeData();
    }

    async getNetwork(): Promise<ethers.Network> {
        return await this.provider.getNetwork();
    }

    async getInstanceOfContract(address: AddressLike, abi: Interface | InterfaceAbi,) {
        address = await address;
        return new ethers.Contract(address, abi, this.wallet);
    }

    async getTransactionCount(): Promise<number> {
        return await this.provider.getTransactionCount(this.wallet.address);
    }

    getContractManager() {
        return this.contractManager;
    }

    getSubgraphReader(subgraphUrl: string) {
        return new SubGraphReader(subgraphUrl, this.contractManager);
    }

    getProvider() {
        return this.provider;
    }

    async signAndSendTransaction(tx: TransactionRequest) {
        const signedTx = await this.wallet.signTransaction(tx);
        const transactionResponse = await this.provider.broadcastTransaction(signedTx);
        const receipt = await transactionResponse.wait();
        return receipt?.hash;
    }
}

// Holds the contract addresses and ABIs
export class ContractManager {

    private batchContract: ethers.Contract;
    private gdaForwarder: ethers.Contract;
    private superToken: ethers.Contract;

    constructor(config: { batchContractAddress: string; gdaForwarderAddress: string; superTokenAddress: string; }, wallet: ethers.Wallet) {

        this.batchContract = new ethers.Contract(config.batchContractAddress, BatchContract, wallet);
        this.gdaForwarder = new ethers.Contract(config.gdaForwarderAddress, GDAv1Forwarder, wallet);
        this.superToken = new ethers.Contract(config.superTokenAddress, ISuperToken, wallet);
    }

    getBatchContractInstance() {
        return this.batchContract;
    }

    getGDAForwarderInstance() {
        return this.gdaForwarder;
    }

    getSuperTokenInstance() {
        return this.superToken;
    }

    async generateBatchLiquidationTxDataNewBatch(liquidationParams: string | any[])  {
        const superToken = await this.superToken.getAddress();
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
            console.error(error);
            throw error;
        }
    }
}