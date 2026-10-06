/**
 * Zunia's swap commission.
 *
 * Decided by the owner: 0.5% of the amount sold, taken in the same
 * transaction as the swap, in the token sold, and paid to a Zunia treasury
 * address on the chain that signs the swap. lib/swap-fee.ts works the fee out,
 * builds the bank send that pays it, and checks that send before anything is
 * signed; the Swap screen shows it on the form and on the confirm screen.
 *
 * Compiled in only. Nothing here is fetched, overridden by storage or settings,
 * or changed at run time: a build charges exactly what it was released with,
 * and a reviewer reads the whole policy in this file.
 */

/** The commission, in basis points of the amount sold: 50 is 0.5%. */
export const SWAP_FEE_BPS = 50;

/**
 * The Zunia treasury on each chain a swap is signed on, by chain id.
 *
 * Filled on 2026-10-06 from the launch treasury: one 24-word phrase, each
 * address derived as the Zunia wallet derives it (m/44'/<coin type>'/0'/0/0,
 * Ethereum-style keys where the chain asks for them). The phrase is in the
 * owner's macOS Keychain ("Zunia treasury mnemonic") and, encrypted, on the
 * server (/srv/zunia/secrets/treasury). Osmosis and every mainnet with a
 * canonical channel to Osmosis are listed; a chain absent from this map charges
 * no commission: its swaps sign exactly the one message they signed before the
 * commission existed, byte for byte.
 *
 * How to fill it, one bech32 address per chain the swap is signed on:
 *
 * - `"osmosis-1": "osmo1…"` for swaps of funds already on Osmosis: one
 *   contract call there, with the fee as a second message beside it.
 * - One entry per source chain of a cross-chain swap (`"cosmoshub-4":
 *   "cosmos1…"`, `"noble-1": "noble1…"`, `"injective-1": "inj1…"`, …): the fee
 *   is taken there, in the token sold, in the transaction that sends the
 *   transfer to Osmosis.
 *
 * Each address must be one the owner controls on that very chain, written
 * with that chain's own prefix (the catalog's `bech32Prefix`). Never make one
 * by re-encoding another chain's address with a new prefix: chains on coin
 * type 60 (Injective and the other Ethereum-key chains) derive a different key
 * from the same seed, so an `inj1…` re-encoded from an `osmo1…` belongs to an
 * account nobody can spend from. lib/__tests__/release-consistency.test.ts
 * refuses a build whose address does not decode, checksum included, with its
 * chain's prefix, or whose coin type 60 entry carries the same bytes as
 * another chain's (a re-encoding); lib/swap-fee.ts charges nothing on a chain
 * whose entry fails the prefix check.
 *
 * @example
 * export const SWAP_FEE_RECIPIENTS: Readonly<Record<string, string>> = {
 *   "osmosis-1": "osmo1…",
 *   "cosmoshub-4": "cosmos1…",
 * };
 */
