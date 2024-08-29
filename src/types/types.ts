import type {AddressLike} from "ethers";

type LiquidationParams = {
    source: AddressLike,
    sender: AddressLike,
    receiver: AddressLike
}

export type CriticalAccount = {
    id: AddressLike,
    balanceUntilUpdatedAt: number,
    maybeCriticalAtTimestamp: number,
    isLiquidationEstimateOptimistic: boolean,
    activeIncomingStreamCount: number,
    activeOutgoingStreamCount: number,
    activeGDAOutgoingStreamCount: number,
    activeCFAOutgoingStreamCount: number,
    totalInflowRate: number,
    totalOutflowRate: number,
    totalNetFlowRate: number,
    totalCFAOutflowRate: number,
    totalCFANetFlowRate: number,
    totalGDAOutflowRate: number,
    totalDeposit: number,
    token: Token,
    account: {
        id: AddressLike
    }
}

export type Pair = {
    source: string,
    sender: AddressLike,
    receiver: AddressLike,
    token: AddressLike,
    flowrate: bigint
};

export type Token = {
    decimals: number,
    isListed: boolean,
    isNativeAssetSuperToken: boolean,
    isSuperToken: boolean,
    name: string,
    symbol: string,
    id: AddressLike
}