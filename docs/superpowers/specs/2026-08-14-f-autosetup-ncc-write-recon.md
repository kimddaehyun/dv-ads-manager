# F-AutoSetup - ncc 쓰기 API 정찰 결과 (2026-08-14 라이브)

> 정찰 계정: adAccountNo `706242` / masterCustomerId `2384067` (빈 테스트 계정)
> 방법: 광고관리자 SPA를 실제로 조작하며 요청 본문을 가로채 기록
> 결론: **캠페인·광고그룹·소재·키워드를 내부 API POST로 생성할 수 있다.**
> 설계 문서 §8 결정 3 확정 - 화면 자동화·대량등록 CSV·EUC-KR 인코딩 전부 불필요.

---

## 0. 인증 - 가장 중요한 함정

읽기(GET)와 쓰기(POST)의 광고주 지정 방식이 **다르다.**

| | 광고주 지정 |
|---|---|
| GET `/apis/sa/api/ncc/*` | 헤더 `x-ad-customer-id: {masterCustomerId}` (기존 `authFetch` 방식) |
| POST `/apis/sa/api/ncc/*` | **본문 안 `customerId` 필드** |

**POST 본문에 `customerId`를 빼면 `404 {"code":1018,"title":"리소스에 접근할 권한이 없습니다."}`가 온다.**
권한 문제로 착각하기 딱 좋은 응답이다. 실제로는 광고주를 못 정한 것뿐이다.
쿼리 `?customerId=`를 붙여도 소용없다 - 반드시 본문.

나머지 헤더는 기존 `authFetch` 그대로: `x-xsrf-token`(XSRF-TOKEN 쿠키 `decodeURIComponent`),
`content-type: application/json`, `credentials: "include"`.

`fetch`로 정상 동작 확인 (SPA는 XHR을 쓰지만 무관). 콘텐츠 스크립트에서만 호출 가능한 것도 동일.

### 실패 응답이 한글로 정확하다

- `400 {"code":1002,"detail":"캠페인 유형이 잘못되었습니다."}`
- `400 {"code":1002,"detail":"URL 형식에 맞지 않습니다."}`

사용자에게 보여줄 오류 문구를 지어낼 필요가 없다. `friendly-error`에서 `detail`을 그대로 쓰면 된다.

---

## 1. 캠페인 생성

```
POST /apis/sa/api/ncc/campaigns
```
```json
{
  "campaignTp": "WEB_SITE",
  "customerId": 2384067,
  "name": "캠페인 이름",
  "dailyBudget": 10000,
  "useDailyBudget": true,
  "deliveryMethod": "ACCELERATED",
  "trackingMode": "TRACKING_DISABLED",
  "usePeriod": false,
  "userLock": false,
  "delFlag": false,
  "expectCost": 0,
  "status": "ELIGIBLE",
  "statusReason": "ELIGIBLE",
  "regTm": "2026-08-14T01:10:58.154Z",
  "editTm": "2026-08-14T01:10:58.154Z"
}
```

응답 200 - `nccCampaignId` 포함한 캠페인 객체 전체.

- `dailyBudget` 50 ~ 1,000,000,000원, **10원 단위**. 범위 밖이면 화면단에서 막힌다.
- `regTm`/`editTm`은 클라이언트가 보내지만 서버가 자기 시각으로 덮어쓴다.

---

## 2. 비즈채널 생성 (광고그룹의 선행 조건)

**URL이 `businessInfo.site` 중첩 객체 안에 있다.** 최상위 `channelKey`/`pcUrl`/`url`은 전부 무시되고
`"URL 형식에 맞지 않습니다"`만 돌아온다.

```
POST /apis/sa/api/ncc/channels
```
```json
{
  "channelTp": "SITE",
  "customerId": 2384067,
  "name": "DVTEST채널",
  "businessInfo": {
    "site": "https://dview.me",
    "siteName": "디브이테스트",
    "name": "DVTEST채널",
    "inspectId": "",
    "inspectPw": ""
  }
}
```

