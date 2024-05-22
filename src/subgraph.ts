import axios, {type AxiosResponse } from 'axios';
import {JsonRpcProvider, Contract} from "ethers";

const MAX_ITEMS = 1000;

export type Pair = {
    source: string,
    sender: string,
    receiver: string,
    token: string
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
                process.exit(2);
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

    async getAllOutFlows(token: string, account: string): Promise<string[]> {
        return this.queryAllPages(
            (lastId: string) => `{
                account(id: "${account}") {
                    outflows(where: {
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
            i => i.id
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
                    totalNetFlowRate
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

    async getCriticalPairs(superTokenABI: any, token: string): Promise<Pair[]> {

        const returnData: Pair[] = [];
        const now = Math.floor(Date.now() / 1000);
        const criticalAccounts = await this.subgraph.getAccountsCriticalAt(now);
        const targetToken = new Contract(token, superTokenABI, this.provider);

        if (criticalAccounts.length !== 0) {
            for (const account of criticalAccounts) {
                if(account.token.id.toLowerCase() === "0x1eff3dd78f4a14abfa9fa66579bd3ce9e1b30529".toLowerCase()) {
                    const isCritical = await targetToken.isAccountCriticalNow(account.account.id);
                    if(isCritical) {
                        console.log("Critical account", account.account.id, "for token", account.token.id);
                        const cfaFlows = await this.subgraph.getAllOutFlows(account.token.id, account.account.id);
                        for (const flow of cfaFlows) {
                            const data = flow.split("-");
                            returnData.push({
                                source: "CFA",
                                sender: data[0],
                                receiver: data[1],
                                token: data[2]
                            });
                        }
                    }
                }
            }
        }

        return returnData;
    }
}

export default SubGraphReader;
