# F-AssetBulk V2 — 상품 페이지 URL/ID 입력 → 후보 그리드 선택

작성일: 2026-05-20
대상 모듈: F-AssetBulk (확장소재 일괄 등록)
관련 메모: `project_f_assetbulk_v1`, `project_extension_asset_dom`

## 배경

F-AssetBulk v1은 파워링크 이미지를 "파일 첨부" 또는 "이미지 단일 URL 입력"으로 받는다. 사용자가 광고에 쓸 이미지는 대부분 자신이 운영하는 **네이버 스마트스토어/브랜드스토어 상품 페이지**에 이미 있고, 그걸 매번 다운로드해 파일로 첨부하거나 이미지 URL을 일일이 복사하는 게 가장 큰 운영 부담으로 지적됐다. v2는 사용자가 **상품 페이지 URL 또는 상품ID**를 붙여넣으면, 그 페이지의 메인 이미지 후보를 자동 추출해 보여주고, 사용자가 1~2장을 골라 등록할 수 있게 한다.

또한 운영하면서 발견된 이미지 한도 정정도 함께 반영한다 — 광고그룹당 파워링크 이미지는 **최대 2장**이며, 페이지에 이미 등록된 수만큼 추가 슬롯이 차감되어야 한다 (v1은 잘못 8로 설정되어 있었다).

## 목표

- 상품 페이지 URL(스마트스토어 또는 브랜드스토어) 또는 상품ID 입력 → 후보 이미지 그리드 → 최대 2장 선택 → 일괄 등록.
- 파일 첨부도 같은 한도 안에서 병행 가능 (선택 합산이 2장을 넘지 못함).
- 페이지에 이미 등록된 이미지 수를 카운트해 남은 슬롯을 동적으로 표시.
- 외부 사이트 데이터 추출은 네이버 도메인(스마트스토어/브랜드스토어/네이버 쇼핑 검색)으로만 제한 — Chrome 심사 정당화 일관성.

## 비목표

- 다른 쇼핑몰(쿠팡, 11번가, 자사 외부몰)은 지원하지 않는다.
- 추출된 이미지의 자동 편집(리사이즈, 크롭, 워터마크) — 페이지 모달에 그대로 업로드해 네이버 측 검증·리사이즈를 그대로 사용.
- 후보 캐시의 영구 저장 — popup 사이클 단위 메모리 캐시만.

## 핵심 결정

| 갈래 | 결정 | 근거 |
|---|---|---|
| 지원 도메인 | 스마트스토어 + 브랜드스토어만 (`smartstore.naver.com`, `brand.naver.com`) | 사용자가 운영하는 두 도메인. Chrome 심사에서 "광고 운영자가 자신의 상품 페이지에서 이미지를 가져온다" 일관 정당화. |
| ID-only 처리 | `search.shopping.naver.com` lookup으로 store/brand 슬러그 도출 후 페이지 fetch | 가장 정확. host_permissions 1개 추가되지만 흐름 자연스러움. |
| 선택 UI | 슬롯 구조 폐기, 단일 영역 + 후보 그리드 다중 체크 (최대 2장) | 이미지 한도가 2로 작아져 슬롯 분리 효용이 줄었음. multi-upload 1세트 처리와 부합. |
| 추출 메커니즘 | 콘텐츠 스크립트에서 직접 fetch + DOMParser (`__NEXT_DATA__` → og:image → 갤러리 DOM fallback) | 가벼움(1 HTTP, 200~500ms). hidden tab은 V3 fallback으로만 검토. |
| URL 모드 의미 | "이미지 단일 URL"에서 "상품 페이지 URL"로 완전 교체 | 사용자가 단일 이미지 URL을 직접 쓰는 일은 거의 없다고 판단. UI 단순화. |
| 캐싱 | popup 사이클 메모리 캐시(`Map<normalizedUrl, ExtractResult>`)만 | 상품 페이지 이미지는 자주 안 바뀌지만 같은 URL을 한 사이클 안에서 여러 번 입력하는 경우 위주. 영구 저장 불필요. |

## 아키텍처

### 모듈 경계

