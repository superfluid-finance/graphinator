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
                console.error(res.data);
                //process.exit(2);
            }

            const newItems = toItems(res);
            items.push(...newItems.map(itemFn));

            if (newItems.length < MAX_ITEMS) {
                break;
            } else {
                lastId = newItems[newItems.length - 1].id;
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

    async getCriticalPairs(superTokenABI: any, token: string, gdaForwarder: any): Promise<Pair[]> {

        const returnData: Pair[] = [];
        const now = Math.floor(Date.now() / 1000);
        //
        const criticalAccounts = await this.subgraph.getAccountsCriticalAt(now);
        const targetToken = new Contract(token, superTokenABI, this.provider);

        if (criticalAccounts.length !== 0) {
            for (const account of criticalAccounts) {
                if(account.token.id.toLowerCase() === token.toLowerCase()) {
                    const isCritical = await targetToken.isAccountCriticalNow(account.account.id);
                    // sleep 0.5s to avoid rate limiting
                    await new Promise(r => setTimeout(r, 500));
                    if(isCritical) {
                        const cfaNetFlowRate = BigInt(account.totalCFANetFlowRate);
                        const gdaNetFlowRate = await gdaForwarder.getNetFlow(account.token.id, account.account.id);
                        let netFlowRate = cfaNetFlowRate + gdaNetFlowRate;
                        if (netFlowRate >= BigInt(0)) {
                            console.log(`Account ${account.account.id} net fr is ${netFlowRate}, skipping`);
                            continue;
                        }
                        console.log("Critical account", account.account.id, "for token", account.token.id, "net fr", netFlowRate, "cfa net fr", cfaNetFlowRate, "gda net fr", gdaNetFlowRate);
                        //console.log("nr cfa in", account.activeIncomingStreamCount, "nr cfa out", account.activeCFAOutgoingStreamCount, "nr gda out", account.activeGDAOutgoingStreamCount);
                        const cfaFlows = await this.subgraph.getAllOutFlows(account.token.id, account.account.id);
                        const nrFlows = cfaFlows.length;
                        console.log(`  has ${nrFlows} outflows`);
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
                        if (processedFlows > 0) {
                            console.log(`  net fr projected to become positive with ${processedFlows} of ${nrFlows} liquidated`);
                        }
                    }
                }
            }
        }

        // sort by flowrate descending
        return returnData.sort((a, b) => Number(b.flowrate - a.flowrate));
    }
}

export default SubGraphReader;
