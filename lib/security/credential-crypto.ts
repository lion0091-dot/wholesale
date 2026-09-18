/**
 * 공급사별 제3자 서비스 인증정보(예: 비즈뿌리오 알림톡 비밀번호)를 DB에 저장할 때 쓰는
 * 대칭키 암호화. 해시(단방향)가 아니라 반드시 복호화 가능해야 한다 — 발송 시점에 원문
 * 비밀번호를 다시 비즈뿌리오 API로 보내야 하기 때문(토큰이 24시간마다 만료됨).
 *
 * AES-256-GCM 사용 — 인증 태그가 있어 변조도 함께 감지된다.
 * CREDENTIAL_ENCRYPTION_KEY 미설정 시 encrypt/decrypt 둘 다 예외를 던진다(평문 저장으로
 * 조용히 폴백하면 안 되는 보안 데이터라, 다른 외부 API들의 "키 없으면 스킵" 패턴과 다르게
 * 반드시 fail-closed 해야 한다).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM 권장 IV 길이

export class CredentialCryptoError extends Error {}

/** CREDENTIAL_ENCRYPTION_KEY(64자리 hex = 32바이트)를 Buffer로 변환. 형식이 틀리면 예외. */
function getKey(): Buffer {
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;

  if (!key) {
    throw new CredentialCryptoError(
      "CREDENTIAL_ENCRYPTION_KEY가 설정되지 않아 인증정보를 암호화/복호화할 수 없습니다."
    );
  }

  const buffer = Buffer.from(key, "hex");

  if (buffer.length !== 32) {
    throw new CredentialCryptoError(
      "CREDENTIAL_ENCRYPTION_KEY는 32바이트(64자리 hex 문자열)여야 합니다. 예: openssl rand -hex 32"
    );
  }

  return buffer;
}

/** 평문을 암호화해 "iv.authTag.ciphertext"(전부 base64url) 형태 문자열로 반환한다. */
export function encryptCredential(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, ciphertext].map((buf) => buf.toString("base64url")).join(".");
}

/** encryptCredential이 만든 문자열을 원문으로 복호화한다. 변조/키 불일치 시 예외. */
export function decryptCredential(packed: string): string {
  const key = getKey();
  const parts = packed.split(".");

  if (parts.length !== 3) {
    throw new CredentialCryptoError("암호화된 인증정보 형식이 올바르지 않습니다.");
  }

  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(authTagB64, "base64url");
  const ciphertext = Buffer.from(ciphertextB64, "base64url");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new CredentialCryptoError("인증정보 복호화에 실패했습니다 (키 불일치 또는 데이터 변조).");
  }
}

/** CREDENTIAL_ENCRYPTION_KEY 설정 여부 — 설정 화면에서 저장 가능 여부를 미리 안내할 때 사용. */
export function isCredentialEncryptionConfigured(): boolean {
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  return Boolean(key && Buffer.from(key, "hex").length === 32);
}
