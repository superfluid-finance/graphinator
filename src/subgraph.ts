import axios, {type AxiosResponse } from 'axios';
import {JsonRpcProvider, Contract} from "ethers";

const MAX_ITEMS = 1000;

export type Pair = {
    source: string,
    sender: string,
    receiver: string,
    token: string,
    flowrate: bigint
};

class Subgraph {
    private subgraphUrl: string;

    constructor(url: string) {
        this.subgraphUrl = url;
    }

    async graphql(query: string, accept?: string): Promise<AxiosResponse<any>> {
        if (!this.subgraphUrl) {
            throw new Error("Subgraph URL not set");
        }

        const headers = {
            //"Authorization": `bearer ${process.env.GITHUB_TOKEN}`,
            //"Accept": accept ? accept : "application/vnd.github.v3+json",
        };

        return await axios.post(this.subgraphUrl, {query}, {headers});
    }

    async queryAllPages(queryFn: (lastId: string) => string, toItems: (res: AxiosResponse<any>) => any[], itemFn: (item: any) => any): Promise<any[]> {
        let lastId = "";
        const items: any[] = [];

        while (true) {
            const res = await this.graphql(queryFn(lastId));

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

    async getAllOutFlows(token: string, account: string): Promise<any[]> {
        // TODO: order change broke pagination. We don't really need pagination here though
        return this.queryAllPages(
            (lastId: string) => `{
                account(id: "${account}") {
                    outflows(
                        orderBy: currentFlowRate,
                        orderDirection: desc,
                        where: {
                            token: "${token}",
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

    async getAccountsCriticalAt(timestamp: number): Promise<any[]> {
        return this.queryAllPages(
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
}

class SubGraphReader {
    private subgraph: Subgraph;
    private provider

    constructor(url: string, provider: JsonRpcProvider) {
        this.subgraph = new Subgraph(url);
        this.provider = provider;
    }

    async getCriticalPairs(superTokenABI: any, token: string, gdaForwarder: any, depositConsumedPctThreshold: number): Promise<Pair[]> {

        const returnData: Pair[] = [];
        const now = Math.floor(Date.now() / 1000);
        // gets all critical accounts in any superToken
        const criticalAccounts = await this.subgraph.getAccountsCriticalAt(now);
        //const targetToken = new Contract(token, superTokenABI, this.provider);

        if (criticalAccounts.length !== 0) {
            for (const account of criticalAccounts) {
                console.log("? Probing ", account.account.id, "token", account.token.id, "net fr", account.totalNetFlowRate, "cfa net fr", account.totalCFANetFlowRate, "gda net fr", await gdaForwarder.getNetFlow(account.token.id, account.account.id));
                const targetToken = new Contract(account.token.id, superTokenABI, this.provider);
                //if(account.token.id.toLowerCase() === token.toLowerCase()) {
//                    const isCritical = await targetToken.isAccountCriticalNow(account.account.id);
                    const rtb = await targetToken.realtimeBalanceOfNow(account.account.id);
                    let { availableBalance, deposit } = rtb;
                    if (availableBalance < 0) { // critical or insolvent
                        //console.log("  available balance", availableBalance, "deposit", deposit);
                        const consumedDepositPercentage = -Number(availableBalance * 100n / deposit); //Math.max(0, Math.min(100, Math.round(-Number(availableBalance) / Number(deposit) * 100)));
                        //console.log("  consumed deposit", consumedDepositPercentage, "%");

                        if (consumedDepositPercentage < depositConsumedPctThreshold) {
                            //console.log(`  deposit consumed percentage ${consumedDepositPercentage} < ${depositConsumedPctThreshold}, skipping`);
                            continue;
                        }

//                    if(isCritical) {
                        const cfaNetFlowRate = BigInt(account.totalCFANetFlowRate);
                        const gdaNetFlowRate = await gdaForwarder.getNetFlow(account.token.id, account.account.id);
                        let netFlowRate = cfaNetFlowRate + gdaNetFlowRate;
                        if (netFlowRate >= BigInt(0)) {
                            //console.log(`account ${account.account.id} net fr is ${netFlowRate}, skipping`);
                            continue;
                        }
                        console.log("! Critical", account.account.id, "token", account.token.id, "net fr", netFlowRate, "(cfa", cfaNetFlowRate, "gda", gdaNetFlowRate, ")");

                        //console.log("nr cfa in", account.activeIncomingStreamCount, "nr cfa out", account.activeCFAOutgoingStreamCount, "nr gda out", account.activeGDAOutgoingStreamCount);
                        const cfaFlows = await this.subgraph.getAllOutFlows(account.token.id, account.account.id);
                        const nrFlows = cfaFlows.length;
                        let processedFlows = 0;
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
                            //console.log(`CFA flow: ${data[0]} -> ${data[1]}: ${flow.currentFlowRate} - projected acc net flow rate now: ${netFlowRate}`);
                            processedFlows++;
                            if (netFlowRate >= BigInt(0)) {
                                break;
                            }
                        }
                        console.log("  available balance", availableBalance, "deposit", deposit, "consumed deposit", consumedDepositPercentage, "%", nrFlows, "cfa outflows", processedFlows, "of", nrFlows, "to be liquidated");
                        if (processedFlows > 0) {
                            //console.log(`  net fr projected to become positive with ${processedFlows} of ${nrFlows} liquidated`);
                        } else {
                            console.log("!!!  no cfa outflows to liquidate");

                        }
                    }
                //}
            }
        }

        // sort by flowrate descending
        // TODO: this doesn't make much sense anymore in multi-token mode
        return returnData.sort((a, b) => Number(b.flowrate - a.flowrate));
    }
}

export default SubGraphReader;
