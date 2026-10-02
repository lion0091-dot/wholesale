/**
 * Storage 파일 격리 — 실제 Storage API(로컬 Docker)로 다른 공급사·고객·비로그인이 파일을 읽고 쓰고 지울 수 있는지 시도한다.
 * 정책은 "경로 첫 폴더 = 내 공급사 id(또는 내 계정 id)"로 갈린다(business-licenses 계정 id, 나머지 공급사 id).
 * 대상: 비공개 3개(inbound-documents·scan-location-photos·business-licenses), 공개 2개(product-images·shop-thumbnails: 읽기는 공개가 의도, 쓰기·삭제는 막혀야 함).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";

let world: World;

const FILE = "isolation-probe.txt";
const body = () => new Blob(["isolation-probe"], { type: "text/plain" });

const PRIVATE_BUCKETS = ["inbound-documents", "scan-location-photos"] as const;
const PUBLIC_BUCKETS = ["product-images", "shop-thumbnails"] as const;

/** 시드한 파일 경로(정리용). */
const seeded: Array<{ bucket: string; path: string }> = [];

async function seed(bucket: string, folder: string) {
  const path = `${folder}/${FILE}`;
  const { error } = await adminClient().storage.from(bucket).upload(path, body(), { upsert: true });

  expect(error, `시드 ${bucket}/${path}`).toBeNull();
  seeded.push({ bucket, path });
}

async function existsAsAdmin(bucket: string, path: string): Promise<boolean> {
  const { data } = await adminClient().storage.from(bucket).download(path);

  return data !== null;
}

beforeAll(async () => {
  world = await seedWorld();

  for (const bucket of [...PRIVATE_BUCKETS, ...PUBLIC_BUCKETS]) {
    await seed(bucket, world.wholesalerA);
    await seed(bucket, world.wholesalerB);
  }

  await seed("business-licenses", world.users.ownerA.id);
  await seed("business-licenses", world.users.ownerB.id);
}, 120_000);

afterAll(async () => {
  for (const { bucket, path } of seeded) {
    await adminClient().storage.from(bucket).remove([path]);
  }

  // 공격 시도가 우연히 만든 파일 정리
  for (const bucket of [...PRIVATE_BUCKETS, ...PUBLIC_BUCKETS]) {
    await adminClient().storage.from(bucket).remove([`${world.wholesalerB}/evil.txt`, `${world.wholesalerA}/mine.txt`, `${world.wholesalerA}/../${world.wholesalerB}/evil.txt`]);
  }
});

describe.each([...PRIVATE_BUCKETS, ...PUBLIC_BUCKETS])("대조군: 자기 폴더에는 올릴 수 있다 — %s", (bucket) => {
  it("대표 A는 자기 공급사 폴더에 올린다(거부 테스트가 '전부 막힘' 때문에 통과하는 걸 막는 대조)", async () => {
    await actAs(world.users.ownerA);

    const path = `${world.wholesalerA}/mine.txt`;
    const { error } = await getActorClient().storage.from(bucket).upload(path, body(), { upsert: true });

    expect(error, `${bucket}/${path}`).toBeNull();

    await adminClient().storage.from(bucket).remove([path]);
  });
});

