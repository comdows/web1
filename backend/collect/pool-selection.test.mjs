import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCollectionBudgets,
  countCollectionBuckets,
  dedupeCandidatesPreferMain,
  isAutoListEligible,
  selectCandidatesByCollectionPool,
} from "./pool-selection.mjs";

function rows(region, pool, count, options = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${region}-${pool}-${options.backfill ? "old" : "new"}-${i}`,
    region,
    pool,
    source: `${region}-${pool}-${i % 3}`,
    backfill: !!options.backfill,
    directUrl: true,
  }));
}

test("60건 예산을 국가 50:50, 각 국가 main/ad 75:25로 고정 분리한다", () => {
  assert.deepEqual(buildCollectionBudgets(60), {
    "domestic:ad": 8,
    "domestic:main": 22,
    "overseas:ad": 8,
    "overseas:main": 22,
  });
});

test("빈 버킷의 예산을 다른 국가나 풀에 넘기지 않는다", () => {
  const selected = selectCandidatesByCollectionPool(rows("domestic", "main", 100), 60);
  assert.equal(selected.length, 22);
  assert.deepEqual(countCollectionBuckets(selected), {
    "domestic:main": 22,
    "domestic:ad": 0,
    "overseas:main": 0,
    "overseas:ad": 0,
  });
});

test("네 버킷이 충분하면 각각의 독립 상한만큼 선택한다", () => {
  const input = [
    ...rows("domestic", "main", 40),
    ...rows("domestic", "ad", 40),
    ...rows("overseas", "main", 40),
    ...rows("overseas", "ad", 40),
  ];
  const selected = selectCandidatesByCollectionPool(input, 60);
  assert.deepEqual(countCollectionBuckets(selected), {
    "domestic:main": 22,
    "domestic:ad": 8,
    "overseas:main": 22,
    "overseas:ad": 8,
  });
});

test("백필 40% 예약을 각 버킷 내부에서 따로 적용한다", () => {
  const input = [
    ...rows("overseas", "main", 30),
    ...rows("overseas", "main", 30, { backfill: true }),
  ];
  const selected = selectCandidatesByCollectionPool(input, 60);
  assert.equal(selected.length, 22);
  assert.equal(selected.filter((row) => row.backfill).length, 8);
});

test("같은 후보가 광고와 메인에 있으면 메인 후보를 보존한다", () => {
  const ad = { id: "ad", pool: "ad", directUrl: true, backfill: false };
  const main = { id: "main", pool: "main", directUrl: true, backfill: false };
  assert.deepEqual(dedupeCandidatesPreferMain([ad, main], () => "same"), [main]);
});

test("URL이 달라도 정규화 이름이 같으면 메인 후보를 보존한다", () => {
  const ad = { id: "ad", pool: "ad", directUrl: false, backfill: false, url: "ad-post" };
  const main = { id: "main", pool: "main", directUrl: true, backfill: false, url: "product" };
  assert.deepEqual(
    dedupeCandidatesPreferMain([ad, main], (row) => row.url, () => "same-name"),
    [main],
  );
});

test("광고 풀은 직접 URL·고신뢰여도 자동등재하지 않는다", () => {
  const base = { directUrl: true, category_id: "openmarket", confidence: 100 };
  assert.equal(isAutoListEligible({ ...base, pool: "ad" }, { autoOn: true, minConfidence: 80 }), false);
  assert.equal(isAutoListEligible({ ...base, pool: "main" }, { autoOn: true, minConfidence: 80 }), true);
});
