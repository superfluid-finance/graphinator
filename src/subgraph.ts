import axios, {type AxiosResponse } from 'axios';
import {Contract, type AddressLike, JsonRpcProvider, ethers} from "ethers";
import type {CriticalAccount, Pair} from "./types/types.ts";
const ISuperTokenAbi = require("@superfluid-finance/ethereum-contracts/build/hardhat/contracts/interfaces/superfluid/ISuperToken.sol/ISuperToken.json").abi;

const log = (msg: string, lineDecorator="") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);
const MAX_ITEMS = 1000;
const ZERO = BigInt(0);


class SubGraphReader {

    private subgraphUrl: string;
    private provider: JsonRpcProvider;

    constructor(url: string, provider: JsonRpcProvider) {
        if(!url) {
            throw new Error("Subgraph URL not set");
        }
        this.subgraphUrl = url;
        this.provider = provider;
    }

    // @TODO: refactor, we are mixing two concepts here get critical accounts with subgraph data
    async getCriticalPairs(token: AddressLike, gdaForwarder: Contract, depositConsumedPctThreshold: number): Promise<Pair[]> {

        const returnData: Pair[] = [];
        const criticalAccounts = await this.getCriticalAccountsByTokenNow(token);
        const targetToken = new Contract(token.toString(), ISuperTokenAbi, this.provider);

        if (criticalAccounts.length > 0) {
            for (const account of criticalAccounts) {

                console.log("? Probing ", account.account.id, "token", account.token.id, "net fr", account.totalNetFlowRate, "cfa net fr", account.totalCFANetFlowRate, "gda net fr", await gdaForwarder.getNetFlow(account.token.id, account.account.id));
                const rtb = await targetToken.realtimeBalanceOfNow(account.account.id);
                const { availableBalance, deposit } = rtb;
                if (availableBalance < 0) { // critical or insolvent
                    const consumedDepositPercentage = -Number(availableBalance * 100n / deposit);
                    if (consumedDepositPercentage < depositConsumedPctThreshold) {
                        continue;
                    }

                    const cfaNetFlowRate = BigInt(account.totalCFANetFlowRate);
                    const gdaNetFlowRate = await gdaForwarder.getNetFlow(account.token.id, account.account.id);
                    let netFlowRate = cfaNetFlowRate + gdaNetFlowRate;
                    if (netFlowRate >= ZERO) {
                        continue;
                    }
                    console.log("3! Critical", account.account.id, "token", account.token.id, "net fr", netFlowRate, "(cfa", cfaNetFlowRate, "gda", gdaNetFlowRate, ")");

                    const cfaFlows = await this.getOutgoingFlowsFromAccountByToken(account.token.id, account.account.id);
                    let processedCFAFlows = 0;
                    for (const flow of cfaFlows) {
                        const data = flow.id.split("-");
                        returnData.push({
                            source: "CFA",
                            sender: data[0],
                            receiver: data[1],
                            token: data[2],
                            flowrate: BigInt(flow.currentFlowRate)
                        });
                        netFlowRate += BigInt(flow.currentFlowRate);
                        processedCFAFlows++;
                        if (netFlowRate >= ZERO) {
                            break;
                        }
                    }

                    const gdaFlows = await this.getAllFlowDistributions(account.token.id, account.account.id);
                    let processedGDAFlows = 0;
                    for (const flow of gdaFlows) {
                        const data = flow.id.split("-");
                        const pool = data[1];
                        returnData.push({
                            source: "GDA",
                            sender: account.account.id,
                            receiver: pool,
                            token: account.token.id,
                            flowrate: BigInt(flow.pool.flowRate)
                        });
                        netFlowRate += BigInt(flow.pool.flowRate);
                        processedGDAFlows++;
                        if (netFlowRate >= BigInt(0)) {
                            break;
                        }
                    }

                    console.log(`  available balance ${availableBalance}, deposit ${deposit}, consumed deposit ${consumedDepositPercentage}%, flows to-be-liquidated/total: ${processedCFAFlows}/${cfaFlows.length} cfa | ${processedGDAFlows}/${gdaFlows.length} gda`);
                    if (processedCFAFlows > 0 || processedGDAFlows > 0) {
                        continue;
                    } else {
                        console.log("!!!  no cfa|gda outflows to liquidate");
                    }
                }
            }
        }
        return returnData.sort((a, b) => Number(b.flowrate - a.flowrate));
    }

    async getOutgoingFlowsFromAccountByToken(token: AddressLike, account: AddressLike): Promise<any[]> {
        const _accountLowerCase = account.toString().toLowerCase();
        console.log("_accountLowerCase", _accountLowerCase);

        const _tokenLowerCase = token.toString().toLowerCase();
        console.log("_tokenLowerCase", _tokenLowerCase);
        return this._queryAllPages(
            (lastId: string) => `{
                account(id: "${_accountLowerCase}") {
                    outflows(
                        orderBy: currentFlowRate,
                        orderDirection: desc,
                        where: {
                            token: "${_tokenLowerCase}",
                            id_gt: "${lastId}",
                            currentFlowRate_not: "0",
                    }) {
                        id
                        currentFlowRate
                    }
                }
            }`,
            res => res.data.data.account.outflows,
            i => i
        );
    }