| 위치 | 책임 |
|---|---|
| **`src/features/asset-bulk/product-page-extract.ts`** (신규) | 입력 문자열(URL 또는 ID) → 후보 이미지 URL 배열. 순수 함수, DOM 의존 없음. ads.naver.com 콘텐츠 스크립트뿐 아니라 추후 background에서도 호출 가능. |
| **`src/features/asset-bulk/asset-bulk-popup.ts`** (수정) | `buildImageSection` 폐기 → `buildImageBlock` 신규. `ImageSlotInput` 폐기 → `AssetBulkImagesInput` 단일 객체 구조. |
| **`src/features/asset-bulk/asset-bulk.ts`** (수정) | `resolveImageFiles` 새 입력 구조 대응 (`files[]` + `selectedUrls[]`). |
| **`src/features/asset-bulk/dom-asset.ts`** (수정) | `scanExistingAssets`가 `imageCount`도 산출 — td[4] 유형이 "파워링크 이미지"인 행 카운트. `ExistingAssets`에 `imageCount: number` 필드 추가. |
| **`manifest.config.ts`** (수정) | `host_permissions` 5개로 확장. |
| **`src/styles/overlay.css`** (수정) | 새 클래스 추가. |

### 데이터 흐름

```
[팝업 mount]
  ↓ existing.imageCount = 0 (default)
  ↓ scanExistingAssets() 완료 시 imageCount 채워짐
  ↓ popup.setExisting({ headlines, descriptions, promos, imageCount })
    → 이미지 영역 헤더: "선택 0/2 (페이지에 이미 N장 등록)"
    → remaining = max(0, 2 - imageCount)
    → remaining===0이면 "이미 최대치 등록됨" 안내 + 전체 영역 disable

[파일 첨부]
  사용자가 multi-select → state.images.files: File[]
  카운트: state.images.files.length + state.images.selectedUrls.length + imageCount
  카운트 + 1 > 2면 마지막 추가 거부 + inline "최대 2장까지"

[URL 가져오기]
  pageUrlInput 입력 + "가져오기" 클릭 (또는 Enter)
  → resolveAndExtract(input) → 후보 string[] 그리드 렌더
  → 사용자가 그리드 체크박스 토글 (최대 2장 - imageCount - filesCount)

[등록]
  files = [...state.images.files, ...await fetchUrlAsFile(state.images.selectedUrls)]
  → registerAssetItem({ kind: "image", files })  // 1세트로 페이지 모달 multi-upload
```

### `AssetBulkInput.images` 타입 (단일 객체로 변경)

```ts
interface AssetBulkImagesInput {
  files: File[];               // 파일 첨부
  pageUrl: string;             // 마지막 입력한 페이지 URL/ID (재펼침 상태용)
  candidates: string[];        // 마지막 fetch 결과
  selectedUrls: string[];      // 그리드에서 체크한 이미지 URL들
}
// AssetBulkInput.images: ImageSlotInput[] → AssetBulkImagesInput
```

## `src/features/asset-bulk/product-page-extract.ts` 상세

```ts
type ProductPageHost = "smartstore" | "brand";

interface ParsedInput {
  kind: "url" | "id";
  url?: string;            // kind==="url"
  productId: string;       // 항상 채워짐 (lookup이든 URL 도출이든)
  host?: ProductPageHost;  // url이면 도출, id-only면 lookup 후 채워짐
  storeSlug?: string;      // url이면 도출, id-only면 lookup 후 채워짐
}

export interface ExtractResult {
  candidates: string[];
  source: "next-data" | "og-image" | "dom-fallback";
  resolvedUrl: string;     // 사용자가 입력한 ID라도 실제 페이지 URL을 함께 노출
}

export async function resolveAndExtract(rawInput: string): Promise<ExtractResult>;
function parseInput(raw: string): ParsedInput;
async function lookupProductById(id: string): Promise<{ host: ProductPageHost; storeSlug: string }>;
async function extractFromProductPage(url: string): Promise<ExtractResult>;

const HOST_FOR: Record<ProductPageHost, string> = {
  smartstore: "smartstore.naver.com",
  brand: "brand.naver.com",
};
```

### `parseInput(raw)`

- 공백 trim 후:
  - `/^\d{6,}$/` 매칭 → `{ kind: "id", productId }`
  - `/^https?:\/\/(?:m\.)?(smartstore|brand)\.naver\.com\/([^/]+)\/products\/(\d+)/` 매칭 → `{ kind: "url", host, storeSlug, productId }`
  - 그 외 → throw friendly error

