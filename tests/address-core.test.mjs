// Ported from the Android unit tests (AddressTextParserTest, AddressVerificationTest, RawSearchFlowTest, OcrStructureTest).
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Kind, COMPLETE, candidate, extract, extractCandidate, extractCandidates, classify, restoreStructuredText, parseParts,
  exactMatch, relatedParcels, candidatesFromBlocks, candidatesFromSpatialBlocks, automaticCandidate, assembleLines,
  assembleElements, rowsFromBoxes, identity,
} from '../dist/address-core.mjs';

const region = {province: '경기도', district: '안산시 상록구'};
const raw = (text, selected = region) => candidatesFromBlocks([text], selected);
const first = (text, selected = region) => raw(text, selected).find(c => c.completeness === COMPLETE);
const line = (text, x, y, w, h) => ({text, box: {left: x, top: y, right: x + w, bottom: y + h}});
const pipeline = (...lines) => candidatesFromSpatialBlocks(assembleLines(lines), {province: '경기도', district: '안산시 단원구'});

test('parser: simple, noisy, multiline', () => {
  assert.equal(extract('초지동 716-7'), '초지동 716-7');
  assert.equal(extract('대한민국\n지번 주소: 경기도 안산시 단원구 초지동 716－7\n우편번호'), '경기도 안산시 단원구 초지동 716-7');
  assert.equal(extract('초지동\n716-7'), '초지동 716-7');
  assert.equal(extract('응암동\n118-36'), '응암동 118-36');
  assert.equal(extract('수정동 1011\n-375'), '수정동 1011-375');
  assert.equal(extract('좌천동 849\n-25'), '좌천동 849-25');
});

test('parser: ambiguous, road, details', () => {
  assert.deepEqual(new Set(extractCandidates('응암동 118-36\n원곡동 814').map(c => c.text)), new Set(['응암동 118-36', '원곡동 814']));
  assert.equal(extract('안녕하세요 초지동입니다'), null);
  assert.equal(extract('단원구 신촌1길 4-1'), '단원구 신촌1길 4-1');
  assert.equal(extractCandidate('단원구 신촌1길 4-1').kind, Kind.ROAD);
  assert.equal(classify('초지동 716-7'), Kind.PARCEL);
  assert.equal(extract('경기도 안산시 단원구 신촌1길 4-1 1층 2호 (초지동)'), '경기도 안산시 단원구 신촌1길 4-1');
  const ocr = '경기도 안산시 단원구 광덕\n동로 25(고잔동. 안산레이\n크타운 푸르지오) 102동 2\n901호';
  assert.equal(extract(ocr), '경기도 안산시 단원구 광덕동로 25');
  assert.equal(restoreStructuredText(ocr).replace(/\n/g, ' '), '경기도 안산시 단원구 광덕동로 25(고잔동. 안산레이크타운 푸르지오) 102동 2901호');
  assert.equal(extract('샘골로12길 123-4, 101동 1203호'), '샘골로12길 123-4');
  assert.equal(extract('본오동 산123 - 4번지 2층'), '본오동 산 123-4');
  for (const text of ['광덕동로 25, 101동 1203호', '광덕동로 25, 2층', '광덕동로 25, 지하 1호']) assert.equal(extract(text), '광덕동로 25');
  assert.equal(extract('응암동\n\n118-36'), null);
  assert.equal(extract('010-1234-5678\n12345\n홍길동'), null);
});

