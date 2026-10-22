/**
 * Passkeys in the browser: mekaweb's WebAuthn options arrive as JSON with their bytes in URL-safe
 * base64, which `navigator.credentials` takes as buffers; the credential it makes goes back as
 * JSON the same way, in the form `PublicKeyCredential.toJSON()` writes.
 */

type Json = Record<string, unknown>;

/** Why a passkey was not used: `aborted` needs no word, the others say what happened. */
export class PasskeyError extends Error {
  constructor(
    readonly kind: 'unsupported' | 'aborted' | 'cancelled' | 'exists' | 'unreadable',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PasskeyError';
  }
}

/** Whether this browser can make and use passkeys at all. */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

/** Whether this browser offers passkeys as the username is typed (conditional mediation). */
export async function isConditionalSupported(): Promise<boolean> {
  if (!isPasskeySupported()) return false;
  const check = (
    PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }
  ).isConditionalMediationAvailable;
  if (typeof check !== 'function') return false;
  try {
    return await check.call(PublicKeyCredential);
  } catch {
    return false;
  }
}

/** Makes a passkey for mekaweb's creation options; the credential as JSON. */
export async function createPasskey(options: Json): Promise<Json> {
  const publicKey = record(options.publicKey);
  const user = record(publicKey.user);
  const native = {
    ...publicKey,
    challenge: bytes(text(publicKey.challenge)),
    user: { ...user, id: bytes(text(user.id)) },
    excludeCredentials: descriptors(publicKey.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
  const credential = await ask(() => navigator.credentials.create({ publicKey: native }));
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: base64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: base64url(response.clientDataJSON),
      attestationObject: base64url(response.attestationObject),
      transports: response.getTransports(),
    },
    clientExtensionResults: plainExtensions(credential.getClientExtensionResults()),
  };
}

/**
 * Asks for a passkey answering mekaweb's request options; the credential as JSON. `conditional`
 * asks quietly, offering the site's passkeys as the username is typed, until `signal` calls it off.
 */
export async function getPasskey(
  options: Json,
  { conditional = false, signal }: { conditional?: boolean; signal?: AbortSignal } = {},
): Promise<Json> {
  const publicKey = record(options.publicKey);
  const native = {
    ...publicKey,
    challenge: bytes(text(publicKey.challenge)),
    allowCredentials: descriptors(publicKey.allowCredentials),
  } as unknown as PublicKeyCredentialRequestOptions;
  const credential = await ask(() =>
    navigator.credentials.get({
      publicKey: native,
      ...(conditional ? { mediation: 'conditional' as CredentialMediationRequirement } : {}),
      ...(signal ? { signal } : {}),
    }),
  );
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: base64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: base64url(response.clientDataJSON),
      authenticatorData: base64url(response.authenticatorData),
      signature: base64url(response.signature),
      userHandle: response.userHandle ? base64url(response.userHandle) : null,
    },
    clientExtensionResults: plainExtensions(credential.getClientExtensionResults()),
  };
}

async function ask(request: () => Promise<Credential | null>): Promise<PublicKeyCredential> {
  if (!isPasskeySupported())
    throw new PasskeyError('unsupported', 'This browser cannot use passkeys here.');
  let credential: Credential | null;
  try {
    credential = await request();
  } catch (cause) {
    const name = cause instanceof DOMException ? cause.name : '';
    if (name === 'AbortError')
      throw new PasskeyError('aborted', 'The passkey request was called off.', { cause });
    if (name === 'InvalidStateError')
      throw new PasskeyError('exists', 'This device has a passkey for mekaweb already.', { cause });
    throw new PasskeyError('cancelled', 'The passkey was not used.', { cause });
  }
  if (!(credential instanceof PublicKeyCredential))
    throw new PasskeyError('cancelled', 'The passkey was not used.');
  return credential;
}

function descriptors(value: unknown): Json[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const descriptor = record(item);
    return { ...descriptor, id: bytes(text(descriptor.id)) };
  });
}

function plainExtensions(results: AuthenticationExtensionsClientOutputs): Json {
  return JSON.parse(
    JSON.stringify(results, (_, value: unknown) =>
      value instanceof ArrayBuffer ? base64url(value) : value,
    ),
  ) as Json;
}

function record(value: unknown): Json {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Json;
  throw new PasskeyError('unreadable', 'mekaweb sent passkey options this page cannot read.');
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new PasskeyError('unreadable', 'mekaweb sent passkey options this page cannot read.');
}

/** The bytes URL-safe base64 `encoded` holds. */
export function bytes(encoded: string): Uint8Array<ArrayBuffer> {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** `buffer` in URL-safe base64, without padding. */
export function base64url(buffer: ArrayBuffer | ArrayBufferView): string {
  const view =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
