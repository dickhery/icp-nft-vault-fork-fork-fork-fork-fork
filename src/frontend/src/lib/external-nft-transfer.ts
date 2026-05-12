import type { Collection, WalletNFT } from "@/types";
import type { IDL } from "@dfinity/candid";
import { Actor, HttpAgent, type HttpAgentOptions } from "@icp-sdk/core/agent";
import { Principal, getCrc32 } from "@icp-sdk/core/principal";
import { sha224 } from "@noble/hashes/sha2";

type TransferIdentity = {
  getPrincipal: () => Principal;
};

type VariantRecord = Record<string, unknown>;

type ExtUser = { principal: Principal } | { address: string };
type ExtTransferRequest = {
  from: ExtUser;
  to: ExtUser;
  token: string;
  amount: bigint;
  fee: [] | [bigint];
  memo: Uint8Array;
  notify: boolean;
  subaccount: [] | [Uint8Array];
};
type ExtTransferResponse = { ok: bigint } | { err: unknown };
type ExtTransferActor = {
  ext_transfer: (request: ExtTransferRequest) => Promise<ExtTransferResponse>;
  transfer: (request: ExtTransferRequest) => Promise<ExtTransferResponse>;
};

type Dip721Response = { Ok: bigint } | { Err: unknown };
type Dip721TransferActor = {
  transfer: (to: Principal, tokenId: bigint) => Promise<Dip721Response>;
  dip721_transfer: (to: Principal, tokenId: bigint) => Promise<Dip721Response>;
  transferFromDip721: (
    from: Principal,
    to: Principal,
    tokenId: bigint,
  ) => Promise<Dip721Response>;
};

type Icrc7TransferResult = { Ok: bigint } | { Err: unknown };
type Icrc7TransferActor = {
  icrc7_transfer: (
    args: Array<{
      from_subaccount: [] | [Uint8Array];
      to: { owner: Principal; subaccount: [] | [Uint8Array] };
      token_id: bigint;
      memo: [] | [Uint8Array];
      created_at_time: [] | [bigint];
    }>,
  ) => Promise<Array<[] | [Icrc7TransferResult]>>;
};

const IC_HOST = "https://icp-api.io";
const ZERO_SUBACCOUNT = new Uint8Array(32);
const DOMAIN_SEPARATOR = new TextEncoder().encode("\x0Aaccount-id");

export async function transferOwnedExternalNFT({
  collection,
  nft,
  owner,
  recipient,
  identity,
}: {
  collection: Collection;
  nft: WalletNFT;
  owner: Principal;
  recipient: Principal;
  identity: TransferIdentity;
}): Promise<string> {
  if (collection.kind !== "External") {
    throw new Error("Only imported external NFTs use direct wallet transfer");
  }

  const agent = HttpAgent.createSync({
    host: IC_HOST,
    identity,
  } as HttpAgentOptions);

  switch (collection.standard.__kind__) {
    case "EXT":
      return transferExtNFT(agent, collection, nft, owner, recipient);
    case "DIP721":
      return transferDip721NFT(agent, collection, nft, owner, recipient);
    case "ICRC7":
      return transferIcrc7NFT(agent, collection, nft, recipient);
    case "Other":
      throw new Error(
        `Transfers are not supported for ${collection.standard.Other} collections`,
      );
  }
}

async function transferExtNFT(
  agent: HttpAgent,
  collection: Collection,
  nft: WalletNFT,
  owner: Principal,
  recipient: Principal,
): Promise<string> {
  const actor = Actor.createActor<ExtTransferActor>(extTransferIdlFactory, {
    agent,
    canisterId: collection.canisterId.toString(),
  });
  const token = normalizeExtTokenIdentifier(collection.canisterId, nft.tokenId);
  const ownerAccountId = accountIdentifier(owner);
  const attempts: Array<{
    label: string;
    run: () => Promise<ExtTransferResponse>;
  }> = [
    {
      label: "ext_transfer from principal",
      run: () =>
        actor.ext_transfer(
          extTransferRequest(
            token,
            { principal: owner },
            { principal: recipient },
          ),
        ),
    },
    {
      label: "transfer from principal",
      run: () =>
        actor.transfer(
          extTransferRequest(
            token,
            { principal: owner },
            { principal: recipient },
          ),
        ),
    },
    {
      label: "ext_transfer from account address",
      run: () =>
        actor.ext_transfer(
          extTransferRequest(
            token,
            { address: ownerAccountId },
            { principal: recipient },
          ),
        ),
    },
    {
      label: "transfer from account address",
      run: () =>
        actor.transfer(
          extTransferRequest(
            token,
            { address: ownerAccountId },
            { principal: recipient },
          ),
        ),
    },
  ];

  let lastError = "EXT transfer method not available";
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      if ("ok" in result) return "External NFT transferred successfully";
      lastError = `${attempt.label}: ${extTransferErrorToText(result.err)}`;
    } catch (error) {
      lastError = `${attempt.label}: ${errorToMessage(error)}`;
    }
  }
  throw new Error(lastError);
}

