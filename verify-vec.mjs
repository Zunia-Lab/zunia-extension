import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bech32 } from '@scure/base';

const phrase = 'abandon '.repeat(11) + 'about';
const seed = mnemonicToSeedSync(phrase);
const node = HDKey.fromMasterSeed(seed).derive("m/44'/118'/0'/0/0");
const hash = ripemd160(sha256(node.publicKey));
console.log(bech32.encode('cosmos', bech32.toWords(hash)));
