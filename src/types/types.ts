import type {AddressLike} from "ethers";

export type LiquidationParams = {
    source: string,
    sender: AddressLike,
    receiver: AddressLike
}

export type CriticalAccount = {
    id: AddressLike,
    totalNetFlowRate: number,
    totalCFANetFlowRate: number,
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