async function transferDip721NFT(
  agent: HttpAgent,
  collection: Collection,
  nft: WalletNFT,
  owner: Principal,
  recipient: Principal,
): Promise<string> {
  const tokenId = parseNumericTokenId(nft.tokenId, "DIP721");
  const actor = Actor.createActor<Dip721TransferActor>(
    dip721TransferIdlFactory,
    {
      agent,
      canisterId: collection.canisterId.toString(),
    },
  );
  const attempts: Array<{
    label: string;
    run: () => Promise<Dip721Response>;
  }> = [
    {
      label: "transfer",
      run: () => actor.transfer(recipient, tokenId),
    },
    {
      label: "dip721_transfer",
      run: () => actor.dip721_transfer(recipient, tokenId),
    },
    {
      label: "transferFromDip721",
      run: () => actor.transferFromDip721(owner, recipient, tokenId),
    },
  ];

  let lastError = "DIP721 transfer method not available";
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      if ("Ok" in result) return "External NFT transferred successfully";
      lastError = `${attempt.label}: ${dip721ErrorToText(result.Err)}`;
    } catch (error) {
      lastError = `${attempt.label}: ${errorToMessage(error)}`;
    }
  }
  throw new Error(lastError);
}

async function transferIcrc7NFT(
  agent: HttpAgent,
  collection: Collection,
  nft: WalletNFT,
  recipient: Principal,
): Promise<string> {
  const tokenId = parseNumericTokenId(nft.tokenId, "ICRC-7");
  const actor = Actor.createActor<Icrc7TransferActor>(icrc7TransferIdlFactory, {
    agent,
    canisterId: collection.canisterId.toString(),
  });

  let result: Array<[] | [Icrc7TransferResult]>;
  try {
    result = await actor.icrc7_transfer([
      {
        from_subaccount: [],
        to: { owner: recipient, subaccount: [] },
        token_id: tokenId,
        memo: [],
        created_at_time: [],
      },
    ]);
  } catch (error) {
    throw new Error(`ICRC-7 transfer call failed: ${errorToMessage(error)}`);
  }

  if (result.length === 0 || result[0].length === 0) {
    throw new Error("ICRC-7 transfer was not processed");
  }
  const transfer = result[0][0];
  if ("Ok" in transfer) return "External NFT transferred successfully";
  throw new Error(
    `ICRC-7 transfer rejected: ${icrc7ErrorToText(transfer.Err)}`,
  );
}

function extTransferRequest(
  token: string,
  from: ExtUser,
  to: ExtUser,
): ExtTransferRequest {
  return {
    from,
    to,
    token,
    amount: 1n,
    fee: [],
    memo: new Uint8Array(),
    notify: false,
    subaccount: [],
  };
}

function normalizeExtTokenIdentifier(
  canisterId: Principal,
  tokenId: string,
): string {
  if (!/^\d+$/.test(tokenId)) return tokenId;
  return extTokenIdentifier(canisterId, Number(tokenId));
}

function extTokenIdentifier(canisterId: Principal, tokenIndex: number): string {
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, tokenIndex, false);
  return Principal.fromUint8Array(
    concatBytes(
      new Uint8Array([10, 116, 105, 100]),
      canisterId.toUint8Array(),
      indexBytes,
    ),
  ).toText();
}

function accountIdentifier(principal: Principal): string {
  const hash = sha224(
    concatBytes(DOMAIN_SEPARATOR, principal.toUint8Array(), ZERO_SUBACCOUNT),
  );
  const checksum = getCrc32(hash);
  const checksumBytes = new Uint8Array(4);
  new DataView(checksumBytes.buffer).setUint32(0, checksum, false);
  return toHex(concatBytes(checksumBytes, hash));
}

function parseNumericTokenId(tokenId: string, standard: string): bigint {
  if (!/^\d+$/.test(tokenId)) {
    throw new Error(`${standard} token IDs must be numeric`);
  }
  return BigInt(tokenId);
}

function extTransferErrorToText(error: unknown): string {
  const tag = variantTag(error);
  switch (tag) {
    case "Unauthorized":
      return "Unauthorized";
    case "InsufficientBalance":
      return "Insufficient balance";
    case "Rejected":
      return "Transfer rejected by the collection canister";
    case "InvalidToken":
      return `Invalid token: ${variantValueText(error, tag)}`;
    case "CannotNotify":
      return "The recipient could not be notified";
    case "Other":
      return variantValueText(error, tag);
    default:
      return unknownValueText(error);
  }
}

