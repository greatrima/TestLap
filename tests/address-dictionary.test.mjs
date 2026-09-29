// Ported from CandidateTrackerTest, AutoConversionPolicyTest, AddressCandidateEngineTest,
// DictionarySafetyTest and PackagedDictionaryTest (the real dictionary is used when available).
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {Kind, COMPLETE, PARTIAL, candidate, CandidateTracker, AutoConversionPolicy, isSameAddressFamily, parseParts} from '../dist/address-core.mjs';
import {AddressDictionary, AddressCandidateEngine, validateDictionaryText, isOlderVersion, FORMAT_HEADER} from '../dist/address-dictionary.mjs';

const complete = text => candidate(text, Kind.PARCEL);
const partial = text => candidate(text, Kind.PARCEL, {completeness: PARTIAL, confidence: 60});
const address = (text, score = 100) => candidate(text, Kind.PARCEL, {confidence: score});

test('tracker keeps, upgrades and replaces only after repeated frames', () => {
  let t = new CandidateTracker();
  assert.equal(t.update([partial('뭉암동')], 1000)[0].text, '뭉암동');
  assert.equal(t.update([], 2000)[0].text, '뭉암동');
  assert.equal(t.update([complete('뭉암동 118-36')], 2100)[0].text, '뭉암동 118-36');
  t = new CandidateTracker(3);
  t.update([complete('뭉암동 118-36')], 1);
  for (const i of [2, 3]) assert.equal(t.update([complete('뫼천동 849-25')], i)[0].text, '뭉암동 118-36');
  assert.equal(t.update([complete('뫼천동 849-25')], 4)[0].text, '뫼천동 849-25');
  t = new CandidateTracker();
  const selected = complete('차오동 123-4');
  t.update([selected], 1); t.freeze(selected);
  assert.deepEqual(t.update([complete('뫼천동 849-25')], 10000), [selected]);
  t = new CandidateTracker(3);
  t.update([complete('서울특별시 은빛구 뭉암동 118-36')], 1);
  for (const i of [2, 3]) assert.equal(t.update([complete('부산광역시 파도진구 뭉암동 118-36')], i)[0].text, '서울특별시 은빛구 뭉암동 118-36');
  assert.equal(t.update([complete('부산광역시 파도진구 뭉암동 118-36')], 4)[0].text, '부산광역시 파도진구 뭉암동 118-36');
  t = new CandidateTracker(2);
  t.update([candidate('경기도 달뫼시 뭉운로 10', Kind.ROAD)], 1);
  assert.equal(t.update([candidate('경기도 솔내시 뭉운로 10', Kind.ROAD)], 2)[0].text, '경기도 달뫼시 뭉운로 10');
  assert.equal(t.update([candidate('경기도 솔내시 뭉운로 10', Kind.ROAD)], 3)[0].text, '경기도 솔내시 뭉운로 10');
  t = new CandidateTracker();
  t.update([partial('뭉암동')], 1);
  assert.equal(t.update([complete('서울특별시 은빛구 뭉암동 118-36')], 2)[0].text, '서울특별시 은빛구 뭉암동 118-36');
});

test('auto conversion policy', () => {
  let p = new AutoConversionPolicy();
  const exact = address('경기도 솔내시 푸록구 차오동 123-4');
  const list = [exact, {...address('경기도 솔내시 푸록구 본솔동 123-4', 93), manualOnly: true}];
  assert.equal(p.update(list, null, 0), exact);
  assert.equal(p.update(list.slice().reverse(), exact, 300), null);
  p = new AutoConversionPolicy();
  for (let i = 0; i < 10; i++) assert.equal(p.update([address('경기도 별남시 뭉운동 123'), address('경기도 솔천시 뭉운동 123')], null, i * 300), null);
  p = new AutoConversionPolicy();
  const part = candidate('차오동', Kind.PARCEL, {completeness: PARTIAL});
  for (let i = 0; i < 4; i++) assert.equal(p.update([part], null, i * 300), null);
  const raw = address('차오동 123', 10);
  assert.equal(p.update([raw], null, 1200), raw);
  p = new AutoConversionPolicy();
  const first = address('차오동 123'), full = address('차오동 123-4');
  assert.equal(p.update([first], null, 0), first);
  assert.equal(p.update([full], first, 300), null);
  assert.equal(p.update([full], first, 600), null);
  assert.equal(p.update([], first, 900), null);
  assert.equal(p.update([full], first, 1200), null);
  assert.equal(p.update([full], first, 1500), full);
  p = new AutoConversionPolicy();
  const sel = {...address('차오동 5'), details: '101동 1203호'}, next = {...sel, details: '101동 1204호'};
  assert.equal(p.update([sel], null, 0), sel);
  assert.equal(p.update([{...sel, details: ''}], sel, 1200), null);
  assert.equal(p.update([next], sel, 1500), null);
  assert.equal(p.update([next], sel, 1800), next);
  p = new AutoConversionPolicy();
  let selected = null, requests = 0;
  const base = address('차오동 5-1');
  for (let i = 0; i < 100; i++) {
    const frame = i % 10 === 5 ? address('차오동 5-7') : i % 10 === 6 ? {...base, text: '차오동\n5 - 1'} : base;
    const got = p.update([frame], selected, i * 300);
    if (got) { selected = got; requests++; }
  }
  assert.equal(requests, 1);
  p.reset();
  assert.equal(p.update([base], null, 30000), base);
  for (let i = 0; i < 5; i++) assert.equal(new AutoConversionPolicy().update([{...address('푸록구 차오동 5'), dictionaryCorrected: true}], null, i * 300), null);
  p = new AutoConversionPolicy();
  const typo = address('경기도 솔내시 푸콕구 차오동 5'), chosen = {...address('경기도 솔내시 푸록구 차오동 5'), manualOnly: true};
  p.onSelected(0, [typo]); p.pause();
  for (let i = 0; i < 20; i++) assert.equal(p.update([typo], chosen, i * 300), null);
  const seven = address('경기도 솔내시 푸록구 차오동 7');
  assert.equal(p.update([seven], chosen, 6000), null);
  assert.equal(p.update([seven], chosen, 6300), seven);
  const tracker = new CandidateTracker();
  const s = address('차오동 123'), alt = address('버들동 456');
  tracker.update([s, alt], 0); tracker.freeze(s);
  assert.deepEqual(tracker.update([address('나동 789')], 100), [s, alt]);
  assert.equal(isSameAddressFamily(address('차오동 산 123'), address('차오동 123')), false);
  assert.equal(isOlderVersion('2026-09-13', '2026-09-14'), true);
  assert.equal(isOlderVersion('2026-09-14T20:00:00', '2026-09-14'), false);
});

