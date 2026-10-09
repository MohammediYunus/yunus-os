// Entirely synthetic. No original Yunus OS operational files are read or imported.
// The fictional workspace does not execute voice, tasks, or integrations.
export function createFixtures(now = new Date()) {
  const ago = minutes => new Date(now.getTime() - minutes * 60_000).toISOString();
  const modules = [
    ['Interface', 'interface', 'shell,panel-registry,status-strip,graph-canvas,focus-card,feed-list,theme-store,command-bar,shortcut-map,clock,toast-stack,loading-state,empty-state,layout-grid,tab-control,scroll-anchor,accessibility,formatters,mount'],
    ['Voice input', 'voice', 'capture,input-device,permission-state,level-meter,vad,hold-trigger,tap-threshold,pcm-buffer,wav-encoder,playback-queue,interrupt,audio-session,sample-rate,silence-trim,waveform,device-events,volume,error-state,types'],
    ['Transcription', 'transcription', 'pipeline,local-adapter,model-resolver,resampler,segmenter,text-normalizer,vocabulary,confidence,language,fallback-policy,timeout,result-cache,request,response,worker,fixtures,metrics,validation,types'],
    ['Conversation', 'conversation', 'session,turn-queue,context-builder,message-store,sentence-buffer,stream-reader,reply-router,history-window,summarizer,token-budget,cancel-token,speaker-state,persona,text-cleaner,model-adapter,retry-policy,attachments,events,types'],
    ['Intent routing', 'intent', 'router,classifier,schema,target-resolver,answer-policy,command-policy,task-policy,confidence-gate,fallback,normalizer,examples,request,result,validation,telemetry,cache,timeout,events,types'],
    ['Commands', 'commands', 'registry,dispatch,allowlist,open-target,focus-window,switch-view,show-status,inspect-module,prepare-checklist,cancel,result,validation,shortcut,request,history,permissions,examples,events,types'],
    ['GUI agents', 'agents', 'runner,screen-state,step-planner,tool-registry,coordinate-map,screenshot-loop,click-step,type-step,scroll-step,retry-budget,progress-stream,completion,handoff,boundary-check,action-log,target-page,session,events,types'],
    ['Tasks', 'tasks', 'queue,checklist,release-plan,item-store,priority,status,due-date,review-step,draft-buffer,local-target,validation,progress,templates,history,attachments,search,filters,events,types'],
    ['Runtime', 'runtime', 'bootstrap,http-router,scheduler,worker-pool,health,event-bus,lifecycle,shutdown,config,clock,resource-budget,retry,timeout,result,request,response,middleware,environment,types'],
    ['Storage', 'storage', 'store,cache,adapter,schema,migration,serializer,snapshot,read-model,query,index,transaction,ttl,validation,version,fixtures,memory,events,errors,types'],
    ['Telemetry', 'telemetry', 'logger,metrics,trace,latency,counter,sampler,redaction,event-schema,buffer,exporter,health-summary,run-status,collector,heartbeat,retention,labels,formatters,alerts,types'],
    ['Tests', 'tests', 'voice.spec,transcription.spec,conversation.spec,intent.spec,commands.spec,agents.spec,tasks.spec,runtime.spec,storage.spec,telemetry.spec,interface.spec,graph.spec,fixture-contract.spec,permissions.spec,keyboard.spec,theme.spec,isolation.spec,helpers,setup'],
  ];
  const nodes = modules.flatMap(([communityName, directory, files], community) => files.split(',').map((file, index) => ({
    id: `sample-${community}-${index}`, label: `${directory}/${file}.ts`, community, communityName, degree: 0,
    fileType: community === 11 ? 'test' : 'typescript',
  })));
  const links = [], seen = new Set();
  const nodeId = (group, index) => `sample-${group}-${index}`;
  function add(source, target, weight = 1) {
    const key = [source, target].sort().join(':');
    if (source === target || seen.has(key)) return;
    seen.add(key); links.push({ source, target, weight });
  }
  // Local connectivity, varied hubs and domain bridges avoid identical clusters.
  for (let group = 0; group < modules.length; group++) {
    for (let i = 0; i < 19; i++) {
      add(nodeId(group, i), nodeId(group, (i + 1) % 19));
      if (i % 3 !== 2) add(nodeId(group, i), nodeId(group, (i + 3) % 19));
      if (i > 0 && (i + group) % 4 !== 0) add(nodeId(group, 0), nodeId(group, i), 2);
      if (i > 2 && i % (group % 3 + 2) === 0) add(nodeId(group, 2), nodeId(group, i));
    }
    for (const [target, weight] of [[8, 3], [9, 2], [10, 1]]) add(nodeId(group, 0), nodeId(target, 0), weight);
    add(nodeId(group, 0), nodeId(11, group % 11), 2);
    add(nodeId(group, 2), nodeId((group + 1) % 12, 0));
  }
  // Dispatch/runtime have more cross-domain dependencies than leaf modules.
  for (const group of [0, 1, 2, 3, 5, 6, 7]) {
    for (const index of [0, 2, 3, 7, 12, 18]) {
      add(nodeId(4, 0), nodeId(group, index), 2);
      add(nodeId(8, 1), nodeId(group, (index + 4) % 19));
    }
  }
  let randomState = 0x59a7;
  const random = max => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % max; };
  while (links.length < 924) {
    const group = random(12), other = random(4) === 0 ? random(12) : group;
    const index = random(5) === 0 ? 0 : random(19);
    add(nodeId(group, index), nodeId(other, random(19)), 1 + random(3));
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const link of links) { byId.get(link.source).degree++; byId.get(link.target).degree++; }
  const checklist = [
    ['Define the synthetic workspace contract', true], ['Populate the seven console panels', true],
    ['Build the fictional module graph', true], ['Add connected-module focus', true],
    ['Keep task records view-only', true], ['Add deterministic activity fixtures', true],
    ['Label simulated runtime and repository status', true], ['Review dark and light contrast', true],
    ['Check keyboard navigation', true], ['Document the local preview', true],
    ['Review the failing sample keyboard check', false], ['Approve the sample release checklist', false],
    ['Capture the public walkthrough', false],
  ];
  const newsTopics = [
    ['anthropic', 'Designing a review step for a desktop agent'], ['openai', 'A small evaluation set before a model change'],
    ['hn', 'What makes an open-source tool useful on day one?'], ['reddit', 'A command center that reduces context switching'],
    ['anthropic', 'Keeping tool permissions easy to understand'], ['openai', 'Streaming answers without blocking the interface'],
    ['hn', 'Local speech recognition for short commands'], ['reddit', 'How do you test a screenshot-driven agent?'],
    ['anthropic', 'Separate intent routing from task execution'], ['openai', 'Measure task results instead of demo polish'],
    ['hn', 'Readable code graphs with hundreds of modules'], ['reddit', 'Share one useful workflow before ten features'],
    ['anthropic', 'Ground a status brief in the data you can inspect'], ['openai', 'Cancel a turn without leaving stale UI state'],
    ['hn', 'Plain data contracts for personal dashboards'], ['reddit', 'What belongs in a developer status bar?'],
    ['anthropic', 'Give the user a clear handoff at the end of a task'], ['openai', 'Synthetic fixtures that exercise edge cases'],
    ['hn', 'A dependency-free app can still have good ergonomics'], ['reddit', 'Keyboard-first tools for daily work'],
    ['anthropic', 'Make agent progress readable without a wall of logs'], ['openai', 'Keep secrets out of telemetry events'],
    ['hn', 'A local preview should explain its simulated integrations'], ['reddit', 'Release checklists that fit on one screen'],
    ['anthropic', 'Build a permission boundary before an automation'], ['openai', 'Test the interruption path as well as success'],
    ['hn', 'Turning a personal script into a maintained project'], ['reddit', 'Which workflow should this command center tackle next?'],
  ];
  const reviewRequested = [
    ['console-kit', 42, 'Improve table keyboard focus', 'demo-contributor', 85],
    ['task-board', 18, 'Keep review state after a reload', 'sample-builder', 140],
    ['graph-lab', 31, 'Show neighboring modules on focus', 'demo-maintainer', 230],
    ['voice-workbench', 12, 'Document the mock audio contract', 'sample-reviewer', 390],
  ].map(([repo, number, title, author, age]) => ({ repo: `sample/${repo}`, number, title: `Sample: ${title}`, author, createdAt: ago(age), isDraft: false }));
  const myOpenPRs = [
    ['command-center', 64, 'Fix the keyboard handoff state', 'demo/keyboard-handoff', 'failing', 'CHANGES_REQUESTED', 12],
    ['console-kit', 38, 'Polish the compact status strip', 'demo/status-strip', 'passing', 'APPROVED', 35],
    ['task-board', 22, 'Add a local release checklist', 'demo/release-checklist', 'passing', null, 68],
    ['fixture-vault', 17, 'Expand the fictional workspace dataset', 'demo/rich-fixtures', 'pending', null, 95],
    ['graph-lab', 29, 'Improve related-module labels', 'demo/graph-labels', 'passing', 'APPROVED', 185],
  ].map(([repo, number, title, branch, ci, reviewDecision, age]) => ({ repo: `sample/${repo}`, number, title: `Sample: ${title}`, branch, ci, reviewDecision, updatedAt: ago(age) }));
  const openIssues = [
    'Document interrupted task recovery', 'Add an empty transcript fixture', 'Clarify the review handoff',
    'Test a disconnected preview state', 'Describe graph keyboard controls', 'Tighten the fixture contract', 'Compare small-screen panel order',
  ].map((title, index) => ({ repo: `sample/${index % 2 ? 'console-kit' : 'command-center'}`, number: 70 + index, title: `Sample: ${title}`, labels: [index % 2 ? 'documentation' : 'enhancement'], updatedAt: ago(220 + index * 35) }));
  const recentRuns = [
    ['Keyboard checks', 'demo/keyboard-handoff', 'failure', 'completed', 12],
    ['Fixture contract', 'demo/rich-fixtures', null, 'in_progress', 15],
    ['Preview build', 'demo/status-strip', 'success', 'completed', 35], ['Unit tests', 'main', 'success', 'completed', 42],
    ['Graph checks', 'demo/graph-labels', 'success', 'completed', 70], ['Documentation', 'main', 'success', 'completed', 90],
    ['Release preview', 'demo/release-checklist', 'success', 'completed', 120], ['Older preview', 'demo/old-preview', 'cancelled', 'completed', 240],
  ].map(([workflow, branch, conclusion, status, age]) => ({ repo: 'sample/command-center', workflow: `Sample · ${workflow}`, branch, conclusion, status, updatedAt: ago(age) }));
  const repoRows = [
    ['command-center', 'demo/keyboard-handoff', 34, 4, 1, 7, 0, 1, 0.2, false, 'Fix the keyboard handoff state'],
    ['console-kit', 'demo/status-strip', 18, 2, 0, 3, 0, 0, 0.6, false, 'Polish the compact status strip'],
    ['task-board', 'demo/release-checklist', 12, 1, 0, 2, 1, 0, 1.1, false, 'Add a local release checklist'],
    ['voice-workbench', 'demo/audio-contract', 8, 2, 0, 1, 0, 2, 2.3, false, 'Document the mock audio contract'],
    ['graph-lab', 'demo/graph-labels', 6, 0, 1, 4, 0, 0, 3.1, false, 'Improve related-module labels'],
    ['fixture-vault', 'demo/rich-fixtures', 4, 1, 0, 2, 0, 0, 1.6, false, 'Expand the fictional workspace dataset'],
    ['release-notes', 'main', 0, 0, 0, 0, 0, 0, 7, false, 'Document the sample release plan'],
    ['docs-workshop', 'main', 2, 0, 0, 1, 0, 0, 5, false, 'Clarify local preview setup'],
    ['console-preview', 'demo/light-theme', 3, 0, 0, 1, 0, 0, 4, true, 'Check light theme contrast'],
    ['task-preview', 'demo/review-state', 5, 1, 0, 2, 0, 0, 6, true, 'Keep the checklist review state'],
    ['graph-preview', 'demo/cluster-layout', 0, 0, 0, 0, 2, 0, 27, true, 'Compare two fictional layouts'],
    ['archive-preview', 'demo/old-preview', 0, 0, 0, 0, 0, 1, 360, true, 'Record an earlier sample preview'],
  ];
  return {
    demo: true,
    disclosure: 'All names, activity, and counts are synthetic. No connected accounts.',
    mode: 'demo', fetchedAt: now.toISOString(),
    sources: Object.fromEntries(['runtime', 'initiative', 'graph', 'news', 'tasks', 'github', 'repos'].map(name => [name, { status: 'demo', updatedAt: now.toISOString() }])),
    runtime: { platform: 'Demo workspace', nodeVersion: 'sample', uptimeSeconds: 3600, connectedSources: 0, repoCount: 12, voiceReady: false, assistantProvider: 'local' },
    initiative: {
      fetchedAt: ago(3), name: 'Sample · Command center release', branch: 'demo/release-preview', planPath: '/synthetic/plans/command-center-release.md',
      checklist: { done: checklist.filter(([, done]) => done).length, total: checklist.length, items: checklist.map(([text, done]) => ({ text: `Sample: ${text}`, done })) },
      recentCommits: ['Keep the keyboard handoff visible', 'Add module graph focus states', 'Populate the synthetic task history', 'Expand sample repository activity', 'Tighten the read-only fixture boundary', 'Polish the compact status strip', 'Document interrupted task recovery', 'Add the local release checklist'].map((msg, index) => ({ sha: `demo${String(104 - index).padStart(3, '0')}`, msg: `Sample: ${msg}`, at: ago(20 + index * 47) })),
    },
    graph: { fetchedAt: ago(4), nodes, links, stats: { nodes: nodes.length, links: links.length, communities: modules.length }, builtAtCommit: 'demo104' },
    news: { fetchedAt: ago(2), items: newsTopics.map(([source, title], index) => ({ source, tag: source.toUpperCase(), title: `Sample: ${title}`, publishedAt: ago(18 + index * 21), ...(source === 'hn' || source === 'reddit' ? { points: 48 + index * 13, comments: 6 + index * 3 } : {}) })) },
    tasks: { fetchedAt: ago(1), items: checklist.map(([title, done], index) => ({ id: `demo-task-${index}`, title, done, createdAt: ago(index * 35) })) },
    github: { fetchedAt: ago(1), user: 'sample-user', counts: { reviewRequested: reviewRequested.length, myOpenPRs: myOpenPRs.length, openIssues: openIssues.length },
      search: Object.fromEntries(Object.entries({ reviewRequested, myOpenPRs, openIssues }).map(([name, rows]) => [name, { totalCount: rows.length, incompleteResults: false }])),
      reviewRequested, myOpenPRs, openIssues, recentRuns },
    repos: {
      fetchedAt: ago(1),
      repos: repoRows.map(([name, branch, dirtyFiles, untracked, deleted, ahead, behind, stashes, lastCommitAgeHours, worktree, message]) => ({ name, branch, dirtyFiles, untracked, deleted, staged: dirtyFiles ? Math.min(2, dirtyFiles) : 0, ahead, behind, stashes, lastCommitAgeHours, worktree, lastCommitMsg: `Sample: ${message}`, path: `/synthetic/workspaces/${name}` })),
      suggestions: [
        { severity: 'warn', text: 'Sample: review 34 command-center changes before the release.' },
        { severity: 'info', text: 'Sample: the graph preview is 2 commits behind.' },
        { severity: 'orange', text: 'Sample: capture the completed checklist after review.' },
        { severity: '', text: 'Sample: archive the unused preview worktree after inspection.' },
      ],
    },
    meta: { generatedAt: now.toISOString(), collectors: Object.fromEntries(['runtime', 'initiative', 'graph', 'news', 'tasks', 'github', 'repos'].map(name => [name, { ok: true, at: ago(1), ms: 0, source: 'synthetic' }])) },
  };
}
