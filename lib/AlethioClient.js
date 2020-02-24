"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const verror_1 = require("verror");
const transaction_1 = require("./transaction");
const regEx_1 = require("./regEx");
const utils_1 = require("./utils");
const debug = require('debug')('tx2uml');
const alethioBaseUrls = {
    mainnet: 'https://api.aleth.io/v1',
    ropsten: 'https://api.ropsten.aleth.io/v1',
    rinkeby: 'https://api.rinkebyaleth.io/v1',
    kovan: 'https://api.kovan.aleth.io/v1',
};
exports.getTransactionDetails = async (txHash, apiKey, network = "mainnet") => {
    var _a, _b, _c, _d;
    if (!txHash.match(regEx_1.transactionHash)) {
        throw new TypeError(`Transaction hash "${txHash}" must be 32 bytes in hexadecimal format with a 0x prefix`);
    }
    try {
        if (apiKey) {
            axios_1.default.defaults.headers.common["Authorization"] = apiKey;
        }
        const response = await axios_1.default.get(`${alethioBaseUrls[network]}/transactions/${txHash}`);
        if (!((_b = (_a = response === null || response === void 0 ? void 0 : response.data) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.attributes)) {
            throw new Error(`no transaction attributes in Alethio response: ${response === null || response === void 0 ? void 0 : response.data}`);
        }
        if (!((_d = (_c = response === null || response === void 0 ? void 0 : response.data) === null || _c === void 0 ? void 0 : _c.data) === null || _d === void 0 ? void 0 : _d.relationships)) {
            throw new Error(`no transaction relationships in Alethio response: ${response === null || response === void 0 ? void 0 : response.data}`);
        }
        const attributes = response.data.data.attributes;
        const relationships = response.data.data.relationships;
        const details = {
            hash: txHash,
            nonce: attributes.txNonce,
            index: attributes.txIndex,
            value: BigInt(attributes.value),
            gasPrice: BigInt(attributes.txGasPrice),
            timestamp: new Date(attributes.blockCreationTime * 1000),
            status: !attributes.msgError,
            error: attributes.msgErrorString,
        };
        const firstMessage = {
            id: 0,
            type: convertType(attributes.msgType),
            from: relationships.from.data.id,
            to: relationships.to.data.id,
            value: BigInt(attributes.value),
            payload: attributes.msgPayload,
            gasUsed: BigInt(attributes.txGasUsed),
            gasLimit: BigInt(attributes.msgGasLimit),
            callDepth: 0,
            status: !attributes.msgError,
            error: attributes.msgErrorString,
        };
        debug(`Got tx details and first message from Alethio:\ndetails: ${utils_1.stringify(details)}\nfirst message: ${utils_1.stringify(firstMessage)}`);
        return [details, firstMessage];
    }
    catch (err) {
        throw new verror_1.VError(err, `Failed to get transaction details for hash ${txHash} from Alethio`);
    }
};
exports.getContractMessages = async (txHash, apiKey, network = "mainnet") => {
    var _a, _b, _c, _d;
    if (!txHash.match(regEx_1.transactionHash)) {
        throw new TypeError(`Transaction hash "${txHash}" must be 32 bytes in hexadecimal format with a 0x prefix`);
    }
    let messages = [];
    try {
        if (apiKey) {
            axios_1.default.defaults.headers.common["Authorization"] = apiKey;
        }
        // get the contract messages
        const response = await axios_1.default.get(`${alethioBaseUrls[network]}/transactions/${txHash}/contractMessages`, {
            params: {
                "page[limit]": 100,
            }
        });
        if (!Array.isArray((_a = response === null || response === void 0 ? void 0 : response.data) === null || _a === void 0 ? void 0 : _a.data)) {
            throw new Error(`no contract messages in Alethio response ${response === null || response === void 0 ? void 0 : response.data}`);
        }
        for (const contractMessage of response.data.data) {
            messages.push({
                id: contractMessage.attributes.cmsgIndex,
                type: convertType(contractMessage.attributes.msgType),
                from: contractMessage.relationships.from.data.id,
                to: contractMessage.relationships.to.data.id,
                value: BigInt(contractMessage.attributes.value),
                payload: contractMessage.attributes.msgPayload,
                gasUsed: BigInt(contractMessage.attributes.msgGasUsed),
                gasLimit: BigInt(contractMessage.attributes.msgGasLimit),
                callDepth: contractMessage.attributes.msgCallDepth,
                status: !contractMessage.attributes.msgError,
                error: contractMessage.attributes.msgErrorString,
            });
        }
        debug(`Got ${messages.length} messages from Alethio`);
        // handle more than 100 contract messages
        if ((_d = (_c = (_b = response.data) === null || _b === void 0 ? void 0 : _b.meta) === null || _c === void 0 ? void 0 : _c.page) === null || _d === void 0 ? void 0 : _d.hasNext) {
            const nextCursor = response.data.links.next.split('=').pop();
            messages = await getContractMessagesRecursive(txHash, nextCursor, messages);
        }
        // sort by contract message id
        const sortedMessages = messages.sort((a, b) => a.id - b.id);
        debug(`Sorted ${sortedMessages.length} messages in total from Alethio`);
        return sortedMessages;
    }
    catch (err) {
        throw new verror_1.VError(err, `Failed to get contract messages for transaction hash ${txHash} from Alethio`);
    }
};
const getContractMessagesRecursive = async (txHash, cursor, messages = [], apiKey, network = "mainnet") => {
    var _a, _b, _c, _d;
    if (!txHash.match(regEx_1.transactionHash)) {
        throw new TypeError(`Transaction hash "${txHash}" must be 32 bytes in hexadecimal format with a 0x prefix`);
    }
    if (!cursor) {
        throw new TypeError(`Missing Alethio pagination cursor "${cursor}"`);
    }
    let cursorMessages = [];
    try {
        if (apiKey) {
            axios_1.default.defaults.headers.common["Authorization"] = apiKey;
        }
        const response = await axios_1.default.get(`${alethioBaseUrls[network]}/transactions/${txHash}/contractMessages`, {
            params: {
                "page[limit]": 100,
                "page[next]": cursor,
            }
        });
        if (!Array.isArray((_a = response === null || response === void 0 ? void 0 : response.data) === null || _a === void 0 ? void 0 : _a.data)) {
            throw new Error(`no contract messages in Alethio response ${response === null || response === void 0 ? void 0 : response.data}`);
        }
        for (const contractMessage of response.data.data) {
            cursorMessages.push({
                id: contractMessage.attributes.cmsgIndex,
                type: convertType(contractMessage.attributes.msgType),
                from: contractMessage.relationships.from.data.id,
                to: contractMessage.relationships.to.data.id,
                value: BigInt(contractMessage.attributes.value),
                payload: contractMessage.attributes.msgPayload,
                gasUsed: BigInt(contractMessage.attributes.msgGasUsed),
                gasLimit: BigInt(contractMessage.attributes.msgGasLimit),
                callDepth: contractMessage.attributes.msgCallDepth,
                status: !contractMessage.attributes.msgError,
                error: contractMessage.attributes.msgErrorString,
            });
        }
        const allMessages = messages.concat(cursorMessages);
        debug(`Got ${cursorMessages.length} messages of ${allMessages.length} for cursor ${cursor} from Alethio`);
        // handle more than 100 contract messages
        if ((_d = (_c = (_b = response.data) === null || _b === void 0 ? void 0 : _b.meta) === null || _c === void 0 ? void 0 : _c.page) === null || _d === void 0 ? void 0 : _d.hasNext) {
            const nextCursor = response.data.links.next.split('=').pop();
            return getContractMessagesRecursive(txHash, nextCursor, allMessages);
        }
        return allMessages;
    }
    catch (err) {
        throw new verror_1.VError(err, `Failed to get contract messages for transaction hash ${txHash} from Alethio`);
    }
};
const convertType = (msgType) => {
    let type = transaction_1.MessageType.Call;
    if (msgType === "ValueContractMsg" || msgType === "ValueTx") {
        type = transaction_1.MessageType.Value;
    }
    else if (msgType === "CreateContractMsg" || msgType === "CreateTx") {
        type = transaction_1.MessageType.Value;
    }
    else if (msgType === "SelfdestructContractMsg" || msgType === "SelfdestructTx") {
        type = transaction_1.MessageType.Selfdestruct;
    }
    return type;
};
//# sourceMappingURL=AlethioClient.js.map