const fixture = AddressDictionary.fromObject({
  '경기도': {'솔내시 푸록구': {localities: ['차오동', '나동'], roads: {'별골로12길': ['차오동']}},
    '솔내시 새움구': {localities: ['모잔동', '버들동'], roads: {'가람동로': ['모잔동']}}},
  '부산광역시': {'새동구': {localities: ['뫼천동']}},
  '전라남도': {'바람군': {localities: ['들이면', '솔송리']}},
});
const engine = new AddressCandidateEngine(fixture);

test('dictionary engine with fixture', () => {
  const region = {province: '경기도', district: '솔내시 푸록구'};
  for (const road of ['별골로1길', '별골로13길', '별골로길']) {
    assert.deepEqual(fixture.match(road, Kind.ROAD, region), []);
    const c = engine.candidate(`${road} 123-4`, region);
    assert.equal(c.text, `경기도 솔내시 푸록구 ${road} 123-4`);
    assert.ok(c.confidence < 88);
    assert.equal(c.verified, false);
  }
  assert.equal(engine.candidate('별굴로12길 123-4', region).text, '경기도 솔내시 푸록구 별골로12길 123-4');
  assert.ok(fixture.districts('경기도').includes('솔내시'));
  assert.ok(fixture.localities('경기도', '솔내시').includes('모잔동'));
  assert.equal(engine.candidate('가람동로 25', {province: '경기도', district: '솔내시'}).text, '경기도 솔내시 새움구 가람동로 25');
  assert.equal(engine.candidate('차오동 123-4', {province: '경기도'}).text, '경기도 솔내시 푸록구 차오동 123-4');
  assert.equal(fixture.correctDistrict('솔내시', '경기도'), '솔내시');
  const typo = engine.candidate('푸콕구 차오동 123-4', region);
  assert.equal(typo.text, '경기도 솔내시 푸록구 차오동 123-4');
  assert.equal(typo.dictionaryCorrected, true);
  assert.equal(engine.candidate('솔송리 123', {province: '전라남도', district: '바람군'}).text, '전라남도 바람군 솔송리 123');
  assert.equal(engine.candidate('별골로12길 123', {...region, localities: ['차오동']}).text, '경기도 솔내시 푸록구 별골로12길 123');
  assert.equal(engine.candidate('부산광역시 새동구 뫼천동 849-25', region).text, '부산광역시 새동구 뫼천동 849-25');
  assert.equal(engine.candidate('바람군 들이면 솔송리 123', region).text, '전라남도 바람군 들이면 솔송리 123');
});

test('dictionary parser and validator safety', () => {
  const sample = `${FORMAT_HEADER}\n# generated=2026-09-14\nA\t경기도\t솔내시 푸록구\t차오동\n`;
  const d = AddressDictionary.parse(sample);
  assert.deepEqual(d.provinces(), ['경기도']);
  assert.equal(d.version, '2026-09-14');
  assert.throws(() => AddressDictionary.parse(`${FORMAT_HEADER}\n# generated=broken\n`));
  assert.throws(() => AddressDictionary.parse('hello'));
  const withRoad = AddressDictionary.parse(`${FORMAT_HEADER}\n# generated=t\nA\t경기도\t솔내시 푸록구\t차오동\nR\t경기도\t솔내시 푸록구\t차오동\t별골로12길\n`);
  assert.deepEqual(withRoad.districts('경기도'), ['솔내시', '솔내시 푸록구']);
  assert.deepEqual(withRoad.localities('경기도', '솔내시 푸록구'), ['차오동']);
  assert.equal(validateDictionaryText(sample), '2026-09-14');
  assert.throws(() => validateDictionaryText(`${FORMAT_HEADER}\n# generated=x\nX\t경기도\t솔내시\t차오동\n`));
  for (let i = 0; i < 140; i++) d.match(`후보${i}동`, Kind.PARCEL, {});
  assert.ok(d.matchCache.size <= 128);
});

