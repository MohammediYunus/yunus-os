import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../lib/config.mjs';
import { collectGitHub, createDashboard } from '../lib/connectors.mjs';
import { workspaceSummary } from '../js/lib/local-commands.js';

const item = number => ({ number, title: `Fixture PR ${number}`, repository_url: 'https://api.github.com/repos/example/project', html_url: `https://github.com/example/project/pull/${number}` });
const response = (total = 37, length = 15, incomplete = false) => ({ total_count: total, incomplete_results: incomplete, items: Array.from({ length }, (_, i) => item(i + 1)) });
const config = () => { const value = defaults(); value.mode = 'live'; value.github.username = 'example'; return value; };
const fetchFor = value => async () => ({ ok: true, json: async () => structuredClone(value) });
const summaryFor = github => workspaceSummary({ sources: { github: { status: 'live' } }, github });

test('GitHub search retains total counts separately from the bounded page for every category', async () => {
  const calls = [];
  const github = await collectGitHub(config(), async url => {
    calls.push(url);
    return { ok: true, json: async () => response() };
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(url => new URL(url).searchParams.get('per_page') === '15'));
  for (const key of ['myOpenPRs', 'reviewRequested', 'openIssues']) {
    assert.equal(github[key].length, 15);
    assert.equal(github.counts[key], 37);
    assert.deepEqual(github.search[key], { totalCount: 37, incompleteResults: false });
  }
  const text = summaryFor(github);
  assert.match(text, /37 open pull requests \(15 loaded\)/);
  assert.match(text, /37 reviews requested \(15 loaded\)/);
});

test('incomplete GitHub search preserves rows and metadata without certifying a total', async () => {
  const github = await collectGitHub(config(), fetchFor(response(37, 8, true)));
  assert.deepEqual(github.search.myOpenPRs, { totalCount: 37, incompleteResults: true });
  assert.equal(github.counts.myOpenPRs, null);
  const text = summaryFor(github);
  assert.match(text, /8 open pull requests loaded \(total unknown; GitHub search incomplete\)/);
  assert.doesNotMatch(text, /37 open pull requests/);
});

test('confirmed complete zero search counts remain zero', async () => {
  const github = await collectGitHub(config(), fetchFor(response(0, 0)));
  assert.equal(github.counts.myOpenPRs, 0);
  assert.match(summaryFor(github), /0 open pull requests; 0 reviews requested\./);
});

test('incomplete zero results never become an empty queue claim', async () => {
  const github = await collectGitHub(config(), fetchFor(response(0, 0, true)));
  assert.equal(github.counts.myOpenPRs, null);
  assert.match(summaryFor(github), /0 open pull requests loaded \(total unknown; GitHub search incomplete\)/);
});

test('missing and malformed search metadata are loaded rows with unknown totals', async () => {
  for (const metadata of [
    {}, { total_count: 37 }, { total_count: '37', incomplete_results: false },
    { total_count: -1, incomplete_results: false }, { total_count: 1.5, incomplete_results: false },
    { total_count: 1, incomplete_results: false }, { total_count: Number.MAX_SAFE_INTEGER + 1, incomplete_results: false },
    { total_count: 37, incomplete_results: 'false' },
  ]) {
    const github = await collectGitHub(config(), fetchFor({ items: [item(1), item(2)], ...metadata }));
    assert.equal(github.counts.myOpenPRs, null);
    assert.match(summaryFor(github), /2 open pull requests loaded \(total unknown\)/);
  }
});

test('legacy cached counts do not certify a complete search', () => {
  const github = { user: 'example', counts: { myOpenPRs: 37, reviewRequested: 0 }, myOpenPRs: [item(1)], reviewRequested: [] };
  assert.match(summaryFor(github), /1 open pull request loaded \(total unknown\)/);
  assert.match(summaryFor(github), /0 reviews requested loaded \(total unknown\)/);
});

test('last-known cache retains search bounds and recovers exactness after refresh', async () => {
  let input = response(37, 15), fail = false;
  const board = createDashboard({ store: { get: config, tasks: () => [] }, fetchImpl: async () => {
    if (fail) return { ok: false, status: 503 };
    return { ok: true, json: async () => structuredClone(input) };
  } });
  const fresh = await board.load();
  fail = true;
  const stale = await board.load(true);
  assert.equal(stale.sources.github.stale, true);
  assert.deepEqual(stale.github.search, fresh.github.search);
  assert.match(workspaceSummary(stale), /GitHub unavailable/);
  assert.doesNotMatch(workspaceSummary(stale), /37 open pull requests/);
  fail = false; input = response(12, 12);
  const recovered = await board.load(true);
  assert.equal(recovered.github.counts.myOpenPRs, 12);
  assert.match(workspaceSummary(recovered), /12 open pull requests; 12 reviews requested/);
});

test('repository-only connections do not claim exact user search counts', async () => {
  const value = config(); value.github.username = ''; value.github.repositories = ['example/project'];
  const github = await collectGitHub(value, fetchFor({ workflow_runs: [] }));
  assert.equal(github.counts.myOpenPRs, null);
  assert.equal(github.counts.reviewRequested, null);
  assert.match(summaryFor(github), /no username configured/);
});
