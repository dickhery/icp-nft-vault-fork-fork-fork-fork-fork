import type { Collection, NFTMetadata, WalletNFT } from "@/types";
import type { IDL } from "@dfinity/candid";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal, getCrc32 } from "@icp-sdk/core/principal";
import { sha224 } from "@noble/hashes/sha2";

type ExtActor = {
  tokens_ext?: (accountId: string) => Promise<unknown>;
  tokens?: (accountId: string) => Promise<unknown>;
  ext_metadata?: (tokenId: string) => Promise<unknown>;
  metadata?: (tokenId: string) => Promise<unknown>;
};

type Dip721Actor = {
  dip721_owner_token_identifiers?: (owner: Principal) => Promise<unknown>;
  ownerTokenIdentifiers?: (owner: Principal) => Promise<unknown>;
  dip721_token_metadata?: (tokenId: bigint) => Promise<unknown>;
  tokenMetadata?: (tokenId: bigint) => Promise<unknown>;
};

type Icrc7Actor = {
  icrc7_tokens_of?: (
    account: { owner: Principal; subaccount: [] },
    prev: [] | [bigint],
    take: [] | [bigint],
  ) => Promise<Array<bigint>>;
  icrc7_token_metadata?: (tokenIds: Array<bigint>) => Promise<Array<unknown>>;
};

const RAW_DOMAIN = "raw.icp0.io";
const PAGE_SIZE = 100n;
const MAX_PAGES = 50;
const ZERO_SUBACCOUNT = new Uint8Array(32);
const DOMAIN_SEPARATOR = new TextEncoder().encode("\x0Aaccount-id");

let mainnetAgent: HttpAgent | null = null;

function agent(): HttpAgent {
  mainnetAgent ??= HttpAgent.createSync({ host: "https://icp-api.io" });
  return mainnetAgent;
}

export async function previewOwnedNFTsFromCollections(
  collections: Array<Collection>,
  owner: Principal,
): Promise<Array<WalletNFT>> {
  const settled = await Promise.allSettled(
    collections.map((collection) => previewOwnedNFTs(collection, owner)),
  );
  return mergeNFTs(
    settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    ),
  );
}

async function previewOwnedNFTs(
  collection: Collection,
  owner: Principal,
): Promise<Array<WalletNFT>> {
  if (collection.kind !== "External") return [];
  if (collection.standard.__kind__ === "EXT") {
    return previewExtNFTs(collection, owner);
  }
  if (collection.standard.__kind__ === "DIP721") {
    return previewDip721NFTs(collection, owner);
  }
  if (collection.standard.__kind__ === "ICRC7") {
    return previewIcrc7NFTs(collection, owner);
  }
  return [];
}

async function previewExtNFTs(
  collection: Collection,
  owner: Principal,
): Promise<Array<WalletNFT>> {
  const canisterId = collection.canisterId.toString();
  const actor = Actor.createActor<ExtActor>(extIdlFactory, {
    agent: agent(),
    canisterId,
  });
  const accountIds = [accountIdentifier(owner), owner.toHex().toLowerCase()];
  const tokenIndices = new Set<number>();
  for (const accountId of accountIds) {
    for (const tokenIndex of await extTokenIndices(actor, accountId)) {
      tokenIndices.add(tokenIndex);
    }
  }
  const nfts: Array<WalletNFT> = [];
  for (const tokenIndex of Array.from(tokenIndices).sort((a, b) => a - b)) {
    const tokenId = extTokenIdentifier(collection.canisterId, tokenIndex);
    const metadata = await extMetadata(actor, collection, tokenId, tokenIndex);
    nfts.push(walletPreview(collection, owner, tokenId, metadata, tokenIndex));
  }
  return nfts;
}

