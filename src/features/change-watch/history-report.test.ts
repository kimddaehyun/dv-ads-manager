import { describe, it, expect } from "vitest";
import { buildHistoryReport, formatHistoryReportText } from "./history-report";
import type { RawHistoryRow } from "./change-watch";

function row(over: Partial<RawHistoryRow> & { before?: Record<string, unknown>; after?: Record<string, unknown>; name?: string }): RawHistoryRow {
  const { before, after, name, ...rest } = over;
  return {
    eventId: Math.random().toString(36).slice(2),
    eventType: "ncc.heroes.CRITERION.MODIFY",
    "@timestamp": "2026-07-15T10:00:00.000Z",
    actorDisplayName: "dvcompany:naver",
    objects: [
      {
        id: "kwd-1",
        displayName: name ?? "운동화",
        data: {
          heroes: {
            nccCampaignName: "캠페인A",
            nccAdgroupName: "그룹1",
            before,
            after,
          },
        },
      },
    ],
    ...rest,
  };
}

describe("buildHistoryReport", () => {
  it("입찰가 변경은 eventType이 키워드여도 입찰가 조정으로 분류한다", () => {
    const report = buildHistoryReport(
      [row({ before: { bidAmt: "800" }, after: { bidAmt: "1200" } })],
      ["dvcompany:naver"],
    );
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].key).toBe("bid");
    expect(report.groups[0].items[0].where).toBe("캠페인A > 그룹1 > 운동화");
    expect(report.groups[0].items[0].detail).toBe("입찰가 800원 -> 1,200원");
  });

  it("우리 변경자가 아닌 행과 시스템 이벤트는 뺀다", () => {
    const report = buildHistoryReport(
      [
        row({ actorDisplayName: "김아라", before: { bidAmt: "1" }, after: { bidAmt: "2" } }),
        row({ eventType: "ncc.charge.CAMPAIGN_LOCK" }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.total).toBe(0);
  });

  it("변경자 비교는 대소문자·공백을 무시한다", () => {
    const report = buildHistoryReport(
      [row({ actorDisplayName: " DVcompany:Naver ", before: { bidAmt: "1" }, after: { bidAmt: "2" } })],
      ["dvcompany:naver"],
    );
    expect(report.total).toBe(1);
  });

  it("예산·상태·소재·타겟팅으로 나뉜다", () => {
    const report = buildHistoryReport(
      [
        row({ eventType: "ncc.heroes.CAMPAIGN.MODIFY", name: "캠페인A", before: { dailyBudget: "30000" }, after: { dailyBudget: "50000" } }),
        row({ eventType: "ncc.heroes.ADGROUP.MODIFY_USER_LOCK", name: "그룹1", before: { userLock: "false" }, after: { userLock: "true" } }),
        row({ eventType: "ncc.heroes.AD.MODIFY", name: "소재1", before: { adAttr: '{"style":1}' }, after: { adAttr: '{"style":2}' } }),
        row({
          eventType: "ncc.heroes.TARGET.MODIFY",
          name: "타겟",
          before: { targetTp: "MEDIA_TARGET", target: '{"black":{"media":[1]}}' },
          after: { targetTp: "MEDIA_TARGET", target: '{"black":{"media":[1,2]}}' },
        }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.groups.map((g) => g.key)).toEqual(["budget", "status", "ad", "targeting"]);
  });

  it("등록/삭제/복사는 diff 대신 동작으로 말한다 (키워드 신규 등록이 입찰가 변경으로 안 샌다)", () => {
    const report = buildHistoryReport(
      [
        row({
          eventType: "ncc.heroes.KEYWORD.ADD",
          name: "고급40수타올답례품",
          after: { nccKeywordId: "nkw-1", bidAmt: "70", keyword: "고급40수타올답례품", userLock: "false", type: "1" },
        }),
        row({ eventType: "ncc.heroes.AD_EXTENSION.REMOVE", name: "ext-a001-02-000000460289861" }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.groups.map((g) => g.key)).toEqual(["keyword", "ad"]);
    expect(report.groups[0].items[0].detail).toBe("키워드 등록");
    expect(report.groups[1].items[0].detail).toBe("확장소재 삭제");
  });

  it("소재 adAttr 속 입찰가 변경을 열어서 값으로 보여준다", () => {
    const report = buildHistoryReport(
      [
        row({
          eventType: "ncc.heroes.AD.MODIFY",
          name: "소재1",
          before: { adAttr: '{"bidAmt":2360,"useGroupBidAmt":false}' },
          after: { adAttr: '{"bidAmt":2510,"useGroupBidAmt":false}' },
        }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.groups[0].key).toBe("bid");
    expect(report.groups[0].items[0].detail).toBe("입찰가 2,360원 -> 2,510원");
  });

  it("criterionJson 변경은 어떤 타겟을 설정/해제했는지 표기한다", () => {
    const sd = (code: string, day: string) =>
      `{"dictionaryCode":"${code}","codeName":"${day}요일 07시부터 23시까지","enable":true,"negative":false}`;
    const report = buildHistoryReport(
      [
        row({
          eventType: "ncc.heroes.CRITERION.MODIFY",
          name: "grp-a001-02-000000070489159",
          before: { criterionJson: '{"SD":[]}' },
          after: {
            criterionJson: `{"SD":[${["월", "화", "수", "목", "금", "토", "일"].map((d, i) => sd(`SD${i}`, d)).join(",")}]}`,
          },
        }),
        row({
          eventType: "ncc.heroes.CRITERION.MODIFY",
          name: "그룹2",
          before: { criterionJson: '{"RL":[]}' },
          after: { criterionJson: '{"RL":[{"dictionaryCode":"RL00","codeName":"대한민국외","enable":true,"negative":true}]}' },
        }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.groups[0].key).toBe("targeting");
    const details = report.groups[0].items.map((i) => i.detail);
    expect(details).toContain("요일/시간 설정: 매일 07시부터 23시까지");
    expect(details).toContain("지역 제외 설정: 대한민국외");
  });

  it("연령 타겟팅 켜기/끄기는 전 구간 나열 대신 사용/해제 한 줄로 접는다", () => {
    const ag = (code: string, name: string, neg = false, w = 100) =>
      `{"dictionaryCode":"${code}","codeName":"${name}","enable":true,"bidWeight":${w},"negative":${neg}}`;
    const full = `{"AG":[${[ag("AG0013", "14세 미만", true), ag("AG1418", "14세 ~ 18세"), ag("AG1924", "19세 ~ 24세")].join(",")}]}`;
    const report = buildHistoryReport(
      [
        row({ eventType: "ncc.heroes.CRITERION.MODIFY", name: "그룹1", before: { criterionJson: '{"AG":[]}' }, after: { criterionJson: full } }),
        row({ eventType: "ncc.heroes.CRITERION.MODIFY", name: "그룹1", before: { criterionJson: full }, after: { criterionJson: '{"AG":[]}' } }),
      ],
      ["dvcompany:naver"],
    );
    const details = report.groups[0].items.map((i) => i.detail);
    expect(details).toContain("연령 타겟팅 사용 (14세 미만 제외)");
    expect(details).toContain("연령 타겟팅 해제");
  });

  it("켜져 있는 연령 타겟에서 일부만 바꾸면 바뀐 구간만 말한다", () => {
    const ag = (code: string, name: string, neg: boolean, w = 100) =>
      `{"dictionaryCode":"${code}","codeName":"${name}","enable":true,"bidWeight":${w},"negative":${neg}}`;
    const report = buildHistoryReport(
      [
        row({
          eventType: "ncc.heroes.CRITERION.MODIFY",
          name: "그룹1",
          before: { criterionJson: `{"AG":[${ag("AG1418", "14세 ~ 18세", false)},${ag("AG4044", "40세 ~ 44세", false)}]}` },
          after: { criterionJson: `{"AG":[${ag("AG1418", "14세 ~ 18세", true)},${ag("AG4044", "40세 ~ 44세", false, 150)}]}` },
        }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.groups[0].items[0].detail).toBe("연령 제외: 14세 ~ 18세 / 연령 가중치 조정: 40세 ~ 44세 100% -> 150%");
  });

  it("노출 매체 타겟은 제외 매체 개수 변화로 요약한다", () => {
    const report = buildHistoryReport(
      [
        row({
          eventType: "ncc.heroes.TARGET.MODIFY",
          name: "tgt-a001-02-000000903259487",
          before: { targetTp: "MEDIA_TARGET", target: '{"black":{"media":[1,2,3]}}' },
          after: { targetTp: "MEDIA_TARGET", target: '{"black":{"media":[1,2,3,4,5]}}' },
        }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.groups[0].items[0].detail).toBe("노출 매체 변경 (제외 매체 3곳 -> 5곳)");
  });

  it("제외키워드는 전체 목록 diff로 이번에 추가/삭제된 것만 보여준다", () => {
    const report = buildHistoryReport(
      [
        row({
          eventType: "ncc.heroes.TARGET.MODIFY",
          name: "tgt-a001-02-000000903259487",
          before: { targetTp: "RESTRICT_KEYWORD_TARGET", target: '[{"keyword":"코스트코","type":2},{"keyword":"트레이더스","type":2}]' },
          after: { targetTp: "RESTRICT_KEYWORD_TARGET", target: '[{"keyword":"동결건조","type":2},{"keyword":"코스트코","type":2},{"keyword":"트레이더스","type":2}]' },
        }),
        row({ eventType: "ncc.heroes.ADGROUP.ADD_KEYWORD_PLUS", name: "항문온열기", after: { keyword: "항문온열기", type: "KEYWORD_PLUS_RESTRICT" } }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].key).toBe("keyword");
    const details = report.groups[0].items.map((i) => i.detail);
    expect(details).toContain("제외키워드 추가: 동결건조");
    expect(details).toContain("제외키워드 추가");
  });

  it("소재 내용(ad)·검수 상태(inspectStatus) 변경은 각각 한마디/무시로 처리한다", () => {
    const report = buildHistoryReport(
      [
        row({
          eventType: "ncc.heroes.AD.MODIFY",
          name: "소재1",
          before: { ad: '{"referenceData":"..."}', inspectStatus: "10" },
          after: { ad: '{"referenceData":"..!"}', inspectStatus: "20" },
        }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.groups[0].key).toBe("ad");
    expect(report.groups[0].items[0].detail).toBe("소재 내용 변경");
  });

  it("바뀐 내용이 없는 이벤트(같은 값 재기록·검수만 변경)는 건수에서도 뺀다", () => {
    const report = buildHistoryReport(
      [
        // API가 같은 입찰가를 다시 쓴 무변경 소재 수정 — 2026-07-22 라이브에서 "소재 관리"로 새던 케이스
        row({
          eventType: "ncc.heroes.AD.MODIFY",
          name: "소재1",
          before: { adAttr: '{"bidAmt":7070,"useGroupBidAmt":false}' },
          after: { adAttr: '{"bidAmt":7070,"useGroupBidAmt":false}' },
        }),
        row({
          eventType: "ncc.heroes.AD.MODIFY",
          name: "소재2",
          before: { inspectStatus: "10" },
          after: { inspectStatus: "20" },
        }),
      ],
      ["dvcompany:naver"],
    );
    expect(report.total).toBe(0);
  });

  it("그룹 입찰가 전환·AI 최적화 토글은 풀어 쓴다", () => {
    const report = buildHistoryReport(
      [
        row({ eventType: "ncc.heroes.KEYWORD.MODIFY", name: "운동화", before: { useGroupBidAmt: "true" }, after: { useGroupBidAmt: "false" } }),
        row({ eventType: "ncc.heroes.ADGROUP.MODIFY_AI_ADS_OPT_IN", name: "그룹1", before: { aiAdsOptIn: "true" }, after: { aiAdsOptIn: "false" } }),
      ],
      ["dvcompany:naver"],
    );
    const all = report.groups.flatMap((g) => g.items.map((i) => i.detail));
    expect(all).toContain("개별 입찰가로 전환");
    expect(all).toContain("AI 광고 최적화 끔");
  });

  it("모르는 eventType은 기타 설정으로 접는다 (영문 코드 미노출)", () => {
    const report = buildHistoryReport(
      [row({ eventType: "ncc.heroes.SOMETHING_NEW.CREATE", name: "무언가", before: { fooBar: "1" }, after: { fooBar: "2" } })],
      ["dvcompany:naver"],
    );
    expect(report.groups[0].key).toBe("etc");
    const text = formatHistoryReportText(0, 0, report);
    expect(text).not.toMatch(/SOMETHING_NEW/);
  });
});

describe("formatHistoryReportText", () => {
  const since = Date.parse("2026-07-14T00:00:00+09:00");
  const until = Date.parse("2026-07-20T23:59:59+09:00");

  it("헤더·그룹 건수·전체 내역을 조립한다", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ name: `키워드${i}`, before: { bidAmt: "100" }, after: { bidAmt: "200" } }),
    );
    const text = formatHistoryReportText(since, until, buildHistoryReport(rows, ["dvcompany:naver"]));
    expect(text).toContain("[광고 관리 내역] 7/14 ~ 7/20");
    expect(text).toContain("■ 입찰가 조정 5건");
    // 접지 않고 전부 나열
    expect(text.match(/키워드\d/g)).toHaveLength(5);
  });

  it("displayName이 내부 id 형태면 이름 자리에서 뺀다", () => {
    const report = buildHistoryReport(
      [row({ name: "grp-a001-02-000000070261994", before: { bidAmt: "1" }, after: { bidAmt: "2" } })],
      ["dvcompany:naver"],
    );
    expect(report.groups[0].items[0].where).toBe("캠페인A > 그룹1");
  });

  it("이름 없는 키워드/소재 수정은 refId를 남겨 이름 조회 대상이 된다", () => {
    const rows = [
      row({ name: "", before: { bidAmt: "100" }, after: { bidAmt: "200" } }),
      row({ eventType: "ncc.heroes.AD.MODIFY", name: "멀쩡한 소재명", before: { adAttr: '{"bidAmt":1}' }, after: { adAttr: '{"bidAmt":2}' } }),
    ];
    rows[0].objects![0].id = "nkw-a001-01-000007635808174";
    rows[1].objects![0].id = "nad-a001-02-000000552407393";
    const report = buildHistoryReport(rows, ["dvcompany:naver"]);
    const items = report.groups[0].items;
    expect(items.find((i) => i.refId === "nkw-a001-01-000007635808174")).toBeTruthy();
    // 이름이 이미 있으면 조회 대상이 아니다
    expect(items.find((i) => i.where.includes("멀쩡한 소재명"))!.refId).toBeUndefined();
  });

  it("같은 대상의 변경은 대상 줄 아래에 시간순으로 묶는다", () => {
    const r1 = row({ name: "운동화", before: { bidAmt: "100" }, after: { bidAmt: "200" } });
    const r2 = row({ name: "운동화", before: { bidAmt: "200" }, after: { bidAmt: "300" } });
    r2["@timestamp"] = "2026-07-16T10:00:00.000Z";
    const text = formatHistoryReportText(since, until, buildHistoryReport([r1, r2], ["dvcompany:naver"]));
    const lines = text.split("\n");
    const head = lines.findIndex((l) => l === "  - 캠페인A > 그룹1 > 운동화");
    expect(head).toBeGreaterThan(-1);
    // 입찰가 그룹은 "입찰가 " 접두 없이 값만 + 시각, 오래된 것부터
    expect(lines[head + 1]).toMatch(/^ {4}100원 -> 200원 \(7\/15 \d{2}:\d{2}\)$/);
    expect(lines[head + 2]).toMatch(/^ {4}200원 -> 300원 \(7\/16 \d{2}:\d{2}\)$/);
  });

  it("캠페인 유형을 알면 유형별 섹션으로 나눈다", () => {
    const r1 = row({ name: "운동화", before: { bidAmt: "100" }, after: { bidAmt: "200" } });
    const r2 = row({ name: "장미화분", before: { bidAmt: "300" }, after: { bidAmt: "400" } });
    const report = buildHistoryReport([r1, r2], ["dvcompany:naver"]);
    report.groups[0].items.find((i) => i.where.includes("운동화"))!.campaignType = "파워링크";
    report.groups[0].items.find((i) => i.where.includes("장미화분"))!.campaignType = "쇼핑검색";
    const text = formatHistoryReportText(since, until, report);
    const iPower = text.indexOf("◆ 파워링크");
    const iShop = text.indexOf("◆ 쇼핑검색");
    expect(iPower).toBeGreaterThan(-1);
    expect(iShop).toBeGreaterThan(iPower);
    expect(text.indexOf("운동화")).toBeGreaterThan(iPower);
    expect(text.indexOf("운동화")).toBeLessThan(iShop);
    expect(text.indexOf("장미화분")).toBeGreaterThan(iShop);
  });

  it("내역이 없으면 안내 문구만 나온다", () => {
    const text = formatHistoryReportText(since, until, buildHistoryReport([], []));
    expect(text).toContain("정리할 관리 내역이 없습니다");
  });

  it("잘림 플래그가 켜지면 누락 안내를 붙인다", () => {
    const rows = [row({ before: { bidAmt: "1" }, after: { bidAmt: "2" } })];
    const text = formatHistoryReportText(
      since,
      until,
      buildHistoryReport(rows, ["dvcompany:naver"], true),
    );
    expect(text).toContain("변경 내역이 너무 많아 일부가 제외되었습니다");
  });
});