### `lookupProductById(id)`

- `fetch("https://search.shopping.naver.com/...?productNo=" + id, { credentials: "omit" })` (정확한 endpoint는 정찰 후 확정)
- 응답에서 `mallName`/`mallId` 또는 `mallProductUrl` 도출 → host(smartstore/brand) + storeSlug 매핑.
- 두 도메인 모두 같은 endpoint로 풀리지 않으면 두 도메인 시도 fallback.
- 실패 시 friendly error("상품ID로 페이지를 찾지 못했어요").

### `extractFromProductPage(url)`

- `fetch(url, { credentials: "omit", cache: "force-cache" })` → HTML.
- `DOMParser` → 후보 수집 우선순위:
  1. `<script id="__NEXT_DATA__">` JSON.parse → BFS로 `^https?:\/\/.+\.(jpe?g|png|webp)` 매칭 문자열 수집.
  2. fallback: `meta[property="og:image"]`, `meta[name="twitter:image"]` 등.
  3. fallback: 정찰 후 확정될 갤러리 셀렉터 (1차에는 stub).
- dedupe + cap(12개).

## UI 변경 (`asset-bulk-popup.ts`)

기존 `buildImageSection` 폐기 → `buildImageBlock`으로 교체.

```html
<section class="dvads-asset-bulk-section">
  <div class="dvads-asset-bulk-section-head">
    <h3>파워링크 이미지</h3>
    <span class="dvads-asset-bulk-counter">선택 1/2 (페이지에 이미 0장 등록)</span>
  </div>

  <!-- 파일 첨부 -->
  <div class="dvads-asset-bulk-file-row">
    <button class="dvads-btn dvads-btn-secondary">+ 파일 첨부</button>
    <input type="file" multiple hidden accept="image/png,image/jpeg,image/bmp">
    <ul class="dvads-asset-bulk-file-list">
      <li>promo.jpg <button aria-label="제거">×</button></li>
    </ul>
  </div>

  <!-- URL/ID 가져오기 -->
  <div class="dvads-asset-bulk-url-row">
    <input type="text" placeholder="상품 링크 또는 상품ID">
    <button class="dvads-btn dvads-btn-secondary">가져오기</button>
  </div>

  <!-- 후보 그리드 (가져오기 성공 후만 mount) -->
  <div class="dvads-asset-bulk-thumb-grid">
    <button class="dvads-asset-bulk-thumb dvads-asset-bulk-thumb-selected">
      <img loading="lazy" referrerpolicy="no-referrer" src="...">
      <span class="dvads-asset-bulk-thumb-check">✓</span>
    </button>
    <!-- ... -->
  </div>

  <!-- 상태 메시지 (loading/error) -->
  <div class="dvads-asset-bulk-image-status">불러오는 중...</div>
</section>
```

### 핸들러 흐름

- `+ 파일 첨부` 클릭 → hidden `<input type="file" multiple>` click → 선택 → append to `state.images.files`. 각 파일 li에 × 버튼. 같은 파일명+size 두 번 첨부는 dedupe.
- URL/ID input 변경 → state.images.pageUrl. Enter 또는 `가져오기` 클릭 → `resolveAndExtract` 호출 → status="loading" → 성공 시 그리드 렌더 + status 텍스트 hide → 실패 시 friendly 메시지 표시.
- 입력 즉시 가벼운 inline hint (URL인지 ID인지 식별):
  - 숫자만 → "상품ID 형식 (가져오기 시 자동으로 상품 페이지 검색)"
  - URL → "스마트스토어 상품 페이지" 또는 "브랜드스토어 상품 페이지"
- 그리드 썸네일 클릭 → 토글. 카운터 검사: `currentSelected + 1 > remaining`이면 토글 거부 + 1.5초 inline 메시지 "최대 2장까지" (토스트 아닌 inline).
- 카운터 = `state.images.files.length + state.images.selectedUrls.length + existing.imageCount` / `2`.
- `remaining===0`이면 파일 첨부 버튼 + URL 가져오기 영역 disabled + 안내 텍스트.

### 스타일 가이드

