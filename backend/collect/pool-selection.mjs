/* 수집 후보 예산을 국가(region) × 유입 풀(main/ad)로 완전히 분리한다.
 *
 * 불변식:
 *   - 네 버킷은 서로 예산을 빌려주지 않는다. 한 버킷이 비어도 다른 버킷이 그 몫을 먹지 않는다.
 *   - 각 버킷 안에서만 최신/백필 예산과 소스 라운드로빈을 계산한다.
 *   - 전역 중복은 유지하되 같은 후보가 main/ad 양쪽에 있으면 main을 남긴다.
 */

export const REGIONS = ["domestic", "overseas"];
export const COLLECTION_POOLS = ["main", "ad"];

function clampShare(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export function collectionBucket(row) {
  const region = REGIONS.includes(row?.region) ? row.region : "overseas";
  const pool = COLLECTION_POOLS.includes(row?.pool) ? row.pool : "main";
  return `${region}:${pool}`;
}

/** 총 상한을 네 개의 고정 버킷으로 나눈다. 합계는 항상 limit과 같다. */
export function buildCollectionBudgets(limit, options = {}) {
  const total = Math.max(0, Math.floor(Number(limit) || 0));
  const domesticShare = clampShare(options.domesticShare, 0.5);
  const adShare = clampShare(options.adShare, 0.25);

  const domesticTotal = Math.round(total * domesticShare);
  const regionTotals = {
    domestic: domesticTotal,
    overseas: total - domesticTotal,
  };
  const budgets = {};
  for (const region of REGIONS) {
    const ad = Math.round(regionTotals[region] * adShare);
    budgets[`${region}:ad`] = ad;
    budgets[`${region}:main`] = regionTotals[region] - ad;
  }
  return budgets;
}

/** 한 버킷 안에서 소스가 한 건씩 번갈아 뽑히게 한다. */
export function fairTake(rows, limit) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  const queues = new Map();
  for (const row of rows) {
    const source = row?.source || "unknown";
    if (!queues.has(source)) queues.set(source, []);
    queues.get(source).push(row);
  }
  const out = [];
  while (out.length < cap && queues.size) {
    for (const [source, queue] of [...queues]) {
      const row = queue.shift();
      if (row) out.push(row);
      if (!queue.length) queues.delete(source);
      if (out.length >= cap) break;
    }
  }
  return out;
}

function takeWithBackfillBudget(rows, limit, backfillShare) {
  const historical = rows.filter((row) => row.backfill);
  const current = rows.filter((row) => !row.backfill);
  const historicalBudget = Math.min(historical.length, Math.floor(limit * backfillShare));
  const selectedHistorical = fairTake(historical, historicalBudget);
  const selectedCurrent = fairTake(current, limit - selectedHistorical.length);
  const selected = [];
  const max = Math.max(selectedCurrent.length, selectedHistorical.length);
  for (let i = 0; i < max; i++) {
    if (selectedCurrent[i]) selected.push(selectedCurrent[i]);
    if (selectedHistorical[i]) selected.push(selectedHistorical[i]);
  }
  if (selected.length < limit) {
    const used = new Set(selected);
    selected.push(...fairTake(historical.filter((row) => !used.has(row)), limit - selected.length));
  }
  return selected.slice(0, limit);
}

/**
 * 국가 × 풀별 고정 예산으로 후보를 선택한다. 버킷 간 잔여 예산 재분배는 의도적으로 하지 않는다.
 * 반환 순서는 버킷 라운드로빈이라 후속 처리에서도 특정 버킷이 먼저 전역 상한을 독점하지 않는다.
 */
export function selectCandidatesByCollectionPool(rows, limit, options = {}) {
  const defaults = buildCollectionBudgets(limit, options);
  const budgets = options.budgets
    ? Object.fromEntries(Object.keys(defaults).map((key) => [key, Math.max(0, Math.floor(Number(options.budgets[key]) || 0))]))
    : defaults;
  const backfillShare = clampShare(options.backfillShare, 0.4);
  const selectedByBucket = new Map();

  for (const region of REGIONS) {
    for (const pool of COLLECTION_POOLS) {
      const key = `${region}:${pool}`;
      const bucketRows = rows.filter((row) => collectionBucket(row) === key);
      selectedByBucket.set(key, takeWithBackfillBudget(bucketRows, budgets[key], backfillShare));
    }
  }

  const out = [];
  const keys = [...selectedByBucket.keys()];
  const max = Math.max(0, ...[...selectedByBucket.values()].map((items) => items.length));
  for (let i = 0; i < max; i++) {
    for (const key of keys) {
      const row = selectedByBucket.get(key)[i];
      if (row) out.push(row);
    }
  }
  return out;
}

/** 같은 전역 후보가 두 풀에 잡히면 main → direct URL → 최신 순으로 보존한다. */
export function dedupeCandidatesPreferMain(rows, keyOf, nameKeyOf = () => "") {
  const priority = (row) => [row?.pool === "ad" ? 0 : 4, row?.directUrl ? 2 : 0, row?.backfill ? 0 : 1]
    .reduce((sum, n) => sum + n, 0);
  const ranked = rows.map((row, index) => ({ row, index }))
    .sort((a, b) => priority(b.row) - priority(a.row) || a.index - b.index);
  const seenKeys = new Set();
  const seenNames = new Set();
  const kept = [];
  for (const { row, index } of ranked) {
    const key = keyOf(row);
    if (!key) continue;
    const name = nameKeyOf(row);
    if (seenKeys.has(key) || (name && seenNames.has(name))) continue;
    seenKeys.add(key);
    if (name) seenNames.add(name);
    kept.push({ row, index });
  }
  return kept.sort((a, b) => a.index - b.index).map(({ row }) => row);
}

export function countCollectionBuckets(rows) {
  const counts = Object.fromEntries(REGIONS.flatMap((region) => COLLECTION_POOLS.map((pool) => [`${region}:${pool}`, 0])));
  for (const row of rows) counts[collectionBucket(row)]++;
  return counts;
}

/** 광고 풀은 어떤 점수에서도 자동등재할 수 없다는 마지막 클라이언트 게이트. */
export function isAutoListEligible(row, options = {}) {
  const minConfidence = Number(options.minConfidence) || 80;
  const aiGatePassed = !row?.requireAiForAuto || !!row?.ai?.category_id;
  return !!options.autoOn
    && row?.pool === "main"
    && aiGatePassed
    && !!row?.directUrl
    && !!row?.category_id
    && Number(row?.confidence) >= minConfidence;
}
