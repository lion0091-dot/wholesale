/**
 * 공급처 거래처 입력 검증 — 화면과 서버 액션이 같은 규칙을 쓴다(마이그레이션 136).
 * 같은 거래처인지는 이름 열쇠(모든 공백 제거 + 소문자, lib/livestock/supplier-name.ts)로 본다.
 */
import { normalizeSupplierName, supplierKey } from "@/lib/livestock/supplier-name";

export const SUPPLIER_MAX_ALIASES = 10;

export interface SupplierFormInput {
  name: string;
  phone: string;
  note: string;
  /** 쉼표·줄바꿈으로 구분한 별칭들 */
  aliases: string;
}

export interface ValidatedSupplier {
  name: string;
  phone: string | null;
  note: string | null;
  aliases: string[];
}

export type SupplierValidation = { ok: true; value: ValidatedSupplier } | { ok: false; error: string };

export interface SupplierNameEntry {
  id: string;
  name: string;
  aliases: string[];
}

/** 쉼표·줄바꿈으로 나눠 다듬고, 이름 열쇠가 같은 것은 하나만 남긴다. */
export function parseAliases(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const part of text.split(/[,\n、]/)) {
    const alias = normalizeSupplierName(part);
    const key = supplierKey(alias);

    if (!key || seen.has(key)) continue;

    seen.add(key);
    result.push(alias);
  }

  return result;
}

export function validateSupplierInput(input: SupplierFormInput): SupplierValidation {
  const name = normalizeSupplierName(input.name);
  const phone = input.phone.trim();
  const note = input.note.trim();
  const aliases = parseAliases(input.aliases).filter((alias) => supplierKey(alias) !== supplierKey(name));

  if (!name) {
    return { ok: false, error: "거래처 이름을 입력해주세요." };
  }

  if (name.length > 80) {
    return { ok: false, error: "거래처 이름은 80자 이내로 입력해주세요." };
  }

  if (phone.length > 30) {
    return { ok: false, error: "연락처는 30자 이내로 입력해주세요." };
  }

  if (note.length > 500) {
    return { ok: false, error: "메모는 500자 이내로 입력해주세요." };
  }

  if (aliases.length > SUPPLIER_MAX_ALIASES) {
    return { ok: false, error: `별칭은 ${SUPPLIER_MAX_ALIASES}개까지 넣을 수 있습니다.` };
  }

  if (aliases.some((alias) => alias.length > 80)) {
    return { ok: false, error: "별칭은 하나당 80자 이내로 입력해주세요." };
  }

  return { ok: true, value: { name, phone: phone || null, note: note || null, aliases } };
}

/** 이 거래처의 이름·별칭이 다른 거래처의 이름·별칭과 겹치면 안내문, 아니면 null. */
export function findSupplierCollision(
  value: Pick<ValidatedSupplier, "name" | "aliases">,
  others: readonly SupplierNameEntry[],
  selfId?: string
): string | null {
  for (const other of others) {
    if (other.id === selfId) continue;

    const otherKeys = new Map([[supplierKey(other.name), other.name], ...other.aliases.map((alias) => [supplierKey(alias), alias] as const)]);

    for (const mine of [value.name, ...value.aliases]) {
      if (otherKeys.has(supplierKey(mine))) {
        return `'${mine}'은(는) 이미 등록된 거래처 '${other.name}'의 이름 또는 별칭과 같습니다.`;
      }
    }
  }

  return null;
}