export const SWAP_FEE_RECIPIENTS: Readonly<Record<string, string>> = {
  // Osmosis, coin type 118
  "osmosis-1": "osmo1gv86dp8wmnmmatdckgr5xkevnpmy4662stl5rm",
  // turkchain, coin type 60, Ethereum-style key
  "1919": "turk1rmgck8u7m0mmhtuyjfhxfcxlactsm97a4cuqzk",
  // Unification, coin type 5555
  "FUND-MainNet-2": "und1kuu9mecrrlz4gtc988ecgy74z93aqang53sptr",
  // Neutaro, coin type 118
  "Neutaro-1": "neutaro1gv86dp8wmnmmatdckgr5xkevnpmy4662ehf48v",
  // Oraichain, coin type 118
  "Oraichain": "orai1gv86dp8wmnmmatdckgr5xkevnpmy4662tr6856",
  // Shareledger, coin type 118
  "ShareRing-VoyagerNet": "shareledger1gv86dp8wmnmmatdckgr5xkevnpmy4662q5wa5z",
  // Aaron Network, coin type 118
  "aaronetwork": "aaron1gv86dp8wmnmmatdckgr5xkevnpmy4662ew38kc",
  // Agoric, coin type 564
  "agoric-3": "agoric1ppczzg4nrv78f0qg2g0pxs6xk72zpn7e2ywcpt",
  // AIOZ Network, coin type 60, Ethereum-style key
  "aioz_168-1": "aioz1rmgck8u7m0mmhtuyjfhxfcxlactsm97ava9a0v",
  // Akash, coin type 118
  "akashnet-2": "akash1gv86dp8wmnmmatdckgr5xkevnpmy46624tprvn",
  // Andromeda, coin type 118
  "andromeda-1": "andr1gv86dp8wmnmmatdckgr5xkevnpmy4662qmyxfy",
  // Arkeo, coin type 118
  "arkeo-main-v1": "arkeo1gv86dp8wmnmmatdckgr5xkevnpmy4662msepgv",
  // AtomOne, coin type 118
  "atomone-1": "atone1gv86dp8wmnmmatdckgr5xkevnpmy4662kssrr3",
  // Aura Network, coin type 118
  "aura_6322-2": "aura1gv86dp8wmnmmatdckgr5xkevnpmy4662rxmxhs",
  // Axelar, coin type 118
  "axelar-dojo-1": "axelar1gv86dp8wmnmmatdckgr5xkevnpmy4662u76v7g",
  // Babylon Genesis, coin type 118
  "bbn-1": "bbn1gv86dp8wmnmmatdckgr5xkevnpmy46620wa42s",
  // BeeZee, coin type 118
  "beezee-1": "bze1gv86dp8wmnmmatdckgr5xkevnpmy466295q087",
  // BitBadges, coin type 118
  "bitbadges-1": "bb1gv86dp8wmnmmatdckgr5xkevnpmy4662mdyhfc",
  // BitCanna v1, coin type 118
  "bitcanna-1": "bcna1gv86dp8wmnmmatdckgr5xkevnpmy4662zqu9am",
  // BitSong, coin type 639
  "bitsong-2b": "bitsong1jdnpf7e4lm7ml8yrkwddm97ulu8t4gvmlzrrgw",
  // Bluzelle, coin type 483
  "bluzelle-9": "bluzelle1uyt6ycfw5qahw7w2chlp0n5xjzarp8nlu0zsv6",
  // Bostrom, coin type 118
  "bostrom": "bostrom1gv86dp8wmnmmatdckgr5xkevnpmy4662mrchtw",
  // Canto, coin type 60, Ethereum-style key
  "canto_7700-1": "canto1rmgck8u7m0mmhtuyjfhxfcxlactsm97as4nvh2",
  // Carbon, coin type 118
  "carbon-1": "swth1gv86dp8wmnmmatdckgr5xkevnpmy46628wxjxs",
  // Celestia, coin type 118
  "celestia": "celestia1gv86dp8wmnmmatdckgr5xkevnpmy4662f6a50y",
  // Picasso, coin type 118
  "centauri-1": "pica1gv86dp8wmnmmatdckgr5xkevnpmy4662rv0p3w",
  // Cheqd, coin type 118
  "cheqd-mainnet-1": "cheqd1gv86dp8wmnmmatdckgr5xkevnpmy4662kjqy7c",
  // Chihuahua, coin type 118
  "chihuahua-1": "chihuahua1gv86dp8wmnmmatdckgr5xkevnpmy4662m9p25t",
  // Cifer, coin type 118
  "cifer-2": "cife1gv86dp8wmnmmatdckgr5xkevnpmy4662mszhtx",
  // FirmaChain, coin type 7777777
  "colosseum-1": "firma17awmqeeupmfhn3g09au0z5wfdy329yuptypr9h",
  // Terra Classic, coin type 330
  "columbus-5": "terra1clughu4kaqkmmn4f6zakgpufxgqry5tqq0t6s3",
  // Comdex, coin type 118
  "comdex-1": "comdex1gv86dp8wmnmmatdckgr5xkevnpmy4662llwxv7",
  // Persistence One, coin type 118
  "core-1": "persistence1gv86dp8wmnmmatdckgr5xkevnpmy4662ku2hmd",
  // TX, coin type 990
  "coreum-mainnet-1": "core1kqacm8x8f62nfyxeythcfrgf7krhk80xprktl6",
  // Cosmos Hub, coin type 118
  "cosmoshub-4": "cosmos1gv86dp8wmnmmatdckgr5xkevnpmy4662csvy4f",
  // Crescent Network, coin type 118
  "crescent-1": "cre1gv86dp8wmnmmatdckgr5xkevnpmy4662uclpqy",
  // Cronos POS, coin type 394
  "crypto-org-chain-mainnet-1": "cro1s40q9wu3yqrlp8hfx0tlk9nyn85v5tz9hvh7q7",
  // conscious, coin type 60, Ethereum-style key
  "cvn_2032-1": "cvn1rmgck8u7m0mmhtuyjfhxfcxlactsm97aq57q9s",
  // Desmos, coin type 852
  "desmos-mainnet": "desmos14grre23a43javgf98adzfwzj45aa77ak3hz0py",
  // XPLA, coin type 60, Ethereum-style key
  "dimension_37-1": "xpla1rmgck8u7m0mmhtuyjfhxfcxlactsm97auy2qg3",
  // Divine Mainnet, coin type 118
  "divine-1": "divine1gv86dp8wmnmmatdckgr5xkevnpmy4662wgl0da",
  // Dungeon, coin type 118
  "dungeon-1": "dungeon1gv86dp8wmnmmatdckgr5xkevnpmy4662krnzlj",
  // dYdX, coin type 118
  "dydx-mainnet-1": "dydx1gv86dp8wmnmmatdckgr5xkevnpmy46623fzq47",
  // Dymension, coin type 60, Ethereum-style key
  "dymension_1100-1": "dym1rmgck8u7m0mmhtuyjfhxfcxlactsm97as776xv",
  // e-Money, coin type 118
  "emoney-3": "emoney1gv86dp8wmnmmatdckgr5xkevnpmy4662hnksz5",
  // Epix, coin type 60, Ethereum-style key
  "epix_1916-1": "epix1rmgck8u7m0mmhtuyjfhxfcxlactsm97ahgufye",
  // FANDOMCHAIN Network, coin type 118
  "fandomChain": "fandom1gv86dp8wmnmmatdckgr5xkevnpmy4662ryqetg",
  // fetchhub, coin type 118
  "fetchhub-4": "fetch1gv86dp8wmnmmatdckgr5xkevnpmy4662td9qh7",
  // Furya, coin type 118
  "furya-1": "furya1gv86dp8wmnmmatdckgr5xkevnpmy4662h9hjqm",
  // Gitopia, coin type 118
  "gitopia": "gitopia1gv86dp8wmnmmatdckgr5xkevnpmy4662xgtn62",
  // Gnodi, coin type 118
  "gnodi": "gnodi1gv86dp8wmnmmatdckgr5xkevnpmy4662ls8met",
  // Gonka, coin type 1200
  "gonka-mainnet": "gonka1excpv66tt7jl5w2qu8vhvktp90s8wqwpuy49mz",
  // Gravity Bridge, coin type 118
  "gravity-bridge-3": "gravity1gv86dp8wmnmmatdckgr5xkevnpmy4662uq7usp",
  // HAQQ Network, coin type 60, Ethereum-style key
  "haqq_11235-1": "haqq1rmgck8u7m0mmhtuyjfhxfcxlactsm97aqy80a5",
  // HazinaChain, coin type 118
  "hazinachain-1": "hazina1gv86dp8wmnmmatdckgr5xkevnpmy4662lwz2yv",
  // Hippo Protocol, coin type 0
  "hippo-protocol-1": "hippo1f5kyrmzxxa84va0y834hyjxsch0vzg2xexdjg9",
  // Humans.ai, coin type 60, Ethereum-style key
  "humans_1089-1": "human1rmgck8u7m0mmhtuyjfhxfcxlactsm97aqvujca",
  // Injective, coin type 60, Ethereum-style key
  "injective-1": "inj1rmgck8u7m0mmhtuyjfhxfcxlactsm97ag29c36",
  // Int3face, coin type 118
  "int3face-1": "int31gv86dp8wmnmmatdckgr5xkevnpmy4662xsw64l",
  // Intento, coin type 118
  "intento-1": "into1gv86dp8wmnmmatdckgr5xkevnpmy4662hjfqsm",
  // Initia, coin type 60, Ethereum-style key
  "interwoven-1": "init1rmgck8u7m0mmhtuyjfhxfcxlactsm97av4j0gq",
  // IRISnet, coin type 118
  "irishub-1": "iaa1gv86dp8wmnmmatdckgr5xkevnpmy4662djv4hc",
  // Impact Hub, coin type 118
  "ixo-5": "ixo1gv86dp8wmnmmatdckgr5xkevnpmy466289jk36",
  // Jackal, coin type 118
  "jackal-1": "jkl1gv86dp8wmnmmatdckgr5xkevnpmy4662pwz4vk",
  // Juno, coin type 118
  "juno-1": "juno1gv86dp8wmnmmatdckgr5xkevnpmy4662wz0lj4",
  // Kujira, coin type 118
  "kaiyo-1": "kujira1gv86dp8wmnmmatdckgr5xkevnpmy4662fcwucr",
  // Kava, coin type 459
  "kava_2222-10": "kava1n9t8ywuy0xg5z9eez88h89zgxedwpqra9p5rla",
  // KYVE, coin type 118
  "kyve-1": "kyve1gv86dp8wmnmmatdckgr5xkevnpmy466207pj7d",
  // BandChain, coin type 494
  "laozi-mainnet": "band1hmmn6h5z28ryzunmk2jm2uszj3term3xg88vqg",
  // Lava, coin type 118
  "lava-mainnet-1": "lava@1gv86dp8wmnmmatdckgr5xkevnpmy4662qgmpjy",
  // LikeCoin, coin type 118
  "likecoin-mainnet-2": "like1gv86dp8wmnmmatdckgr5xkevnpmy4662tvsxkj",
  // Lum Network, coin type 118
  "lum-network-1": "lum1gv86dp8wmnmmatdckgr5xkevnpmy4662d63dqa",
  // Lumen, coin type 118
  "lumen": "lmn1gv86dp8wmnmmatdckgr5xkevnpmy4662dxsa7e",
  // Lumera, coin type 118
  "lumera-mainnet-1": "lumera1gv86dp8wmnmmatdckgr5xkevnpmy4662q0vlmm",
  // kopi, coin type 118
  "luwak-1": "kopi1gv86dp8wmnmmatdckgr5xkevnpmy4662fkuscl",
  // Manifest, coin type 118
  "manifest-ledger-mainnet": "manifest1gv86dp8wmnmmatdckgr5xkevnpmy4662ejwnpp",
  // AssetMantle, coin type 118
  "mantle-1": "mantle1gv86dp8wmnmmatdckgr5xkevnpmy4662x5hp2r",
  // MANTRA, coin type 118
  "mantra-1": "mantra1gv86dp8wmnmmatdckgr5xkevnpmy4662nmxqkn",
  // Medas Digital 2.0, coin type 118
  "medasdigital-2": "medas1gv86dp8wmnmmatdckgr5xkevnpmy4662arsv9n",
  // Meme Network, coin type 118
  "meme-1": "meme1gv86dp8wmnmmatdckgr5xkevnpmy4662x06njr",
  // Migaloo, coin type 118
  "migaloo-1": "migaloo1gv86dp8wmnmmatdckgr5xkevnpmy46624y97q8",
  // Mirage, coin type 118
  "mirage-1": "mirage1gv86dp8wmnmmatdckgr5xkevnpmy4662wtz76j",
  // mtgbp, coin type 118
  "mtgbp-1": "mtgbp1gv86dp8wmnmmatdckgr5xkevnpmy4662pwtt9y",
  // MuCoin, coin type 118
  "mucoin-1": "muc1gv86dp8wmnmmatdckgr5xkevnpmy4662xt5x5w",
  // Neutron, coin type 118
  "neutron-1": "neutron1gv86dp8wmnmmatdckgr5xkevnpmy4662u09x0w",
  // Noble, coin type 118
  "noble-1": "noble1gv86dp8wmnmmatdckgr5xkevnpmy4662snevd8",
  // Nym, coin type 118
  "nyx": "n1gv86dp8wmnmmatdckgr5xkevnpmy466225mx2v",
  // ODIN, coin type 118
  "odin-mainnet-freya": "odin1gv86dp8wmnmmatdckgr5xkevnpmy4662us28er",
  // Optio, coin type 118
  "optio": "optio1gv86dp8wmnmmatdckgr5xkevnpmy4662ddut78",
  // Sei, coin type 118
  "pacific-1": "sei1gv86dp8wmnmmatdckgr5xkevnpmy46624uajng",
  // MediBloc, coin type 371
  "panacea-3": "panacea1xzwns86275fr8s7me0h0snm8zm668m45tp2ljp",
  // Passage, coin type 118
  "passage-2": "pasg1gv86dp8wmnmmatdckgr5xkevnpmy4662mg47ck",
  // Paxi Network, coin type 118
  "paxi-mainnet": "paxi1gv86dp8wmnmmatdckgr5xkevnpmy4662mvgt0e",
  // Chain4Energy, coin type 118
  "perun-1": "c4e1gv86dp8wmnmmatdckgr5xkevnpmy4662mg4fvh",
  // Terra, coin type 330
  "phoenix-1": "terra1clughu4kaqkmmn4f6zakgpufxgqry5tqq0t6s3",
  // Provenance, coin type 505
  "pio-mainnet-1": "pb1llch9s9hq4mxfwg2adw4g5ck7jz0yrwf8q3yla",
  // Nolus, coin type 118
  "pirin-1": "nolus1gv86dp8wmnmmatdckgr5xkevnpmy4662wqumhv",
  // Planq, coin type 60, Ethereum-style key
  "planq_7070-2": "plq1rmgck8u7m0mmhtuyjfhxfcxlactsm97atmzq93",
  // QFS, coin type 118
  "qfs-1": "qfs1gv86dp8wmnmmatdckgr5xkevnpmy4662zce83j",
  // Quicksilver, coin type 118
  "quicksilver-2": "quick1gv86dp8wmnmmatdckgr5xkevnpmy4662n5ukvm",
  // Qwoyn, coin type 118
  "qwoyn-1": "qwoyn1gv86dp8wmnmmatdckgr5xkevnpmy46629sd6jg",
  // Realio, coin type 60, Ethereum-style key
  "realionetwork_3301-1": "realio1rmgck8u7m0mmhtuyjfhxfcxlactsm97atkkklc",
  // Regen, coin type 118
  "regen-1": "regen1gv86dp8wmnmmatdckgr5xkevnpmy46628j8crd",
  // Safrochain, coin type 118
  "safrochain-1": "addr_safro1gv86dp8wmnmmatdckgr5xkevnpmy4662qudn7e",
  // Scorum Cosmos Network, coin type 118
  "scorum-1": "scorum1gv86dp8wmnmmatdckgr5xkevnpmy466233dr9j",
  // Secret Network, coin type 529
  "secret-4": "secret1n6npjqmgs72m4mp27y26xu4yr2jymv09xwn0z6",
  // SEDA, coin type 118
  "seda-1": "seda1gv86dp8wmnmmatdckgr5xkevnpmy4662w7qukg",
  // Self Chain, coin type 118
  "self-1": "self1gv86dp8wmnmmatdckgr5xkevnpmy4662am3cmq",
  // Sentinel, coin type 118
  "sentinelhub-2": "sent1gv86dp8wmnmmatdckgr5xkevnpmy4662rt6a3x",
  // SGE, coin type 118
  "sgenet-1": "sge1gv86dp8wmnmmatdckgr5xkevnpmy4662xsj6zr",
  // Shentu, coin type 118
  "shentu-2.2": "shentu1gv86dp8wmnmmatdckgr5xkevnpmy4662syga85",
  // Shido, coin type 60, Ethereum-style key
  "shido_9008-1": "shido1rmgck8u7m0mmhtuyjfhxfcxlactsm97ad39pjx",
  // Side Chain, coin type 118
  "sidechain-1": "side1gv86dp8wmnmmatdckgr5xkevnpmy4662v337tw",
  // Sifchain, coin type 118
  "sifchain-1": "sif1gv86dp8wmnmmatdckgr5xkevnpmy4662adrj6z",
  // Sommelier, coin type 118
  "sommelier-3": "somm1gv86dp8wmnmmatdckgr5xkevnpmy46625vrgyr",
  // Source, coin type 118
  "source-1": "source1gv86dp8wmnmmatdckgr5xkevnpmy46627r469h",
  // Sovren, coin type 118
  "sovr-1": "sovr1gv86dp8wmnmmatdckgr5xkevnpmy4662aqxnl6",
  // Saga, coin type 118
  "ssc-1": "saga1gv86dp8wmnmmatdckgr5xkevnpmy4662xr4kj0",
  // StaFi Hub, coin type 118
  "stafihub-1": "stafi1gv86dp8wmnmmatdckgr5xkevnpmy4662rmuwp3",
  // Stratos Network, coin type 60, Ethereum-style key
  "stratos-1": "st1rmgck8u7m0mmhtuyjfhxfcxlactsm97a7wxwzl",
  // Stride, coin type 118
  "stride-1": "stride1gv86dp8wmnmmatdckgr5xkevnpmy4662mmvcp9",
  // Sunrise, coin type 118
  "sunrise-1": "sunrise1gv86dp8wmnmmatdckgr5xkevnpmy46622a84y6",
  // Symphony, coin type 118
  "symphony-1": "symphony1gv86dp8wmnmmatdckgr5xkevnpmy46620gvt80",
  // synternet, coin type 118
  "synternet-1": "synt1gv86dp8wmnmmatdckgr5xkevnpmy4662hhlf3p",
  // TAIL Network, coin type 118
  "tail-1": "tail1gv86dp8wmnmmatdckgr5xkevnpmy46623ez5nl",
  // TakeTitan, coin type 118
  "taketitan-1": "titan1gv86dp8wmnmmatdckgr5xkevnpmy4662jexsxy",
  // Teritori, coin type 118
  "teritori-1": "tori1gv86dp8wmnmmatdckgr5xkevnpmy46626ymdwe",
  // Dora Vota, coin type 118
  "vota-ash": "dora1gv86dp8wmnmmatdckgr5xkevnpmy4662m2ffzl",
  // Wormhole Gateway, coin type 118
  "wormchain": "wormhole1gv86dp8wmnmmatdckgr5xkevnpmy4662k5pc7t",
  // Verona, coin type 118
  "xion-mainnet-1": "xion1gv86dp8wmnmmatdckgr5xkevnpmy46626ekxrz",
  // XRPL EVM, coin type 60, Ethereum-style key
  "xrplevm_1440000-1": "ethm1rmgck8u7m0mmhtuyjfhxfcxlactsm97aedu7qq",
};