function dip721ErrorToText(error: unknown): string {
  const tag = variantTag(error);
  switch (tag) {
    case "Unauthorized":
      return "Unauthorized";
    case "InvalidTokenId":
      return "Invalid token ID";
    case "ZeroAddress":
      return "Cannot transfer to the zero address";
    case "Other":
      return variantValueText(error, tag);
    case "ExistedNFT":
      return "NFT already exists";
    case "SelfTransfer":
      return "Cannot transfer an NFT to the same owner";
    case "TokenNotFound":
      return "Token not found";
    case "OwnerNotFound":
      return "Owner not found";
    case "OperatorNotFound":
      return "Operator not found";
    case "SelfApprove":
      return "Cannot approve yourself";
    case "UnauthorizedOwner":
      return "Unauthorized owner";
    case "UnauthorizedOperator":
      return "Unauthorized operator";
    default:
      return unknownValueText(error);
  }
}

function icrc7ErrorToText(error: unknown): string {
  const tag = variantTag(error);
  switch (tag) {
    case "NonExistingTokenId":
      return "Token does not exist";
    case "InvalidRecipient":
      return "Invalid recipient";
    case "Unauthorized":
      return "Unauthorized";
    case "TooOld":
      return "Transfer request is too old";
    case "CreatedInFuture":
      return "Transfer timestamp is in the future";
    case "Duplicate":
      return "Duplicate transfer detected";
    case "GenericError":
    case "GenericBatchError": {
      const value = variantValue(error, tag);
      if (isRecord(value) && typeof value.message === "string") {
        return value.message;
      }
      return unknownValueText(value);
    }
    default:
      return unknownValueText(error);
  }
}

function variantTag(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return Object.keys(value)[0] ?? null;
}

function variantValue(value: unknown, tag: string | null): unknown {
  if (!tag || !isRecord(value)) return undefined;
  return value[tag];
}

function variantValueText(value: unknown, tag: string | null): string {
  return unknownValueText(variantValue(value, tag));
}

function unknownValueText(value: unknown): string {
  if (value === null || value === undefined) return "Unknown error";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return unknownValueText(error);
}

function isRecord(value: unknown): value is VariantRecord {
  return value !== null && typeof value === "object";
}

function concatBytes(...parts: Array<Uint8Array>): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const extTransferIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const AccountIdentifier = IDL.Text;
  const User = IDL.Variant({
    principal: IDL.Principal,
    address: AccountIdentifier,
  });
  const TransferRequest = IDL.Record({
    from: User,
    to: User,
    token: IDL.Text,
    amount: IDL.Nat,
    fee: IDL.Opt(IDL.Nat),
    memo: IDL.Vec(IDL.Nat8),
    notify: IDL.Bool,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const TransferError = IDL.Variant({
    CannotNotify: AccountIdentifier,
    InsufficientBalance: IDL.Null,
    InvalidToken: IDL.Text,
    Rejected: IDL.Null,
    Unauthorized: AccountIdentifier,
    Other: IDL.Text,
  });
  const TransferResponse = IDL.Variant({
    ok: IDL.Nat,
    err: TransferError,
  });
  return IDL.Service({
    ext_transfer: IDL.Func([TransferRequest], [TransferResponse], []),
    transfer: IDL.Func([TransferRequest], [TransferResponse], []),
  });
};

const dip721TransferIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Dip721Error = IDL.Variant({
    Unauthorized: IDL.Null,
    InvalidTokenId: IDL.Null,
    ZeroAddress: IDL.Null,
    Other: IDL.Text,
    ExistedNFT: IDL.Null,
    SelfTransfer: IDL.Null,
    TokenNotFound: IDL.Null,
    OwnerNotFound: IDL.Null,
    OperatorNotFound: IDL.Null,
    SelfApprove: IDL.Null,
    UnauthorizedOwner: IDL.Null,
    UnauthorizedOperator: IDL.Null,
  });
  const Result = IDL.Variant({ Ok: IDL.Nat, Err: Dip721Error });
  return IDL.Service({
    transfer: IDL.Func([IDL.Principal, IDL.Nat], [Result], []),
    dip721_transfer: IDL.Func([IDL.Principal, IDL.Nat], [Result], []),
    transferFromDip721: IDL.Func(
      [IDL.Principal, IDL.Principal, IDL.Nat],
      [Result],
      [],
    ),
  });
};

const icrc7TransferIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const TransferArg = IDL.Record({
    from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
    to: Account,
    token_id: IDL.Nat,
    memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
    created_at_time: IDL.Opt(IDL.Nat64),
  });
  const TransferError = IDL.Variant({
    NonExistingTokenId: IDL.Null,
    InvalidRecipient: IDL.Null,
    Unauthorized: IDL.Null,
    TooOld: IDL.Null,
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
    Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
    GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }),
    GenericBatchError: IDL.Record({
      error_code: IDL.Nat,
      message: IDL.Text,
    }),
  });
  const TransferResult = IDL.Variant({
    Ok: IDL.Nat,
    Err: TransferError,
  });
  return IDL.Service({
    icrc7_transfer: IDL.Func(
      [IDL.Vec(TransferArg)],
      [IDL.Vec(IDL.Opt(TransferResult))],
      [],
    ),
  });
};