    async getAllFlowDistributions(token: AddressLike, account: AddressLike): Promise<any[]> {
        const _accountLowerCase = account.toString().toLowerCase();
        const _tokenLowerCase = token.toString().toLowerCase();
        return this._queryAllPages(
            (lastId: string) => `{
                poolDistributors(where: {account: "${_accountLowerCase}", id_gt: "${lastId}", pool_: {token: "${_tokenLowerCase}"}, flowRate_gt: "0"}) {
                    id
                    pool {
                        id
                        flowRate
                    }
                }
            }`,
            res => res.data.data.poolDistributors,
            i => i
        );
    }

    async getCriticalAccountsByTokenNow(token: AddressLike): Promise<CriticalAccount[]> {
        const _tokenLowerCase = token.toString().toLowerCase();
        const timestamp = Math.floor(Date.now() / 1000);
        return this._queryAllPages(
            (lastId: string) => `{
                accountTokenSnapshots (first: ${MAX_ITEMS},
                    where: {
                        id_gt: "${lastId}",
                        totalNetFlowRate_lt: 0,
                         maybeCriticalAtTimestamp_lt: ${timestamp}
                        token: "${_tokenLowerCase}"
                    }
                ) {
                    id
                    balanceUntilUpdatedAt
                    maybeCriticalAtTimestamp
                    isLiquidationEstimateOptimistic
                    activeIncomingStreamCount
                    activeOutgoingStreamCount
                    activeGDAOutgoingStreamCount
                    activeCFAOutgoingStreamCount
                    totalInflowRate
                    totalOutflowRate
                    totalNetFlowRate
                    totalCFAOutflowRate
                    totalCFANetFlowRate
                    totalGDAOutflowRate
                    totalDeposit
                    token {
                        id
                        symbol
                    }
                    account {
                        id
                    }
                }
            }`,
            res => res.data.data.accountTokenSnapshots,
            i => i
        );
    }

    async getCriticalAccountsAt(timestamp: number): Promise<CriticalAccount[]> {
        return this._queryAllPages(
            (lastId: string) => `{
                accountTokenSnapshots (first: ${MAX_ITEMS},
                    where: {
                        id_gt: "${lastId}",
                        totalNetFlowRate_lt: 0,
                        maybeCriticalAtTimestamp_lt: ${timestamp}
                    }
                ) {
                    id
                    balanceUntilUpdatedAt
                    maybeCriticalAtTimestamp
                    isLiquidationEstimateOptimistic
                    activeIncomingStreamCount
                    activeOutgoingStreamCount
                    activeGDAOutgoingStreamCount
                    activeCFAOutgoingStreamCount
                    totalInflowRate
                    totalOutflowRate
                    totalNetFlowRate
                    totalCFAOutflowRate
                    totalCFANetFlowRate
                    totalGDAOutflowRate
                    totalDeposit
                    token {
                        id
                        symbol
                    }
                    account {
                        id
                    }
                }
            }`,
            res => res.data.data.accountTokenSnapshots,
            i => i
        );
    }

    async getSuperTokens(isListed: boolean = true): Promise<any[]> {
        return this._queryAllPages(
            (lastId: string) => `{
                tokens(first: ${MAX_ITEMS}, where: {id_gt: "${lastId}", isListed: ${isListed}}) {
                    isListed
                    isNativeAssetSuperToken
                    isSuperToken
                    name
                    symbol
                    id
                }
            }`,
            res => res.data.data.tokens,
            i => i
        );
    }

    /// Subgraph methods
    private async _graphql(query: string, accept?: string): Promise<AxiosResponse<any>> {

        if (!this.subgraphUrl) {
            throw new Error("Subgraph URL not set");
        }

        const headers = {
            //"Authorization": `bearer ${process.env.GITHUB_TOKEN}`,
            //"Accept": accept ? accept : "application/vnd.github.v3+json",
        };

        return await axios.post(this.subgraphUrl, {query}, {headers});
    }

    private async _queryAllPages(queryFn: (lastId: string) => string, toItems: (res: AxiosResponse<any>) => any[], itemFn: (item: any) => any): Promise<any[]> {
        let lastId = "";
        const items: any[] = [];

        while (true) {
            const res = await this._graphql(queryFn(lastId));

            if (res.status !== 200 || res.data.errors) {
                console.error(`bad response ${res.status}`);
                //process.exit(2);
            } else if (res.data === "") {
                console.error("empty response data");
            } else {
                const newItems = toItems(res);
                items.push(...newItems.map(itemFn));

                if (newItems.length < MAX_ITEMS) {
                    break;
                } else {
                    lastId = newItems[newItems.length - 1].id;
                }
            }
        }

        return items;
    }
}

export default SubGraphReader;