async function previewDip721NFTs(
  collection: Collection,
  owner: Principal,
): Promise<Array<WalletNFT>> {
  const canisterId = collection.canisterId.toString();
  const actor = Actor.createActor<Dip721Actor>(dip721IdlFactory, {
    agent: agent(),
    canisterId,
  });
  const tokenIds =
    (await dip721TokenIds(actor, owner, "dip721_owner_token_identifiers")) ??
    (await dip721TokenIds(actor, owner, "ownerTokenIdentifiers")) ??
    [];
  const nfts: Array<WalletNFT> = [];
  for (const tokenId of tokenIds) {
    const metadata = await dip721Metadata(actor, collection, tokenId);
    nfts.push(walletPreview(collection, owner, tokenId.toString(), metadata));
  }
  return nfts;
}

async function previewIcrc7NFTs(
  collection: Collection,
  owner: Principal,
): Promise<Array<WalletNFT>> {
  const canisterId = collection.canisterId.toString();
  const actor = Actor.createActor<Icrc7Actor>(icrc7IdlFactory, {
    agent: agent(),
    canisterId,
  });
  if (typeof actor.icrc7_tokens_of !== "function") return [];
  const tokenIds: Array<bigint> = [];
  const seenTokenIds = new Set<string>();
  let prev: [] | [bigint] = [];
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page = await actor.icrc7_tokens_of({ owner, subaccount: [] }, prev, [
      PAGE_SIZE,
    ]);
    for (const tokenId of page) {
      const key = tokenId.toString();
      if (!seenTokenIds.has(key)) {
        seenTokenIds.add(key);
        tokenIds.push(tokenId);
      }
    }
    if (page.length < Number(PAGE_SIZE)) break;
    const nextPrev = page[page.length - 1];
    const previousCursor = prev.length === 0 ? null : prev[0];
    if (previousCursor === nextPrev) break;
    prev = [nextPrev];
  }
  const metadataByToken = await icrc7Metadata(actor, tokenIds);
  return tokenIds.map((tokenId) =>
    walletPreview(
      collection,
      owner,
      tokenId.toString(),
      metadataByToken.get(tokenId.toString()) ??
        fallbackMetadata(collection, tokenId.toString()),
    ),
  );
}

async function extTokenIndices(
  actor: ExtActor,
  accountId: string,
): Promise<Array<number>> {
  const values = new Set<number>();
  const rich = await callOptional(() => actor.tokens_ext?.(accountId));
  for (const tokenIndex of extTokenIndicesFromResult(rich)) {
    values.add(tokenIndex);
  }
  const legacy = await callOptional(() => actor.tokens?.(accountId));
  for (const tokenIndex of extTokenIndicesFromResult(legacy)) {
    values.add(tokenIndex);
  }
  return Array.from(values);
}

function extTokenIndicesFromResult(result: unknown): Array<number> {
  if (!result || typeof result !== "object" || !("ok" in result)) return [];
  const ok = (result as { ok: unknown }).ok;
  if (!Array.isArray(ok)) return [];
  return ok
    .map((entry) => {
      if (Array.isArray(entry)) return Number(entry[0]);
      return Number(entry);
    })
    .filter((value) => Number.isInteger(value) && value >= 0);
}

async function extMetadata(
  actor: ExtActor,
  collection: Collection,
  tokenId: string,
  tokenIndex: number,
): Promise<NFTMetadata> {
  const fallback = fallbackMetadata(collection, tokenIndex.toString(), {
    imageUrl: rawThumbnailUrl(collection.canisterId, tokenIndex.toString()),
  });
  const rich = await callOptional(() => actor.ext_metadata?.(tokenId));
  const richMetadata = metadataFromExtRich(rich, fallback);
  if (richMetadata) return richMetadata;
  const legacy = await callOptional(() => actor.metadata?.(tokenId));
  return metadataFromExtLegacy(legacy, fallback) ?? fallback;
}

