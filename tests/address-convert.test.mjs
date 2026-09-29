// Ported from AddressConverterTest / AddressVerificationTest / RawSearchFlowTest plus browser-provider flows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Kind} from '../dist/address-core.mjs';
import {AddressConverter, Source, matchRows, qualifyAddress, selectOutcome, parseVworld, parseKakao, outcome} from '../dist/address-convert.mjs';

test('qualifies short provider addresses', () => {
  assert.equal(qualifyAddress('늘촌1길 4-1', '경기도 솔내시 새움구 버들동 716-7'), '경기도 솔내시 새움구 늘촌1길 4-1');
  assert.equal(qualifyAddress('버들동 716-7', '경기도 솔내시 새움구 늘촌1길 4-1 (버들동)'), '경기도 솔내시 새움구 버들동 716-7');
});

test('each provider uses the exact gate rather than the first similar hit', () => {
  for (const source of Object.values(Source)) {
    const rows = [{parcel: '경기도 솔내시 푸록구 차오동 5-1', road: '경기도 솔내시 푸록구 별골로 11'}];
    const miss = matchRows('경기도 솔내시 푸록구 차오동 5', Kind.PARCEL, rows, source);
    assert.equal(miss.type, 'noExactMatch');
    assert.equal(miss.suggestions.length, 1);
    assert.equal(miss.suggestions[0].recognizedAddress, '경기도 솔내시 푸록구 차오동 5-1');
    assert.equal(matchRows('차오동 5-1', Kind.PARCEL, rows, source).type, 'success');
    const related = matchRows('차오동 5', Kind.PARCEL, [{...rows[0], related: ['경기도 솔내시 푸록구 차오동 5']}], source);
    assert.equal(related.type, 'success');
  }
});

test('omitted region does not pick the first of several exact parcels', () => {
  const rows = [{parcel: '경기도 솔내시 푸록구 차오동 5', road: '경기도 솔내시 푸록구 별골로 10'},
    {parcel: '경기도 가상시 차오동 5', road: '경기도 가상시 새뫼길 20'}];
  assert.equal(matchRows('차오동 5', Kind.PARCEL, rows, Source.VWORLD).type, 'noExactMatch');
  const exact = matchRows('경기도 솔내시 푸록구 차오동 5', Kind.PARCEL, rows, Source.VWORLD);
  assert.equal(exact.type, 'success');
  assert.equal(exact.result.convertedAddress, '경기도 솔내시 푸록구 별골로 10');
});

test('provider errors are not disguised by another provider miss', () => {
  const error = outcome.networkError('401');
  assert.deepEqual(selectOutcome([error, outcome.notFound()]), error);
  assert.deepEqual(selectOutcome([outcome.noExactMatch([]), error]), error);
  assert.equal(selectOutcome([error, outcome.offline()]).type, 'offline');
});

const vworldBody = rows => ({response: {status: 'OK', result: {items: rows.map(([parcel, road]) => ({address: {parcel, road}}))}}});

test('parses VWorld and Kakao responses in both directions', () => {
  const road = parseVworld('경기도 솔내시 새움구 버들동 716-7', Kind.PARCEL, vworldBody([['버들동 716-7', '경기도 솔내시 새움구 늘촌1길 4-1']]));
  assert.equal(road.type, 'success');
  assert.equal(road.result.recognizedAddress, '경기도 솔내시 새움구 버들동 716-7');
  assert.equal(road.result.convertedAddress, '경기도 솔내시 새움구 늘촌1길 4-1');
  const parcel = parseVworld('솔내시 새움구 늘촌1길 4-1', Kind.ROAD, vworldBody([['경기도 솔내시 새움구 버들동 716-7', '경기도 솔내시 새움구 늘촌1길 4-1']]));
  assert.equal(parcel.type, 'success');
  assert.equal(parcel.result.convertedAddress, '경기도 솔내시 새움구 버들동 716-7');
  assert.equal(parseVworld('버들동 716-7', Kind.PARCEL, {response: {status: 'NOT_FOUND'}}).type, 'notFound');
  assert.deepEqual(parseVworld('버들동 716-7', Kind.PARCEL, {response: {status: 'ERROR', error: {text: '등록되지 않은 인증키입니다.'}}}),
    outcome.networkError('등록되지 않은 인증키입니다.'));
  const kakao = parseKakao('경기 솔내시 새움구 버들동 716-7', Kind.PARCEL, {documents: [{address: {address_name: '경기 솔내시 새움구 버들동 716-7'},
    road_address: {address_name: '경기 솔내시 새움구 늘촌1길 4-1'}}]});
  assert.equal(kakao.type, 'success');
  assert.equal(kakao.result.convertedAddress, '경기도 솔내시 새움구 늘촌1길 4-1');
  assert.equal(parseKakao('버들동 716-7', Kind.PARCEL, {documents: [{address: {address_name: '경기 솔내시 새움구 버들동'}, road_address: null}]}).type, 'notFound');
});

test('converter: key missing, offline, fallback order, cache and request contents', async () => {
  let online = true;
  const urls = [];
  const fetched = [];
  let vworld = () => vworldBody([['경기도 솔내시 새움구 버들동 716-7', '경기도 솔내시 새움구 늘촌1길 4-1']]);
  const make = keys => new AddressConverter({getKeys: () => keys, isOnline: () => online, origin: () => 'https://example.pages.dev',
    loadJsonp: async url => { urls.push(url); return vworld(); },
    fetchImpl: async (url, init) => { fetched.push([url, init.headers.Authorization]); return {ok: true, status: 200,
      json: async () => ({documents: [{address: {address_name: '경기 솔내시 새움구 버들동 716-7'}, road_address: {address_name: '경기 솔내시 새움구 늘촌1길 4-1'}}]})}; }});

  assert.equal((await make({}).convert('버들동 716-7')).type, 'apiKeyMissing');
  online = false;
  assert.equal((await make({vworld: 'K'}).convert('버들동 716-7')).type, 'offline');
  online = true;

  const converter = make({vworld: 'K', kakao: 'R'});
  const first = await converter.convert('경기도 솔내시 새움구 버들동 716-7 203호');
  assert.equal(first.type, 'success');
  assert.equal(first.result.source, Source.VWORLD);
  assert.equal(urls.length, 1);
  const url = new URL(urls[0]);
  assert.equal(url.searchParams.get('query'), '경기도 솔내시 새움구 버들동 716-7');
  assert.equal(url.searchParams.get('category'), 'parcel');
  assert.equal(url.searchParams.get('domain'), 'https://example.pages.dev');
  assert.equal(fetched.length, 0);
  online = false;
  assert.equal((await converter.convert('경기도 솔내시 새움구 버들동 716-7')).type, 'success', 'verified result reused offline');
  online = true;

  vworld = () => ({response: {status: 'ERROR', error: {text: '인증키 도메인 불일치'}}});
  const fallback = await make({vworld: 'K', kakao: 'R'}).convert('솔내시 새움구 버들동 716-7');
  assert.equal(fallback.type, 'success');
  assert.equal(fallback.result.source, Source.KAKAO);
  assert.equal(fetched[0][1], 'KakaoAK R');
  const onlyVworld = await make({vworld: 'K'}).convert('솔내시 새움구 버들동 716-7');
  assert.deepEqual(onlyVworld, outcome.networkError('인증키 도메인 불일치'));

  vworld = () => { throw Object.assign(new Error('timeout'), {timeout: true}); };
  const timeout = await make({vworld: 'K'}).convert('버들동 716-7');
  assert.equal(timeout.type, 'networkError');
  assert.match(timeout.message, /사이트 주소/);
});