- 썸네일 사이즈 80x80, radius 8px, gap 8px, 6열 grid. 12개 cap이라 최대 2행.
- 선택 상태: 1.5px DV 주황(#E6783B) 보더 + 우상단 작은 ✓ 배지. 비선택은 1px 회색.
- `referrerpolicy="no-referrer"` — 네이버 CDN(`phinf.pstatic.net`) referrer 검사 회피.
- 로딩 스피너는 기존 `.dvads-spinner` 재사용. 없으면 신규 작성 (1px 회색 → DV 주황 회전).
- 다이얼로그 안 `<select>` 안 씀 (CLAUDE.md `createDropdown` 의무 규칙 — 영향 없음).

### `AssetBulkPopupHandle.setExisting` 시그니처 변경

```ts
interface ExistingForPopup {
  headlines: Set<string>;
  descriptions: Set<string>;
  promos: Set<string>;
  imageCount: number;        // 신규
}
```

## 에러 처리 (모두 한글 일상어, `friendly-error.ts` 패턴)

| 케이스 | 트리거 | inline 메시지 |
|---|---|---|
| URL 형식 자체 잘못 | `new URL()` throws & 숫자만도 아님 | "올바른 주소 또는 상품ID 형식이 아니에요" |
| 지원 도메인 아님 | host 정규식 mismatch | "스마트스토어 또는 브랜드스토어 상품 페이지 주소만 가능해요" |
| HTTP 4xx/5xx | fetch !ok | "상품 페이지를 불러오지 못했어요 (상품이 삭제되었거나 주소가 잘못되었을 수 있어요)" |
| 네트워크 실패 | fetch throws | "네트워크 연결을 확인해 주세요" |
| ID-only lookup 실패 | search lookup 비어있음/에러 | "상품ID로 페이지를 찾지 못했어요. 전체 상품 주소를 붙여넣어 주세요" |
| 후보 0장 | candidates.length === 0 | "이 페이지에서 이미지를 찾지 못했어요. 다른 상품 페이지를 시도하거나 파일로 직접 첨부해 주세요" |
| 한도 초과 토글 | selectedCount + 1 > remaining | "최대 2장까지 등록할 수 있어요 (페이지에 N장 이미 등록)" |
| 등록 단계 fetch 실패 | `fetchUrlAsFile` reject | V1 흐름 유지 — 결과 토스트에 "이미지 …: 받아오지 못함". |

### 엣지케이스

- **재펼침**: 후보 그리드 펼친 뒤 URL을 다시 바꿔 "가져오기" 누르면 그리드 + 선택된 URL 모두 reset. 파일 첨부는 그대로 유지.
- **동일 URL 재펼침**: 모듈 스코프 `Map<normalizedUrl, Promise<ExtractResult>>` 캐시 — popup 닫히면 캐시 폐기. 정규화: searchParams 정렬 + fragment 제거.
- **늦은 `setExisting`**: 사용자가 이미 2장 골라둔 뒤 imageCount=1이 늦게 도착 → 카운터 초과 표시 + 등록 버튼 disable + "선택을 줄여주세요" 안내. 자동 unpick 안 함.
- **이미 2장 등록**: 영역 전체 disable + "이미 최대치 등록됨, 페이지에서 일부 삭제 후 재시도".
- **같은 파일 두 번 첨부**: 파일명+size dedupe.
- **race condition**: 가져오기 진행 중에 다른 URL 입력 후 또 가져오기 — token 증가 + resolve 시 token 비교로 stale promise 무시.

## 매니페스트

```ts
host_permissions: [
  "https://ads.naver.com/*",
  "https://api.searchad.naver.com/*",
  "https://smartstore.naver.com/*",          // 신규 — 스마트스토어 상품 페이지 HTML fetch
  "https://brand.naver.com/*",               // 신규 — 브랜드스토어 상품 페이지 HTML fetch
  "https://search.shopping.naver.com/*",     // 신규 — productID → URL lookup
]
```

Chrome 심사 사유 단일 줄기: "네이버 광고에 사용할 상품 이미지를 사용자의 스마트스토어·브랜드스토어 상품 페이지에서 추출". 5개 모두 네이버 광고 생태계 내부.

CLAUDE.md "정확히 2개" 가이드도 함께 5개 명세로 갱신.

## 보안

- fetch는 모두 `credentials: "omit"` — 사용자 쿠키 안 보냄.
- 추출된 후보 URL은 표시 전 protocol 검사(`https://` 또는 `data:` 만).
- 사용자 데이터 외부 전송 0건 — 추출 모듈은 받기만, 보내기 없음.
- `referrerpolicy="no-referrer"` — 썸네일 `<img>`에 적용.

## 정찰 체크리스트 (구현 시작 전 1회)

1. **스마트스토어 상품 페이지 `__NEXT_DATA__` 구조**
   - 예시: `https://smartstore.naver.com/nongsusancenter/products/13100015975`
   - `productInfo.images[]` 또는 `props.pageProps.product.images[]` 경로 확인.
   - 갤러리 장 수, og:image와 중복 여부.
2. **브랜드스토어 상품 페이지 동일 절차**
   - 예시: `https://brand.naver.com/atof/products/6090775987`
   - Next.js 사용 여부, 데이터 구조 차이.
3. **`search.shopping.naver.com` productID lookup endpoint**
   - 후보: `https://search.shopping.naver.com/api/...?productNo={id}` 류. 실제 path/응답 schema/인증 요구 확인.
   - 응답에서 `mallName` + `mallProductUrl` 또는 host+slug 매핑.
   - 브랜드스토어 상품도 같은 endpoint로 lookup 가능한지.
   - 인증 필요하면 차순위: `ads.naver.com` 내부에 비슷한 endpoint 있는지.
4. **이미지 CDN(`phinf.pstatic.net`) CORS** — `fetch(imageUrl, {mode:"cors"})` 동작. V1 `fetchUrlAsFile` 그대로 가능한지.

정찰 결과는 spec의 "정찰 결과" 절(아래)에 인라인 갱신.

## 정찰 결과

> _정찰 후 채워질 영역. 실제 endpoint, 응답 schema, 갤러리 데이터 경로 등을 여기에 기록._

## 테스트

### 단위 테스트 (`vitest`)

- `parseInput`: 풀 URL(스마트스토어/브랜드스토어/m.* prefix) / ID-only / 잘못된 입력.
- `extractFromNextData`: 두 fixture HTML에서 ≥3 후보 URL 추출.
- `extractFromMeta`: og:image 단독으로도 ≥1.
- `lookupProductById`: fetch mock으로 응답 fixture 주입, host+slug 매핑 검증.
- `resolveAndExtract` end-to-end: ID-only → lookup → extract mock 검증.

### Manual QA 체크리스트

- [ ] 실제 스마트스토어 상품 URL → 후보 펼침 → 2장 체크 → 등록.
- [ ] 실제 브랜드스토어 상품 URL → 동일.
- [ ] 상품ID-only(스마트스토어/브랜드스토어 각 1개) → lookup → 후보 펼침.
- [ ] 페이지에 1장 등록 상태 → 카운터 "1/2", 추가 1장만 선택 가능, 초과 거부.
- [ ] 페이지에 2장 등록 → 영역 전체 disable + 안내.
- [ ] URL 잘못/네트워크 끊김/후보 0장 — 각 friendly 메시지.
- [ ] 파일 첨부 multi + URL 선택 합산 카운트.
- [ ] 같은 URL 재입력 캐시 동작.
- [ ] 등록 후 페이지 모달 multi-upload 정상.
- [ ] 한글 메시지에 영문 기술용어 없음.

## 호환성

- v1 `ImageSlotInput[]` 구조 폐기. 외부 import 영향: 없음(같은 모듈 안에서만 사용).
- `ExistingAssets`에 `imageCount: number` 추가. 기존 호출자는 default 0으로 동작 호환.
- `package.json` version patch 증가.

## 관련 작업 / 후속

- v3 후보: 갤러리 데이터가 SSR HTML에 없는 페이지가 발견되면 background hidden tab 추출 fallback. 추가 host_permissions + content_scripts matches 확장이 필요해 별도 spec.
- v3 후보: 후보 캐시를 `chrome.storage.local`로 영구화(LRU 50개). 사용 빈도 측정 후 결정.
- v3 후보: 자사 외부몰(쿠팡·11번가) 추가 지원. host_permissions 한 개 더 + 추출 어댑터.