async function dip721TokenIds(
  actor: Dip721Actor,
  owner: Principal,
  method: "dip721_owner_token_identifiers" | "ownerTokenIdentifiers",
): Promise<Array<bigint> | null> {
  const fn = actor[method];
  if (typeof fn !== "function") return null;
  const result = await callOptional(() => fn(owner));
  if (!result || typeof result !== "object" || !("Ok" in result)) return [];
  const ok = (result as { Ok: unknown }).Ok;
  if (!Array.isArray(ok)) return [];
  return ok.map((value) => BigInt(value as bigint | number | string));
}

async function dip721Metadata(
  actor: Dip721Actor,
  collection: Collection,
  tokenId: bigint,
): Promise<NFTMetadata> {
  const fallback = fallbackMetadata(collection, tokenId.toString());
  const result =
    (await callOptional(() => actor.dip721_token_metadata?.(tokenId))) ??
    (await callOptional(() => actor.tokenMetadata?.(tokenId)));
  if (!result || typeof result !== "object" || !("Ok" in result)) {
    return fallback;
  }
  return metadataFromProperties(
    (result as { Ok: { properties?: Array<[string, unknown]> } }).Ok
      .properties ?? [],
    fallback,
  );
}

async function icrc7Metadata(
  actor: Icrc7Actor,
  tokenIds: Array<bigint>,
): Promise<Map<string, NFTMetadata>> {
  const byToken = new Map<string, NFTMetadata>();
  if (
    typeof actor.icrc7_token_metadata !== "function" ||
    tokenIds.length === 0
  ) {
    return byToken;
  }
  const result = await callOptional(() =>
    actor.icrc7_token_metadata?.(tokenIds),
  );
  if (!Array.isArray(result)) return byToken;
  for (
    let index = 0;
    index < tokenIds.length && index < result.length;
    index++
  ) {
    const tokenId = tokenIds[index].toString();
    const entries = icrc7MetadataEntries(result[index]);
    if (!entries) continue;
    byToken.set(
      tokenId,
      metadataFromProperties(entries, {
        attributes: [],
      }),
    );
  }
  return byToken;
}

function icrc7MetadataEntries(value: unknown): Array<[string, unknown]> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries =
    value.length === 1 &&
    Array.isArray(value[0]) &&
    !looksLikeMetadataEntry(value[0])
      ? value[0]
      : value;
  if (!Array.isArray(entries)) return null;
  return entries.filter(looksLikeMetadataEntry) as Array<[string, unknown]>;
}

function looksLikeMetadataEntry(value: unknown): value is [string, unknown] {
  return (
    Array.isArray(value) && typeof value[0] === "string" && value.length >= 2
  );
}

function metadataFromExtRich(
  result: unknown,
  fallback: NFTMetadata,
): NFTMetadata | null {
  if (!result || typeof result !== "object" || !("ok" in result)) return null;
  const ok = (result as { ok: unknown }).ok;
  if (!ok || typeof ok !== "object" || !("nonfungible" in ok)) return null;
  const details = (ok as { nonfungible: Record<string, unknown> }).nonfungible;
  const container = metadataFromExtContainer(details.metadata, fallback);
  return {
    name: stringValue(details.name) ?? container.name ?? fallback.name,
    description: container.description ?? fallback.description,
    imageUrl:
      stringValue(details.thumbnail) ??
      container.imageUrl ??
      stringValue(details.asset) ??
      fallback.imageUrl,
    attributes: container.attributes.length
      ? container.attributes
      : fallback.attributes,
  };
}

function metadataFromExtLegacy(
  result: unknown,
  fallback: NFTMetadata,
): NFTMetadata | null {
  if (!result || typeof result !== "object" || !("ok" in result)) return null;
  const ok = (result as { ok: unknown }).ok;
  if (!ok || typeof ok !== "object" || !("nonfungible" in ok)) return fallback;
  const metadata = (ok as { nonfungible: { metadata?: unknown } }).nonfungible
    .metadata;
  return metadataFromExtContainer(metadata, fallback);
}