describe.each(PRIVATE_BUCKETS)("비공개 버킷 %s", (bucket) => {
  it("자기 공급사 소속(대표·직원)은 자기 파일을 읽는다(과차단 아님)", async () => {
    for (const user of [world.users.ownerA, world.users.staffA]) {
      await actAs(user);

      const { data, error } = await getActorClient().storage.from(bucket).download(`${world.wholesalerA}/${FILE}`);

      expect(error, `${user.email}`).toBeNull();
      expect(data).not.toBeNull();
    }
  });

  it("다른 공급사·고객·비로그인은 남의 파일을 못 읽는다", async () => {
    const attempts: Array<[string, Parameters<typeof actAs>[0], string]> = [
      ["B 대표가 A 파일", world.users.ownerB, world.wholesalerA],
      ["A 대표가 B 파일", world.users.ownerA, world.wholesalerB],
      ["고객이 A 파일", world.users.retailerR, world.wholesalerA],
      ["비로그인이 A 파일", null, world.wholesalerA],
    ];

    for (const [label, user, folder] of attempts) {
      await actAs(user);

      const { data } = await getActorClient().storage.from(bucket).download(`${folder}/${FILE}`);

      expect(data, label).toBeNull();
    }
  });

  it("남의 폴더 목록이 비어 있다", async () => {
    await actAs(world.users.ownerA);

    const mine = await getActorClient().storage.from(bucket).list(world.wholesalerA);
    const theirs = await getActorClient().storage.from(bucket).list(world.wholesalerB);

    expect((mine.data ?? []).map((f) => f.name)).toContain(FILE);
    expect(theirs.data ?? []).toEqual([]);
  });

  it("남의 폴더에 올리기·덮어쓰기·삭제가 막힌다", async () => {
    await actAs(world.users.ownerA);

    const client = getActorClient().storage.from(bucket);
    const upload = await client.upload(`${world.wholesalerB}/evil.txt`, body());
    const overwrite = await client.upload(`${world.wholesalerB}/${FILE}`, new Blob(["변조"]), { upsert: true });

    expect(upload.error).not.toBeNull();
    expect(overwrite.error).not.toBeNull();

    await client.remove([`${world.wholesalerB}/${FILE}`]);

    expect(await existsAsAdmin(bucket, `${world.wholesalerB}/${FILE}`)).toBe(true);

    const intact = await adminClient().storage.from(bucket).download(`${world.wholesalerB}/${FILE}`);

    expect(await intact.data!.text()).toBe("isolation-probe");
  });

  it("경로 꼼수(.. 이동, uuid 아닌 폴더, 대문자·중괄호 id)로 B 폴더에 쓸 수 없다", async () => {
    await actAs(world.users.ownerA);

    const client = getActorClient().storage.from(bucket);
    const tricks = [
      `${world.wholesalerA}/../${world.wholesalerB}/evil.txt`,
      `not-a-uuid/${FILE}`,
      `${world.wholesalerB.toUpperCase()}/evil.txt`,
      `{${world.wholesalerB}}/evil.txt`,
      `${world.wholesalerB.replace(/-/g, "")}/evil.txt`,
    ];

    for (const path of tricks) {
      const { error } = await client.upload(path, body());

      expect(error, path).not.toBeNull();
    }

    expect(await existsAsAdmin(bucket, `${world.wholesalerB}/evil.txt`)).toBe(false);
  });
});

describe("business-licenses (폴더 = 계정 id)", () => {
  it("본인 파일만 읽는다", async () => {
    await actAs(world.users.ownerA);

    const own = await getActorClient().storage.from("business-licenses").download(`${world.users.ownerA.id}/${FILE}`);
    const other = await getActorClient().storage.from("business-licenses").download(`${world.users.ownerB.id}/${FILE}`);

    expect(own.error).toBeNull();
    expect(other.data).toBeNull();
  });

  it("고객·비로그인·다른 공급사는 못 읽고, 남의 폴더에 못 쓴다", async () => {
    for (const user of [world.users.retailerR, null, world.users.ownerB]) {
      await actAs(user);

      const { data } = await getActorClient().storage.from("business-licenses").download(`${world.users.ownerA.id}/${FILE}`);

      expect(data, user?.email ?? "anon").toBeNull();
    }

    await actAs(world.users.ownerA);

    const upload = await getActorClient().storage.from("business-licenses").upload(`${world.users.ownerB.id}/evil.txt`, body());

    expect(upload.error).not.toBeNull();
  });
});

describe.each(PUBLIC_BUCKETS)("공개 버킷 %s — 읽기는 공개(의도), 쓰기·삭제는 막힘", (bucket) => {
  it("남의 폴더에 올리기·덮어쓰기·삭제가 막힌다", async () => {
    await actAs(world.users.ownerA);

    const client = getActorClient().storage.from(bucket);
    const upload = await client.upload(`${world.wholesalerB}/evil.txt`, body());
    const overwrite = await client.upload(`${world.wholesalerB}/${FILE}`, new Blob(["변조"]), { upsert: true });

    expect(upload.error).not.toBeNull();
    expect(overwrite.error).not.toBeNull();

    await client.remove([`${world.wholesalerB}/${FILE}`]);

    const intact = await adminClient().storage.from(bucket).download(`${world.wholesalerB}/${FILE}`);

    expect(intact.data).not.toBeNull();
    expect(await intact.data!.text()).toBe("isolation-probe");
  });

  it("고객·비로그인은 올리거나 지울 수 없다", async () => {
    for (const user of [world.users.retailerR, null]) {
      await actAs(user);

      const client = getActorClient().storage.from(bucket);
      const upload = await client.upload(`${world.wholesalerA}/mine.txt`, body());

      expect(upload.error, user?.email ?? "anon").not.toBeNull();

      await client.remove([`${world.wholesalerA}/${FILE}`]);

      expect(await existsAsAdmin(bucket, `${world.wholesalerA}/${FILE}`)).toBe(true);
    }
  });

  it("공개 주소 읽기는 된다(상품 이미지·미니샵 썸네일은 고객에게 보여야 하므로 의도)", async () => {
    const { data } = adminClient().storage.from(bucket).getPublicUrl(`${world.wholesalerA}/${FILE}`);
    const response = await fetch(data.publicUrl);

    expect(response.status).toBe(200);
  });
});