test('validator: exact gate without fuzzy numbers', () => {
  const cleaned = extract('서울 중구\n신당동 5');
  assert.equal(cleaned, '서울특별시 중구 신당동 5');
  assert.equal(exactMatch(cleaned, '부산광역시 중구 신당동 5'), false);
  const query = '경기도 안산시 상록구 본오동 5';
  assert.equal(exactMatch(query, `${query} (본오빌라)`), true);
  for (const wrong of ['경기도 안산시 상록구 본오동 5-1', '경기도 안산시 상록구 본오동 산 5', '경기도 안산시 상록구 사동 5',
    '경기도 안산시 단원구 본오동 5', '경기도 수원시 상록구 본오동 5']) assert.equal(exactMatch(query, wrong), false, wrong);
  assert.equal(exactMatch('본오동 5-1', '본오동 5'), false);
  assert.equal(exactMatch('본오동 산 5-1', '본오동 5-1'), false);
  assert.equal(exactMatch('경기 안산시 본오동 5-1', '경기도 안산시 상록구 본오동 5-1'), true);
  assert.equal(exactMatch('충남 예산군 삽교읍 신리 5', '충청남도 예산군 덕산면 신리 5'), false);
  const related = relatedParcels('경기도 안산시 상록구 본오동 5-1', '5-1, 5-2');
  assert.ok(related.some(r => exactMatch('본오동 5-2', r)));
  assert.ok(!related.some(r => exactMatch('본오동 5', r)));
  assert.deepEqual(relatedParcels('본오동 5-1', '5-1 외 2필지'), []);
  assert.deepEqual(relatedParcels('본오동 산 5', '6'), []);
  assert.deepEqual(relatedParcels('본오동 산 5', '산 6'), ['본오동 산 6']);
  assert.equal(automaticCandidate([candidate('본오동 5-1', Kind.PARCEL, {manualOnly: true})]), null);
});

test('raw search flow: region supplement and search gate', () => {
  const typo = first('경기도 안산시 상콕구 샘골로 123');
  assert.equal(typo.text, '경기도 안산시 상콕구 샘골로 123');
  assert.equal(automaticCandidate([typo]), typo);
  const noisy = first('홍길동\n010-1234-5678\n12345\n경기도 안산시 상록구 샘골로 123, 101동 1203호\n배송관리부');
  assert.equal(noisy.text, '경기도 안산시 상록구 샘골로 123');
  assert.ok(noisy.details.includes('1203호'));
  assert.equal(first('본오동 123-4').text, '경기도 안산시 상록구 본오동 123-4');
  assert.equal(first('샘골로 123').text, '경기도 안산시 상록구 샘골로 123');
  assert.equal(first('상록구 본오동 5').text, '경기도 안산시 상록구 본오동 5');
  assert.equal(first('본오동 5', {province: '경기도', district: ''}).text, '경기도 본오동 5');
  assert.equal(first('서울 중구 신당동 5').text, '서울특별시 중구 신당동 5');
  assert.equal(first('부산광역시 중구 중앙동 5').text, '부산광역시 중구 중앙동 5');
  assert.equal(first('수원시 영통구 매탄동 5').text, '수원시 영통구 매탄동 5');
  assert.equal(first('경기도 안산시 단원구 초지동 5').text, '경기도 안산시 단원구 초지동 5');
  const multi = first('경기도 안산시 단원구 광덕\n동로 25(고잔동. 안산레이\n크타운 푸르지오) 102동 2\n901호');
  assert.equal(multi.text, '경기도 안산시 단원구 광덕동로 25');
  assert.ok(multi.details.includes('2901호'));
  assert.equal(first('샘골로12길123-4').text, '경기도 안산시 상록구 샘골로12길 123-4');
  assert.equal(first('본오동 산5-1번지').text, '경기도 안산시 상록구 본오동 산 5-1');
  for (const text of ['본오동', '샘골로', '본오동 010-1234-5678', '샘골로 101동 1203호', '홍길동\n12345']) {
    assert.equal(automaticCandidate(raw(text)), null, text);
  }
  const two = candidatesFromBlocks(['본오동 5', '초지동 7'], {province: '', district: ''});
  assert.equal(two.length, 2);
  assert.equal(automaticCandidate(two), null);
  assert.ok(candidatesFromBlocks(['본오동', '123'], region).every(c => c.completeness !== COMPLETE));
});