function metadataFromExtContainer(
  value: unknown,
  fallback: NFTMetadata,
): NFTMetadata {
  const container = optionalValue(value);
  if (!container || typeof container !== "object") return fallback;
  if ("json" in container) {
    return metadataFromJson(stringValue(container.json), fallback);
  }
  if ("data" in container && Array.isArray(container.data)) {
    return metadataFromProperties(
      container.data as Array<[string, unknown]>,
      fallback,
    );
  }
  if ("blob" in container) {
    const text = textFromBytes(container.blob);
    return metadataFromJson(text, fallback);
  }
  if ("text" in container) {
    return metadataFromJson(stringValue(container.text), fallback);
  }
  return fallback;
}

function metadataFromProperties(
  entries: Array<[string, unknown]>,
  fallback: NFTMetadata,
): NFTMetadata {
  let name = fallback.name;
  let description = fallback.description;
  let imageUrl = fallback.imageUrl;
  const attributes = [...fallback.attributes];
  for (const [key, rawValue] of entries) {
    const value = stringValue(rawValue);
    if (!value) continue;
    if (["name", "title", "icrc7:name"].includes(key)) {
      name = value;
    } else if (["description", "desc", "icrc7:description"].includes(key)) {
      description = value;
    } else if (isImageField(key)) {
      imageUrl = value;
    } else if (!["attributes", "icrc7:token_metadata"].includes(key)) {
      attributes.push([key, value]);
    }
  }
  return { name, description, imageUrl, attributes };
}

function metadataFromJson(
  text: string | undefined,
  fallback: NFTMetadata,
): NFTMetadata {
  if (!text) return fallback;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return {
      name:
        stringValue(value.name) ?? stringValue(value.title) ?? fallback.name,
      description:
        stringValue(value.description) ??
        stringValue(value.desc) ??
        fallback.description,
      imageUrl:
        firstImageValue(value) ??
        (isLikelyImageUrl(text) ? text : undefined) ??
        fallback.imageUrl,
      attributes: fallback.attributes,
    };
  } catch {
    return {
      ...fallback,
      imageUrl: isLikelyImageUrl(text) ? text : fallback.imageUrl,
    };
  }
}

function walletPreview(
  collection: Collection,
  owner: Principal,
  tokenId: string,
  metadata: NFTMetadata,
  numericTokenId?: number,
): WalletNFT {
  const fallbackId =
    numericTokenId == null
      ? tokenIdToStableId(tokenId)
      : BigInt(numericTokenId);
  return {
    id: collection.id * 1_000_000_000_000n + fallbackId,
    tokenId,
    collectionId: collection.id,
    owner,
    metadata,
    location: "Registered",
    registeredAt: 0n,
  };
}

function fallbackMetadata(
  collection: Collection,
  tokenId: string,
  overrides: Partial<NFTMetadata> = {},
): NFTMetadata {
  return {
    name: `${collection.name} #${tokenId}`,
    description: undefined,
    imageUrl: overrides.imageUrl,
    attributes: [],
  };
}

