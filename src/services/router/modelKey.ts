import { createHash } from 'node:crypto';

/**
 * Key material for the Auto router artifact.
 *
 * The decryption key has to reach the client, so this is **obfuscation, not security**: anyone who
 * can read the bundle can recover the key and re-encrypt a modified model. What it buys is that the
 * key is not sitting next to the artifact in plain text, and that the artifact is unreadable weight
 * data at rest. The real guarantee for "the model cannot be modified" is the GCM authentication tag
 * checked in `modelArtifact.ts`, which makes any edit a hard load failure. See the model card in
 * `resources/models/router/MODEL-CARD.md`.
 */

const KEY_DOMAIN = 'gitCommitGenie.autoRouter.rf79.v1';

/** Salt, stored XOR-masked so the literal never appears verbatim beside the domain string. */
const MASK = 0x5a;
const MASKED_SALT_HEX = 'c5761b8fe2fdbc591b95c077215406d2';

/** AES-256 key for the router artifact. Must stay in step with `scripts/export_artifact_encrypted.py`. */
export function deriveRouterArtifactKey(): Buffer {
    return createHash('sha256').update(`${KEY_DOMAIN}:${unmaskSalt()}`).digest();
}

function unmaskSalt(): string {
    let salt = '';
    for (let index = 0; index < MASKED_SALT_HEX.length; index += 2) {
        const byte = Number.parseInt(MASKED_SALT_HEX.slice(index, index + 2), 16) ^ MASK;
        salt += byte.toString(16).padStart(2, '0');
    }
    return salt;
}