test('ocr structure: hyphen, units and spatial joins', () => {
  const wadong = pipeline(line('부평물', 10, 0, 100, 15), line('경기도 안산시 단원구 와동 695-', 10, 30, 500, 20), line('1 303', 10, 58, 100, 20));
  const selected = automaticCandidate(wadong);
  assert.equal(selected?.text, '경기도 안산시 단원구 와동 695-1');
  assert.equal(selected.details, '');
  assert.ok(!wadong.some(c => c.text.endsWith('와동 695')));
  for (const text of ['와동 695-', '와동 695 -', '와동 695 - ', '샘골로 123 -', '와동 산 5 -']) {
    assert.equal(extract(text), null, text);
    assert.equal(automaticCandidate(candidatesFromBlocks([text], {})), null, text);
  }
  const rows = [[line('와동', 10, 10, 70, 20), line('695', 85, 10, 50, 20), line('-', 140, 10, 10, 20)], [line('1', 10, 38, 15, 20), line('303', 30, 38, 55, 20)]];
  const spaced = candidatesFromSpatialBlocks(assembleElements(rows), {});
  assert.equal(automaticCandidate(spaced)?.text, '와동 695-1');
  assert.equal(spaced.length, 1);
  assert.equal(spaced[0].details, '');
  for (const next of [line('1 303', 600, 38, 100, 20), line('1 303', 10, 200, 100, 20), line('203호', 10, 38, 100, 20), line('010-1234-5678', 10, 38, 200, 20)]) {
    assert.equal(automaticCandidate(pipeline(line('와동 695 -', 10, 10, 200, 20), next)), null, next.text);
  }
  assert.equal(extract('와동 695-1 -'), null);
  assert.equal(extract('와동 695 - 1 303'), '와동 695-1');

  const parcelRoom = candidatesFromSpatialBlocks(assembleLines([line('경기 안산시 단원구 초지동', 20, 20, 1000, 50), line('716-7 203호', 440, 90, 500, 50)]), {province: '경기도', district: ''});
  const pr = automaticCandidate(parcelRoom);
  assert.equal(pr?.text, '경기도 안산시 단원구 초지동 716-7');
  assert.equal(pr.details, '203호');
  const roadSplit = candidatesFromSpatialBlocks(assembleLines([line('경기 안산시 단원구 원선1', 20, 20, 1000, 50), line('로 37 104동1202호', 20, 90, 700, 50)]), {province: '경기도', district: ''});
  const rs = automaticCandidate(roadSplit);
  assert.equal(rs?.text, '경기도 안산시 단원구 원선1로 37');
  assert.equal(rs.details, '104동 1202호');
  const fonts = assembleLines([line('경기도 안산시 단원구 광덕', 10, 10, 220, 14), line('동로 25', 10, 30, 100, 28)]);
  assert.equal(fonts.length, 1);
  assert.equal(extract(fonts[0].text), '경기도 안산시 단원구 광덕동로 25');
});

