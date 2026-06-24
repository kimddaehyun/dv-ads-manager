// 일회성: 양식 디스플레이_상세(sheet8) 연령표에 '알 수 없음' 행 추가 (8행 → 9행).
// 50세이상(81) 다음에 알수없음(82) 삽입, 합계 82→83. chart10 범위·dimension 갱신.
// 합계행 수식은 런타임 setNumber가 숫자로 덮으므로(=<f> 제거) 셀 주소만 +1.
// node --import ./scripts/ts-resolve.mjs scripts/patch-template-age-unknown.ts
import { readFileSync, writeFileSync } from "node:fs";
import { openXlsx, buildXlsx, readText, writeText } from "../src/lib/report-excel.ts";

const path = "src/assets/report-template.xlsx";
const files = openXlsx(new Uint8Array(readFileSync(path)));
let xml = readText(files, "xl/worksheets/sheet8.xml");

const r81 = xml.match(/<row r="81"[\s\S]*?<\/row>/)?.[0];
const r82 = xml.match(/<row r="82"[\s\S]*?<\/row>/)?.[0];
if (!r81 || !r82) throw new Error("행 81/82를 찾을 수 없음 — 이미 패치됐거나 양식 변경됨");

// 합계 82 → 83 (행 + 셀 주소만; 수식 내부는 런타임에 덮임)
const newTotal = r82.replace(/^<row r="82"/, '<row r="83"').replace(/(<c r="[A-Z]+)82"/g, '$183"');

// 알수없음 82 = 81(50세이상) 복제, 셀 주소 81→82, B82 라벨을 inlineStr "알 수 없음"(스타일 유지)
let newUnknown = r81.replace(/^<row r="81"/, '<row r="82"').replace(/(<c r="[A-Z]+)81"/g, '$182"');
newUnknown = newUnknown.replace(/<c r="B82"([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/, (_m, attrs) => {
  const s = (attrs.match(/s="\d+"/) ?? [""])[0];
  return `<c r="B82" ${s} t="inlineStr"><is><t xml:space="preserve">알 수 없음</t></is></c>`;
});

// 교체: 원래 82 자리에 [알수없음 82][합계 83]
xml = xml.replace(/<row r="82"[\s\S]*?<\/row>/, newUnknown + newTotal);
xml = xml.replace(/(<dimension ref="B2:[A-Z]+)82"/, "$183\"");
writeText(files, "xl/worksheets/sheet8.xml", xml);

// chart10(연령 차트) 데이터 범위 74:81 → 74:82
let c10 = readText(files, "xl/charts/chart10.xml");
c10 = c10.replace(/(\$[A-Z]+\$74:\$[A-Z]+\$)81/g, "$182");
writeText(files, "xl/charts/chart10.xml", c10);

writeFileSync(path, buildXlsx(files));

// ── 검증 ──
const re = openXlsx(new Uint8Array(readFileSync(path)));
const s8 = readText(re, "xl/worksheets/sheet8.xml");
const c10v = readText(re, "xl/charts/chart10.xml");
let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const rows = [...s8.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
ok(rows.includes(82) && rows.includes(83), "행 82(알수없음)+83(합계) 존재");
ok(rows.every((v, i) => i === 0 || v > rows[i - 1]), "행 번호 오름차순");
ok(/<c r="B82"[^>]*t="inlineStr"><is><t[^>]*>알 수 없음<\/t>/.test(s8), "B82 = '알 수 없음' 라벨");
ok(/<dimension ref="B2:[A-Z]+83"/.test(s8), "dimension 끝행 83");
ok(c10v.includes("$B$74:$B$82") && c10v.includes("$K$74:$K$82"), "chart10 범위 74:82로 확장");
ok(Math.max(...rows) === 83, "max 행 = 83");
console.log(fail === 0 ? "\n양식 패치 완료 ✅" : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
