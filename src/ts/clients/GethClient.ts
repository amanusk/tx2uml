import axios from "axios"
import { BigNumber, providers } from "ethers"
import { VError } from "verror"

import { MessageType, Trace, TransactionDetails } from "../transaction"
import { transactionHash } from "../utils/regEx"
import { Provider } from "@ethersproject/providers"
import { hexlify, toUtf8String } from "ethers/lib/utils"
import EthereumNodeClient from "./EthereumNodeClient"

require("axios-debug-log")
const debug = require("debug")("tx2uml")

export type CallResponse = {
    type:
        | "CALL"
        | "CALLCODE"
        | "CREATE"
        | "CREATE2"
        | "DELEGATECALL"
        | "SELFDESTRUCT"
        | "STATICCALL"
    from?: string
    to?: string
    input?: string
    output?: string
    value?: string
    gas?: string
    gasUsed?: string
    time?: string
    error?: string
    calls?: CallResponse[]
}

export default class GethClient extends EthereumNodeClient {
    public readonly provider: Provider
    private jsonRpcId = 0

    constructor(
        public readonly url: string = "http://localhost:8545",
        public readonly network = "mainnet"
    ) {
        super(url, network)
        this.provider = new providers.JsonRpcProvider(url, network)
    }

    async getTransactionTrace(txHash: string): Promise<Trace[]> {
        if (!txHash?.match(transactionHash)) {
            throw new TypeError(
                `Transaction hash "${txHash}" must be 32 bytes in hexadecimal format with a 0x prefix`
            )
        }

        try {
            debug(`About to get transaction trace for ${txHash}`)
            const response = await axios.post(this.url, {
                id: this.jsonRpcId++,
                jsonrpc: "2.0",
                method: "debug_traceTransaction",
                params: [txHash, { tracer: "callTracer" }],
            })

            if (response.data?.error?.message) {
                throw new Error(response.data.error.message)
            }
            if (!response?.data?.result?.from) {
                if (response?.data?.result?.structLogs) {
                    throw new Error(
                        `Have you set the --nodeType option correctly? It looks like a debug_traceTransaction was run against a node that doesn't support tracing in their debugging API.`
                    )
                }
                throw new Error(
                    `no transaction trace messages in response. ${response?.data?.result}`
                )
            }

            // recursively add the traces
            const traces: Trace[] = []
            addTraces(response.data.result, traces, 0, 0)

            debug(
                `Got ${traces.length} traces actions for tx hash ${txHash} from ${this.url}`
            )

            return traces
        } catch (err) {
            throw new VError(
                err,
                `Failed to get transaction trace for tx hash ${txHash} from url ${this.url}.`
            )
        }
    }

    async getTransactionError(tx: TransactionDetails): Promise<string> {
        if (!tx?.hash.match(transactionHash)) {
            throw TypeError(
                `There is no transaction hash on the receipt object`
            )
        }
        if (tx.status) {
            return undefined
        }
        if (tx.gasUsed === tx.gasLimit) {
            throw Error("Transaction failed as it ran out of gas.")
        }

        let rawMessageData
        try {
            const params = [
                {
                    nonce: tx.nonce,
                    gasPrice: convertBigNumber2Hex(tx.gasPrice),
                    gas: convertBigNumber2Hex(tx.gasLimit),
                    value: convertBigNumber2Hex(tx.value),
                    from: tx.from,
                    to: tx.to,
                    data: tx.data,
                },
                // need to call for the block before
                hexlify(tx.blockNumber - 1).replace(/^0x0/, "0x"),
            ]
            const response = await axios.post(this.url, {
                id: this.jsonRpcId++,
                jsonrpc: "2.0",
                method: "eth_call",
                params,
            })

            return response.data?.error?.message
        } catch (e) {
            if (e.message.startsWith("Node error: ")) {
                // Trim "Node error: "
                const errorObjectStr = e.message.slice(12)
                // Parse the error object
                const errorObject = JSON.parse(errorObjectStr)

                if (!errorObject.data) {
                    throw Error(
                        "Failed to parse data field error object:" +
                            errorObjectStr
                    )
                }

                if (errorObject.data.startsWith("Reverted 0x")) {
                    // Trim "Reverted 0x" from the data field
                    rawMessageData = errorObject.data.slice(11)
                } else if (errorObject.data.startsWith("0x")) {
                    // Trim "0x" from the data field
                    rawMessageData = errorObject.data.slice(2)
                } else {
                    throw Error(
                        "Failed to parse data field of error object:" +
                            errorObjectStr
                    )
                }
            } else {
                throw Error(
                    "Failed to parse error message from Ethereum call: " +
                        e.message
                )
            }
        }

        return parseReasonCode(rawMessageData)
    }
}

// Adds calls from a Geth debug_traceTransaction API response to the traces
const addTraces = (
    callResponse: CallResponse,
    traces: Trace[],
    id: number,
    depth: number,
    parentTrace?: Trace
): number => {
    const type = convertType(callResponse)
    const delegatedFrom =
        parentTrace?.type === MessageType.DelegateCall
            ? parentTrace.to
            : callResponse.from
    const newTrace: Trace = {
        id: id++,
        type,
        from: callResponse.from,
        delegatedFrom,
        to: callResponse.to,
        value: callResponse.value
            ? convertBigNumber(callResponse.value)
            : BigNumber.from(0),
        // remove trailing 64 zeros
        inputs: callResponse.input,
        inputParams: [], // Will init later once we have the contract ABI
        funcSelector:
            callResponse.input?.length >= 10
                ? callResponse.input.slice(0, 10)
                : undefined,
        outputs: callResponse.output,
        outputParams: [], // Will init later once we have the contract ABI
        gasLimit: convertBigNumber(callResponse.gas),
        gasUsed: convertBigNumber(callResponse.gasUsed),
        parentTrace,
        childTraces: [],
        depth,
        error: callResponse.error,
    }
    if (parentTrace) {
        parentTrace.childTraces.push(newTrace)
    }
    traces.push(newTrace)
    if (callResponse.calls) {
        callResponse.calls.forEach(childCall => {
            // recursively add traces
            id = addTraces(childCall, traces, id, depth + 1, newTrace)
        })
    }
    return id
}

const convertType = (trace: CallResponse): MessageType => {
    let type: MessageType = MessageType.Call
    if (trace.type === "DELEGATECALL") {
        return MessageType.DelegateCall
    }
    if (trace.type === "STATICCALL") {
        return MessageType.StaticCall
    }
    if (trace.type === "CREATE" || trace.type === "CREATE2") {
        return MessageType.Create
    } else if (trace.type === "SELFDESTRUCT") {
        return MessageType.Selfdestruct
    }
    return type
}

// convert an integer value to a decimal value. eg wei to Ethers which is to 18 decimal places
const convertBigNumber = (value: string): BigNumber | undefined => {
    if (!value) return undefined
    return BigNumber.from(value)
}

const convertBigNumber2Hex = (value: BigNumber) => {
    return value.toHexString().replace(/^0x0/, "0x")
}

export const parseReasonCode = (messageData: string): string => {
    // Get the length of the revert reason
    const strLen = parseInt(messageData.slice(8 + 64, 8 + 128), 16)
    // Using the length and known offset, extract and convert the revert reason
    const reasonCodeHex = messageData.slice(8 + 128, 8 + 128 + strLen * 2)
    // Convert reason from hex to string
    const reason = toUtf8String("0x" + reasonCodeHex)

    return reason
}