- `name` = 비즈채널 이름 (관리용, 임의). `businessInfo.siteName` = 사이트 이름 (**노출됨**, 10자).
- `inspectId`/`inspectPw` = 회원전용 사이트 검수용 계정. 일반 사이트는 빈 문자열.
- 응답 채널 ID 형식: `bsn-a001-00-000000014747916`.
- 조회는 `GET /apis/sa/api/ncc/channels?channelTp=SITE`.

---

## 3. 광고그룹 생성

```
POST /apis/sa/api/ncc/adgroups
```
```json
{
  "adgroupType": "WEB_SITE",
  "customerId": 2384067,
  "nccCampaignId": "cmp-a001-01-000000010971406",
  "name": "광고그룹 이름",
  "bidAmt": 70,
  "dailyBudget": 10000,
  "useDailyBudget": true,
  "pcChannelId": "bsn-a001-00-000000014747916",
  "pcChannelKey": "https://dview.me",
  "mobileChannelId": "bsn-a001-00-000000014747916",
  "mobileChannelKey": "https://dview.me",
  "pcNetworkBidWeight": 100,
  "mobileNetworkBidWeight": 100,
  "useCntsNetworkBidAmt": false,
  "useCntsNetworkBidWeight": false,
  "systemBiddingType": "NONE",
  "agreeSystemBidding": false,
  "useExpSearch": true,
  "expSearchBudgetRatio": 100,
  "sharedExpSearchBudgetRatio": 100,
  "aiAdsOptIn": true,
  "adRollingType": "PERFORMANCE",
  "adgroupAttrJson": {},
  "targetSummary": {},
  "budgetLock": false,
  "userLock": false,
  "delFlag": false,
  "expectCost": 0,
  "crawlStatus": null,
  "targets": [
    { "targetTp": "MEDIA_TARGET", "target": { "type": 1, "contents": [], "search": [], "black": {}, "white": {} } },
    { "targetTp": "PC_MOBILE_TARGET", "target": { "pc": true, "mobile": true } },
    { "targetTp": "GENDER_TARGET", "target": { "male": true, "female": true, "unknown": true } },
    { "targetTp": "REGIONAL_TARGET", "target": null },
    { "targetTp": "PERIOD_TARGET", "target": null },
    { "targetTp": "TIME_WEEKLY_TARGET", "target": null },
    { "targetTp": "GENDER_WEIGHT_TARGET", "target": null },
    { "targetTp": "AGE_TARGET", "target": null },
    { "targetTp": "RESTRICT_KEYWORD_TARGET", "target": [] }
  ]
}
```

- `bidAmt` 최소 70원, 최대 100,000원, 10원 단위.
- **`targets` 9종을 전부 보낸다.** 안 쓰는 타겟도 `target: null`로 자리를 채운다.
- PC/모바일 채널을 같은 값으로 2번 넣는다 (대량등록 템플릿이 URL을 2번 받던 것과 같은 구조).
- 응답 그룹 ID 형식: `grp-a001-01-000000071832113`.

---

## 4. 키워드 등록 - 배열 하나로 끝

**대량등록 CSV가 필요 없다는 결정적 근거.**

```
POST /apis/sa/api/ncc/keywords?nccAdgroupId=grp-a001-01-000000071832113
```
```json
[
  { "customerId": 2384067, "nccAdgroupId": "grp-...", "keyword": "테스트키워드하나", "attr": {} },
  { "customerId": 2384067, "nccAdgroupId": "grp-...", "keyword": "테스트키워드둘", "attr": {} }
]
```

- 그룹ID를 **쿼리와 각 항목 양쪽에** 넣는다 (화면이 그렇게 보낸다).
- 화면 모달은 한 번에 100개까지. API 자체 상한은 미측정 - 100개씩 나눠 보내는 게 안전하다.
- 키워드별 입찰가/랜딩URL은 미정찰(화면에서 안 넣었음). 항목에 `bidAmt`/`links` 추가 형태로 추정.

---

## 5. 소재 생성 - 반응형(RSA)이다

파워링크 소재는 더 이상 "제목 1개 + 설명 1개"가 아니다. **제목 최대 7개(각 15자) + 설명 최대 4개**를
자산(asset)으로 넣고 네이버가 조합해 노출한다. **제목은 최소 3개 필수.**

