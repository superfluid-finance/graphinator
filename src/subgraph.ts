import axios, {type AxiosResponse } from 'axios';
import {JsonRpcProvider, Contract, type AddressLike, type Interface, type InterfaceAbi} from "ethers";
import {type ContractManager, SuperToken} from "./rpc.ts";

const log = (msg: string, lineDecorator="") => console.log(`${new Date().toISOString()} - ${lineDecorator} (Graphinator) ${msg}`);
const MAX_ITEMS = 1000;

export type Pair = {
    source: string,
    sender: string,
    receiver: string,
    token: string,
    flowrate: bigint,
    priority: number
};

class Subgraph {
    private subgraphUrl: string;

    constructor(url: string) {
        if(!url) {
            throw new Error("Subgraph URL not set");
        }
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
    private targetToken: SuperToken;
    private gdaForwarder: Contract;

    constructor(url: string, contractManager: ContractManager) {
        this.subgraph = new Subgraph(url);
        this.targetToken = contractManager.getSuperTokenInstance();
        this.gdaForwarder = contractManager.getGDAForwarderInstance();
    }

    async getCriticalPairs(netFlowThreshold: bigint): Promise<Pair[]> {

        const returnData: Pair[] = [];
        const now = Math.floor(Date.now() / 1000);
        const criticalAccounts = await this.subgraph.getAccountsCriticalAt(now);
        const tokenAddressLowerCase = (await this.targetToken.getAddress()).toLowerCase();

        for (const account of criticalAccounts) {
            if(account.token.id.toLowerCase() === tokenAddressLowerCase) {
                const isCritical = await this.targetToken.isAccountCriticalNow(account.account.id);

                // sleep 0.5s to avoid rate limiting
                await new Promise(r => setTimeout(r, 500));
                if(isCritical) {

                    const cfaNetFlowRate = BigInt(account.totalCFANetFlowRate);
                    const gdaNetFlowRate = await this.gdaForwarder.getNetFlow(account.token.id, account.account.id);
                    let totalNetFlow = cfaNetFlowRate + gdaNetFlowRate;
                    const priority = await this.targetToken.getPriority(account.account.id, totalNetFlow, netFlowThreshold)

                    if (totalNetFlow >= BigInt(0)) {
                        log(`account ${account.account.id} netFlowRate ${totalNetFlow}, skipping`, "⏭️");
                        continue;
                    }

                    const cfaFlows = await this.subgraph.getAllOutFlows(account.token.id, account.account.id);
                    const nrFlows = cfaFlows.length;
                    log(`account ${account.account.id} netFlowRate ${totalNetFlow} with cfaNetFlowRate ${cfaNetFlowRate} & gdaNetFlowRate ${gdaNetFlowRate}`, "⚠️");
                    log(`\t|--------------> has ${nrFlows} outflows`, "⚖️");
                    let processedFlows = 0;
                    for (const flow of cfaFlows) {
                        const data = flow.id.split("-");
                        returnData.push({
                            source: "CFA",
                            sender: data[0],
                            receiver: data[1],
                            token: data[2],
                            flowrate: BigInt(flow.currentFlowRate),
                            priority: priority
                        });
                        totalNetFlow += BigInt(flow.currentFlowRate);
                        //console.log(`CFA flow: ${data[0]} -> ${data[1]}: ${flow.currentFlowRate} - projected acc net flow rate now: ${netFlowRate}`);
                        processedFlows++;
                        if (totalNetFlow >= BigInt(0)) {
                            break;
                        }
                    }
                    if (processedFlows > 0) {
                        log(`netFlowRate projected to become positive with ${processedFlows} of ${nrFlows} liquidated`, "🔄");
                    }
                }
            }
        }

        // sort by flowrate descending
        return returnData.sort((a, b) => Number(b.flowrate - a.flowrate));
    }
}

export default SubGraphReader;