// One misread initial consonant in the first syllable (like a real OCR slip).
const misread = word => {
  const index = word.charCodeAt(0) - 0xAC00;
  if (index < 0 || index >= 11172) return word;
  return String.fromCharCode(0xAC00 + ((Math.floor(index / 588) + 1) % 19) * 588 + index % 588) + word.slice(1);
};

// Real names picked from the nationwide data at run time, so no real address is written in this test.
function realSample(text) {
  const rows = text.split(/\r?\n/).filter(l => l.startsWith('A\t경기도\t') || l.startsWith('R\t경기도\t')).map(l => l.split('\t'));
  const districts = new Set(rows.filter(r => r[0] === 'A').map(r => r[2]));
  const group = (kind, column) => {
    const map = new Map();
    for (const r of rows) if (r[0] === kind && r[column]) map.set(r[2], [...(map.get(r[2]) ?? []), r[column]]);
    return map;
  };
  const localities = group('A', 3), roads = group('R', 4);
  for (const district of [...districts].sort()) {
    const [city, gu = ''] = district.split(' ');
    const siblings = [...districts].filter(d => d.startsWith(`${city} `) && d !== district);
    const misreadGu = gu.length >= 3 ? misread(gu) : null;
    if (!siblings.length || !misreadGu || districts.has(`${city} ${misreadGu}`)) continue;
    const elsewhereLocalities = new Set(siblings.flatMap(d => localities.get(d) ?? []));
    const elsewhereRoads = new Set(siblings.flatMap(d => roads.get(d) ?? []));
    const locality = (localities.get(district) ?? []).find(l => l.endsWith('동') && !l.includes(' ') && !elsewhereLocalities.has(l));
    const road = (roads.get(district) ?? []).find(r => /\d길$/.test(r) && !elsewhereRoads.has(r));
    if (locality && road) return {city, gu, misreadGu, locality, road};
  }
  throw new Error('no city with several districts');
}

const realPath = fileURLToPath(new URL('../dist/models/address_dictionary.tsv.gz', import.meta.url));
test('real Android dictionary', {skip: !existsSync(realPath) && 'dictionary not downloaded'}, () => {
  const started = performance.now();
  const text = gunzipSync(readFileSync(realPath)).toString('utf8');
  const dictionary = AddressDictionary.parse(text);
  console.log(`parsed ${dictionary.version} in ${Math.round(performance.now() - started)} ms`);
  const real = new AddressCandidateEngine(dictionary);
  const s = realSample(text);
  for (const p of ['경기도', '서울특별시', '부산광역시']) assert.ok(dictionary.provinces().includes(p));
  assert.ok(dictionary.districts('경기도').includes(s.city));
  assert.ok(dictionary.districts('경기도').some(d => d.endsWith('군')));
  assert.ok(dictionary.localities('경기도', s.city).includes(s.locality));
  const region = {province: '경기도', district: s.city};
  const full = `경기도 ${s.city} ${s.gu}`;
  assert.equal(real.candidate(`${s.locality} 123-4`, region).text, `${full} ${s.locality} 123-4`);
  assert.equal(real.candidate(`경기도 ${s.city} ${s.misreadGu} ${s.locality} 123-4`, region).text, `${full} ${s.locality} 123-4`);
  assert.equal(real.candidate(`${s.road} 4-1, 101동 1203호`, region).text, `${full} ${s.road} 4-1`);
  const uncertain = real.candidates([`${full} 별골로12길 123-4, 101동 1203호`], region);
  assert.ok(uncertain.length);
  for (const c of uncertain) {
    const parts = parseParts(c.text);
    assert.deepEqual(parts.name.match(/\d+/g), ['12']);
    assert.equal(parts.number, '123-4');
    assert.equal(c.verified, false);
  }
  const policy = new AutoConversionPolicy();
  for (let i = 0; i < 3; i++) assert.equal(policy.update(uncertain.map(c => ({...c, manualOnly: true})), null, i * 300), null);
  const restored = real.candidate(`${full} ${s.road.slice(0, -1)}\n길 25 102동 2\n901호`, region);
  assert.equal(restored.text, `${full} ${s.road} 25`);
  assert.equal(restored.verified, false);
  const part = real.candidates([s.locality], region)[0];
  assert.equal(part.completeness, PARTIAL);
  assert.equal(parseParts(part.text).number, null);
  const t = performance.now();
  for (let i = 0; i < 20; i++) real.candidates([`경기 ${full.slice(4)} ${s.road} ${i + 1} 104동1202호`, `${s.locality} 716-7`], {province: '경기도', district: `${s.city} ${s.gu}`});
  console.log(`20 engine runs in ${Math.round(performance.now() - t)} ms`);
  assert.ok(COMPLETE);
});