```
POST /apis/sa/api/ncc/ads
```
```json
{
  "customerId": 2384067,
  "type": "RSA_AD",
  "nccAdgroupId": "grp-a001-01-000000071832113",
  "userLock": false,
  "inspectRequestMsg": null,
  "ad": {
    "pc":     { "display": "https://dview.me", "final": "https://dview.me" },
    "mobile": { "display": "https://dview.me", "final": "https://dview.me" }
  },
  "assets": [
    { "assetType": "TEXT", "linkType": "HEADLINE",    "assetData": { "text": "제목" }, "valid": true },
    { "assetType": "TEXT", "linkType": "DESCRIPTION", "assetData": { "text": "설명" }, "valid": true }
  ]
}
```

응답 소재 ID `nad-a001-01-...`, 자산 링크 ID `alk-a001-01-...`.

**초안 생성(AI)이 만들어야 할 것이 바뀐다** - 그룹당 제목 3~7개, 설명 2~4개.

### 사전 검증 endpoint (선물)

화면은 저장 직전에 문구를 먼저 검사한다. **만들지 않고 검사만** 할 수 있다.

```
POST /apis/sa/validator/ncc
{"locale":"ko_KR","ads":[{"headline":"제목","type":"text"},{"description":"설명","type":"text"}]}
```

검토 화면에서 "이 문구는 규정 위반"을 등록 전에 잡아줄 수 있다.

---

## 6. 일시중지 생성 / 되돌리기 - 둘 다 확인됨

**일시중지**: 생성 본문에 `userLock: true` 하나면 된다.
읽어보면 `status: "PAUSED"`, `statusReason: "CAMPAIGN_PAUSED"`. 설계 §7-1 안전장치 해결.

**되돌리기**: `DELETE /apis/sa/api/ncc/{campaigns|channels}/{id}` → **204**.
캠페인을 지우면 하위 그룹·소재·키워드가 같이 사라진다(정찰 후 실측 - 캠페인 3개 삭제로 전부 정리됨).
설계 §7-2 안전장치 해결.

## 7. 그 밖의 함정

- **캠페인 이름 중복 금지** - `400 {"code":3506,"title":"이미 사용 중인 캠페인 이름입니다."}`.
  초안이 만든 이름이 기존 캠페인과 겹칠 수 있으니 생성 전 목록 조회 + 접미사 처리 필요.
- 캠페인 ID의 가운데 조각이 유형을 나타낸다: 파워링크 `cmp-a001-**01**-...`, 쇼핑검색 `cmp-a001-**02**-...`.

---

## 8. 쇼핑검색 (쇼핑몰 상품형)

> 2차 정찰 계정: 메보아 adAccountNo `2342598` / masterCustomerId `4143317`
> (인증된 스마트스토어 보유). 만든 것은 전부 `userLock: true`, 확인 후 삭제 완료.

### 8.1 선행 조건 - 우리가 대신 못 하는 사람 작업

광고계정에 **네이버 쇼핑 파트너센터 인증**(스마트스토어 소유권, 광고주의 네이버쇼핑 아이디로
최초 1회)이 돼 있어야 한다. 인증이 없으면 광고그룹 화면이 "동의 후 인증하기"에서 막힌다.

**세팅 시작 전에 `GET /ncc/channels`에 `channelTp: "MALL"` 채널이 있는지로 판별하고,
없으면 쇼핑 유형을 아예 비활성화한 채 안내해야 한다.**

### 8.2 쇼핑몰 비즈채널 (읽기 전용, 우리가 만들지 않음)

```json
{ "nccBusinessChannelId": "bsn-a001-00-000000012762592",
  "channelTp": "MALL", "name": "메보아",
  "channelKey": "https://smartstore.naver.com/sonbigson",
  "businessInfo": { "mallNm": "메보아 공식스토어", "mallTp": "SmartStore", "mallId": "ncp_...", ... } }
```

채널 ID 필드명은 `nccBusinessChannelId`다 (`nccChannelId` 아님).

### 8.3 캠페인 / 광고그룹

캠페인은 파워링크와 같고 `campaignTp: "SHOPPING"`만 다르다.