test('ocr structure: indents, suffixes, noise and columns', () => {
  for (const [stem, number, expected] of [['샘골로', '123, 101동 1203호', '샘골로 123'], ['본오동', '산 5-1 2층', '본오동 산 5-1']]) {
    const candidates = pipeline(line(stem, 10, 10, 260, 12), line(number, 120, 40, 180, 32));
    assert.equal(automaticCandidate(candidates)?.text, `경기도 안산시 단원구 ${expected}`);
    assert.ok(candidates[0].details);
  }
  for (const [left, right, base] of [['샘골로12', '길 123-4 101동1203호', '샘골로12길 123-4'], ['광덕', '동로 25 203호', '광덕동로 25'], ['중앙', '대로 25 2층', '중앙대로 25']]) {
    const parts = parseParts(automaticCandidate(pipeline(line(left, 10, 10, 240, 20), line(right, 10, 38, 240, 20))).text);
    assert.equal(`${parts.name} ${parts.number}`, base);
  }
  const hyphen = automaticCandidate(pipeline(line('초지동 716-', 10, 10, 220, 20), line('7 203호', 10, 38, 140, 20)));
  assert.ok(hyphen.text.endsWith('초지동 716-7'));
  assert.equal(hyphen.details, '203호');
  const noHyphen = pipeline(line('초지동 716', 10, 10, 220, 20), line('7 203호', 10, 38, 140, 20));
  assert.ok(noHyphen.every(c => !c.text.endsWith('7167') && !c.text.endsWith('716-7')));
  const firstRow = [line('경기 안산시 단원구 초지동', 10, 10, 500, 30)];
  const separated = candidatesFromSpatialBlocks(assembleElements([firstRow, [line('716-7', 180, 55, 100, 30), line('203호', 290, 55, 90, 30)]]), {province: '경기도', district: ''});
  assert.equal(automaticCandidate(separated)?.text, '경기도 안산시 단원구 초지동 716-7');
  assert.equal(separated[0].details, '203호');
  const packed = candidatesFromSpatialBlocks(assembleElements([firstRow, [line('716-7203호', 180, 55, 200, 30)]]), {province: '경기도', district: ''});
  assert.equal(automaticCandidate(packed), null);
  for (const noise of ['203호', '101동', '2층', '010-1234-5678', '우편번호: 12345', '이름: 홍길동 123', '배송 메모: 123', '부서: 영업1부']) {
    assert.equal(automaticCandidate(pipeline(line('초지동', 10, 10, 240, 20), line(noise, 10, 38, 240, 20))), null, noise);
  }
  assert.ok(automaticCandidate(pipeline(line('초지동 12345', 10, 10, 240, 20))).text.endsWith('12345'));
  const postal = pipeline(line('초지동', 10, 10, 240, 20), line('12345', 10, 38, 100, 20));
  assert.equal(postal.length, 1);
  assert.ok(postal[0].text.endsWith('12345'));
  assert.ok(postal[0].manualOnly);
  assert.equal(automaticCandidate(postal), null);
  const trace = [];
  const ambiguous = candidatesFromSpatialBlocks(assembleLines([line('초지동', 10, 10, 120, 20), line('원곡동', 170, 10, 120, 20), line('716-7 203호', 10, 40, 280, 20)], trace), {});
  assert.equal(automaticCandidate(ambiguous), null);
  assert.ok(trace.some(t => t.includes('가능한 앞줄이 여러 개')));
  assert.equal(automaticCandidate(pipeline(line('초지동', 10, 10, 120, 20), line('716-7 203호', 400, 40, 240, 20))), null);
});