function accountIdentifier(principal: Principal): string {
  const bytes = concatBytes(
    DOMAIN_SEPARATOR,
    principal.toUint8Array(),
    ZERO_SUBACCOUNT,
  );
  const hash = sha224(bytes);
  const checksum = getCrc32(hash);
  const checksumBytes = new Uint8Array(4);
  new DataView(checksumBytes.buffer).setUint32(0, checksum, false);
  return toHex(concatBytes(checksumBytes, hash));
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

function rawThumbnailUrl(canisterId: Principal, tokenId: string): string {
  const tokenQuery = /^\d+$/.test(tokenId)
    ? `index=${encodeURIComponent(tokenId)}`
    : `tokenid=${encodeURIComponent(tokenId)}`;
  return `https://${canisterId.toString()}.${RAW_DOMAIN}/?type=thumbnail&${tokenQuery}`;
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

function mergeNFTs(nfts: Array<WalletNFT>): Array<WalletNFT> {
  const seen = new Set<string>();
  const merged: Array<WalletNFT> = [];
  for (const nft of nfts) {
    const key = `${nft.collectionId.toString()}:${nft.tokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(nft);
  }
  return merged;
}

async function callOptional<T>(
  fn: () => Promise<T> | undefined,
): Promise<T | null> {
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

function optionalValue(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return optionalValue(value[0]);
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  const unwrapped = optionalValue(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  if (!unwrapped) return undefined;
  return (
    stringValue(unwrapped.text) ??
    stringValue(unwrapped.Text) ??
    stringValue(unwrapped.TextContent) ??
    stringValue(unwrapped.value)
  );
}

function textFromBytes(value: unknown): string | undefined {
  const bytes = Array.isArray(value)
    ? value
    : value instanceof Uint8Array
      ? Array.from(value)
      : null;
  if (!bytes) return undefined;
  try {
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

function firstImageValue(record: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(record)) {
    if (isImageField(key)) {
      const value = stringValue(record[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function isImageField(key: string): boolean {
  return [
    "image",
    "image_url",
    "imageUrl",
    "icrc7:image",
    "icrc7:image_url",
    "icrc7:logo",
    "logo",
    "thumbnail",
    "thumb",
    "media",
    "artifact_uri",
    "asset",
    "url",
    "location",
    "preview",
    "display",
    "animation_url",
    "metadata",
    "metadata_url",
    "token_uri",
    "uri",
  ].includes(key);
}

function isLikelyImageUrl(value: string): boolean {
  return /^(https?:\/\/|ipfs:\/\/|ar:\/\/|\/|\?)/i.test(value.trim());
}

function tokenIdToStableId(tokenId: string): bigint {
  let value = 0n;
  for (const char of tokenId) {
    value = (value * 31n + BigInt(char.charCodeAt(0))) % 999_999_999_999n;
  }
  return value;
}

const extIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const CommonError = IDL.Variant({
    InvalidToken: IDL.Text,
    Other: IDL.Text,
  });
  const ExtListing = IDL.Record({
    locked: IDL.Opt(IDL.Int),
    price: IDL.Nat64,
    seller: IDL.Principal,
  });
  const ExtMetadataValue = IDL.Variant({
    text: IDL.Text,
    blob: IDL.Vec(IDL.Nat8),
    nat: IDL.Nat,
    nat8: IDL.Nat8,
  });
  const ExtMetadata = IDL.Variant({
    fungible: IDL.Record({
      name: IDL.Text,
      symbol: IDL.Text,
      decimals: IDL.Nat8,
      metadata: IDL.Opt(ExtMetadataValue),
    }),
    nonfungible: IDL.Record({
      metadata: IDL.Opt(ExtMetadataValue),
    }),
  });
  const ExtContainerValue = IDL.Variant({
    text: IDL.Text,
    blob: IDL.Vec(IDL.Nat8),
    nat: IDL.Nat,
    nat8: IDL.Nat8,
  });
  const ExtContainer = IDL.Variant({
    blob: IDL.Vec(IDL.Nat8),
    data: IDL.Vec(IDL.Tuple(IDL.Text, ExtContainerValue)),
    json: IDL.Text,
  });
  const ExtRichMetadata = IDL.Variant({
    fungible: IDL.Record({
      name: IDL.Text,
      symbol: IDL.Text,
      decimals: IDL.Nat8,
      metadata: IDL.Opt(ExtContainer),
    }),
    nonfungible: IDL.Record({
      asset: IDL.Text,
      metadata: IDL.Opt(ExtContainer),
      name: IDL.Text,
      thumbnail: IDL.Text,
    }),
  });
  return IDL.Service({
    tokens_ext: IDL.Func(
      [IDL.Text],
      [
        IDL.Variant({
          ok: IDL.Vec(
            IDL.Tuple(
              IDL.Nat32,
              IDL.Opt(ExtListing),
              IDL.Opt(IDL.Vec(IDL.Nat8)),
            ),
          ),
          err: CommonError,
        }),
      ],
      ["query"],
    ),
    tokens: IDL.Func(
      [IDL.Text],
      [IDL.Variant({ ok: IDL.Vec(IDL.Nat32), err: CommonError })],
      ["query"],
    ),
    ext_metadata: IDL.Func(
      [IDL.Text],
      [IDL.Variant({ ok: ExtRichMetadata, err: CommonError })],
      ["query"],
    ),
    metadata: IDL.Func(
      [IDL.Text],
      [IDL.Variant({ ok: ExtMetadata, err: CommonError })],
      ["query"],
    ),
  });
};

const dip721IdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
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
  const MetadataValue = IDL.Rec();
  MetadataValue.fill(
    IDL.Variant({
      IntContent: IDL.Int,
      NatContent: IDL.Nat,
      Nat64Content: IDL.Nat64,
      Nat8Content: IDL.Nat8,
      BoolContent: IDL.Bool,
      BlobContent: IDL.Vec(IDL.Nat8),
      NestedContent: IDL.Vec(IDL.Tuple(IDL.Text, MetadataValue)),
      Principal: IDL.Principal,
      PrincipalContent: IDL.Principal,
      TextContent: IDL.Text,
    }),
  );
  const TokenMetadata = IDL.Record({
    transferred_at: IDL.Opt(IDL.Nat64),
    transferred_by: IDL.Opt(IDL.Principal),
    owner: IDL.Opt(IDL.Principal),
    operator: IDL.Opt(IDL.Principal),
    properties: IDL.Vec(IDL.Tuple(IDL.Text, MetadataValue)),
    is_burned: IDL.Bool,
    token_identifier: IDL.Nat,
    burned_at: IDL.Opt(IDL.Nat64),
    burned_by: IDL.Opt(IDL.Principal),
    approved_at: IDL.Opt(IDL.Nat64),
    approved_by: IDL.Opt(IDL.Principal),
    minted_at: IDL.Nat64,
    minted_by: IDL.Principal,
  });
  return IDL.Service({
    dip721_owner_token_identifiers: IDL.Func(
      [IDL.Principal],
      [IDL.Variant({ Ok: IDL.Vec(IDL.Nat), Err: Dip721Error })],
      ["query"],
    ),
    ownerTokenIdentifiers: IDL.Func(
      [IDL.Principal],
      [IDL.Variant({ Ok: IDL.Vec(IDL.Nat), Err: Dip721Error })],
      ["query"],
    ),
    dip721_token_metadata: IDL.Func(
      [IDL.Nat],
      [IDL.Variant({ Ok: TokenMetadata, Err: Dip721Error })],
      ["query"],
    ),
    tokenMetadata: IDL.Func(
      [IDL.Nat],
      [IDL.Variant({ Ok: TokenMetadata, Err: Dip721Error })],
      ["query"],
    ),
  });
};

const icrc7IdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const Value = IDL.Rec();
  Value.fill(
    IDL.Variant({
      Blob: IDL.Vec(IDL.Nat8),
      Text: IDL.Text,
      Nat: IDL.Nat,
      Int: IDL.Int,
      Array: IDL.Vec(Value),
      Map: IDL.Vec(IDL.Tuple(IDL.Text, Value)),
    }),
  );
  return IDL.Service({
    icrc7_tokens_of: IDL.Func(
      [Account, IDL.Opt(IDL.Nat), IDL.Opt(IDL.Nat)],
      [IDL.Vec(IDL.Nat)],
      ["query"],
    ),
    icrc7_token_metadata: IDL.Func(
      [IDL.Vec(IDL.Nat)],
      [IDL.Vec(IDL.Opt(IDL.Vec(IDL.Tuple(IDL.Text, Value))))],
      ["query"],
    ),
  });
};