광고그룹은 파워링크 본문에서 이렇게 바뀐다.

| 필드 | 파워링크 | 쇼핑몰 상품형 |
|---|---|---|
| `adgroupType` | `WEB_SITE` | `SHOPPING` |
| `adgroupAttrJson` | `{}` | `{"campaignTp": 2}` |
| `adRollingType` | `PERFORMANCE` | `ROUND_ROBIN` |
| `pc/mobileChannelId` | SITE 채널 | **MALL 채널** |
| `targets` | 9종 전부 | `MEDIA_TARGET` + `PC_MOBILE_TARGET` 2종만 |

### 8.4 소재 = 상품 - **배열 + `?isList=true`**

파워링크(단일 객체)와 **호출 형태가 다르다.** 단일 객체로 보내면 `400 {"code":3830,"title":"유효하지 않은 소재입니다."}`.

```
POST /apis/sa/api/ncc/ads?isList=true
```
```json
[{
  "type": "SHOPPING_PRODUCT_AD",
  "customerId": 4143317,
  "nccAdgroupId": "grp-a001-02-...",
  "referenceKey": "91175167301",
  "ad": {},
  "adAttr": { "useGroupBidAmt": true, "bidAmt": 50 }
}]
```

`referenceKey` = **네이버쇼핑 상품 ID**. 상품명·가격·이미지·카테고리는 서버가 `referenceData`에 채운다.

### 8.5 링크 → 상품 매칭 (F-AutoSetup의 연결고리)

```
GET /apis/sa/api/ncc/channels/{mallChannelId}/shopping-products?page=0-2000-RGST_YMDT_DESC&prodNm={검색어}
```

응답 `{code, mallSeq, totalCount, numFound, pageInfo, products:[...]}`, 항목:

```json
{ "id": "91175167301",              // ← 소재의 referenceKey
  "mallProductId": "13630656637",   // ← 스마트스토어 링크에 들어 있는 번호
  "mallProductUrl": "https://smartstore.naver.com/main/products/13630656637",
  "productTitle": "...", "lowPrice": "14900", "imageUrl": "...",
  "fullMallCatNm": "출산/육아>임부복>임부속옷>수유브라",
  "registrable": true }
```

**링크에서 뽑은 번호 = `mallProductId`, 소재에 넣을 값 = `id`.** 둘이 다르므로 이 조회를 반드시 거쳐야 한다.
`prodNm`을 비우고 `page=0-2000-...`로 전체를 받아 `mallProductId`로 맞추는 방식이 링크 기반엔 더 정확하다.
`registrable: false`인 상품은 광고 등록이 안 되므로 미리 걸러 사용자에게 이유와 함께 보여준다.

### 8.6 쇼핑몰 상품형에는 키워드가 없다

```
POST /ncc/keywords → 400 {"code":3926,"title":"해당 그룹 유형에서는 키워드를 생성할 수 없습니다."}
```

쇼핑몰 상품형은 상품 정보로 자동 매칭된다. **F-AutoSetup의 핵심 가치(연관 키워드 선별 + 대량 등록)가
쇼핑몰 상품형에는 해당하지 않는다.** 쇼핑에서 우리가 하는 일은 "어떤 상품을 어떤 그룹에 넣을지"다.
(대량등록 템플릿 파일명 `ko_add_brand_keyword_template.csv`의 정체도 이것 - 쇼핑 **브랜드형**용이다.)

### 8.7 미정찰

- 제품 카탈로그형 / 쇼핑 브랜드형 (상품형만 확인)
- 쇼핑 브랜드형 키워드 (자사1/타사2/일반0 유형)

---

## 9. 정찰 잔여물 - 전부 삭제 완료

- 계정 706242(빈 테스트): 캠페인 3개·비즈채널 1개 생성 후 삭제. 최종 캠페인 0개·채널 0개.
- 계정 2342598(메보아, 운영 중): 일시중지 캠페인 1개(+그룹·소재) 생성 후 삭제.
  최종 캠페인 9개로 정찰 전과 동일, DVTEST 잔여 0개. **기존 캠페인은 읽기만 했다.**