test('ocr structure: same query for one or two lines, fields and hierarchy', () => {
  for (const [full, left, right] of [['경기 안산시 단원구 초지동 716-7 203호', '경기 안산시 단원구 초지동', '716-7 203호'],
    ['경기 안산시 단원구 원선1로 37 104동1202호', '경기 안산시 단원구 원선1', '로 37 104동1202호']]) {
    const single = pipeline(line(full, 10, 10, 800, 30));
    const wrapped = pipeline(line(left, 10, 10, 700, 30), line(right, 120, 52, 480, 30));
    assert.equal(single.length, 1);
    assert.equal(wrapped.length, 1);
    assert.equal(single[0].text, wrapped[0].text);
    assert.equal(single[0].details, wrapped[0].details);
  }
  for (const field of ['우편번호', '전화: 010-1234-5678', '성명: 홍길동']) {
    const candidates = pipeline(line('초지동', 10, 10, 400, 40), line(field, 10, 55, 300, 12), line('716-7', 10, 72, 140, 20));
    assert.ok(candidates.every(c => c.completeness !== COMPLETE), field);
  }
  assert.equal(extract('우편로 12345'), '우편로 12345');
  assert.equal(extract('이름: 홍길동 123\n우편번호: 12345\n초지동 716-7 203호\n배송 메모: 999호'), '초지동 716-7');
  const elementRows = [[line('경기', 10, 10, 60, 30), line('안산시', 80, 10, 90, 30), line('단원구', 180, 10, 90, 30), line('원선1', 280, 10, 100, 30)],
    [line('로', 10, 52, 30, 30), line('37', 50, 52, 50, 30), line('104동1202호', 110, 52, 200, 30)]];
  const trace = [];
  const road = automaticCandidate(candidatesFromSpatialBlocks(assembleElements(elementRows, trace), {province: '경기도', district: ''}));
  assert.equal(road.text, '경기도 안산시 단원구 원선1로 37');
  assert.equal(road.details, '104동 1202호');
  assert.ok(trace.some(t => t.includes('관측된 도로명 조각/접미사')));
  const hierarchy = pipeline(line('경기도', 10, 10, 200, 24), line('안산시 단원구 초지동', 10, 42, 400, 24), line('716-7 203호', 130, 74, 250, 24));
  assert.equal(automaticCandidate(hierarchy)?.text, '경기도 안산시 단원구 초지동 716-7');
  const building = assembleLines([line('안산레이크타운 푸르지오', 10, 10, 350, 32), line('경기도 안산시 단원구 광덕동로 25', 10, 50, 250, 12), line('전화: 010-1234-5678', 10, 70, 150, 12)]);
  assert.deepEqual(building.map(g => extract(g.text)).filter(Boolean), ['경기도 안산시 단원구 광덕동로 25']);
  assert.ok(building.map(g => extractCandidate(g.text)).filter(Boolean)[0].details.includes('푸르지오'));
  assert.equal(assembleLines([line('응암동 118-36', 10, 10, 150, 24), line('원곡동 814', 250, 10, 140, 24), line('좌천동 849-25', 10, 42, 170, 24)]).length, 3);
  const distant = assembleLines([line('응암동', 10, 10, 80, 20), line('118-36', 260, 60, 100, 20)]);
  assert.equal(distant.length, 2);
  assert.ok(distant.every(g => extract(g.text) == null));
  assert.equal(extract('경기도 안산시 상록\n구 본오\n동 123-4'), '경기도 안산시 상록구 본오동 123-4');
  assert.equal(extract('광덕\n동로 25'), '광덕동로 25');
  assert.ok(!(extract('광\n로 25') || '').includes('광덕동로'));
  assert.equal(extract('홍길동 010-1234-5678'), null);
  assert.equal(extract('본오동 123-4\n성명: 홍길동\n전화: 010-1234-5678'), '본오동 123-4');
  const detailed = extractCandidate('경기도 안산시 단원구 광덕\n동로 25(고잔동. 안산레이\n크타운 푸르지오) 102동 2\n901호');
  assert.equal(detailed.text, '경기도 안산시 단원구 광덕동로 25');
  assert.ok(detailed.details.includes('2901호'));
  assert.ok(detailed.details.includes('안산레이크타운'));
  assert.notEqual(identity(detailed), identity({...detailed, details: '102동 2902호'}));
  assert.equal(extractCandidate('광덕동로\n102동 2901호'), null);
  const room = extractCandidate('광덕동로 25\n901호');
  assert.equal(room.text, '광덕동로 25');
  assert.equal(room.details, '901호');
  assert.equal(extract('경기도 안산시 단원구\n광덕동로 25'), '경기도 안산시 단원구 광덕동로 25');
  assert.equal(extract('샘골로12길123-4'), '샘골로12길 123-4');
});

test('paddle boxes are grouped into rows before element assembly', () => {
  const rows = rowsFromBoxes([line('716-7 203호', 180, 55, 200, 30), line('경기 안산시 단원구 초지동', 10, 10, 500, 30), line('홍길동', 700, 12, 60, 26)]);
  assert.deepEqual(rows.map(r => r.map(e => e.text)), [['경기 안산시 단원구 초지동', '홍길동'], ['716-7 203호']]);
  const blocks = assembleElements(rows);
  const found = automaticCandidate(candidatesFromSpatialBlocks(blocks, {province: '경기도', district: ''}));
  assert.equal(found?.text, '경기도 안산시 단원구 초지동 716-7');
  assert.equal(found.details, '203호');
});
