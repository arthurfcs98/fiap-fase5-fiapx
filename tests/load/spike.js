/**
 * Spike test (k6) for the demo: N virtual users upload videos at the same time and the run
 * passes only if EVERY upload got 202 and EVERY accepted video ends COMPLETED (no request lost).
 *
 *   make up WORKERS=3 && make load VUS=20 DURATION=30s
 *   k6 run -e BASE_URL=http://127.0.0.1:8080 -e VUS=20 -e DURATION=30s tests/load/spike.js
 *
 * Env: BASE_URL (default http://127.0.0.1:8080), VUS (20), DURATION of the plateau (30s),
 * PAUSE_S between uploads of one VU (1), PROCESS_TIMEOUT_S to wait for the queue to drain (300).
 * Uploads examples/sample-ok-5s.mp4 (versioned). Each VU has its own user (created in setup).
 */
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '30s';
const PAUSE_S = Number(__ENV.PAUSE_S || 1);
const PROCESS_TIMEOUT_S = Number(__ENV.PROCESS_TIMEOUT_S || 300);
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const video = open('../../examples/sample-ok-5s.mp4', 'b');

const uploadsAccepted = new Rate('uploads_accepted'); // 202 / total uploads
const uploadsSent = new Counter('uploads_sent');
const videosCompleted = new Rate('videos_completed'); // COMPLETED / videos found at the end
const videosFound = new Counter('videos_found');

export const options = {
  setupTimeout: '180s',
  teardownTimeout: `${PROCESS_TIMEOUT_S + 60}s`,
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: VUS }, // spike
        { duration: DURATION, target: VUS }, // plateau
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    uploads_accepted: ['rate==1'], // 100% of the uploads answered 202
    videos_completed: ['rate==1'], // every accepted video ended COMPLETED
    'http_req_duration{name:upload}': ['p(95)<5000'], // SLO: upload accepted in < 5 s (p95)
    checks: ['rate==1'],
  },
};

const json = { headers: { 'content-type': 'application/json' } };

export function setup() {
  const users = [];
  for (let index = 0; index < VUS; index += 1) {
    const email = `k6.${RUN_ID}.${index}@example.com`;
    const password = `senha-k6-${RUN_ID}`;
    const body = { name: `Carga k6 ${index}`, email, password, acceptPrivacyPolicy: true };
    const registered = http.post(`${BASE_URL}/api/auth/register`, JSON.stringify(body), {
      ...json,
      tags: { name: 'register' },
    });
    check(registered, { 'cadastro 201': (res) => res.status === 201 });
    const login = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ email, password }), {
      ...json,
      tags: { name: 'login' },
    });
    check(login, { 'login 200': (res) => res.status === 200 });
    users.push({ token: login.json('accessToken') });
  }
  return { users };
}

export default function (data) {
  const user = data.users[(exec.vu.idInTest - 1) % data.users.length];
  const iteration = exec.vu.iterationInScenario;
  const res = http.post(
    `${BASE_URL}/api/videos`,
    { video: http.file(video, 'k6-spike.mp4', 'video/mp4') },
    {
      headers: {
        authorization: `Bearer ${user.token}`,
        'idempotency-key': `k6-${RUN_ID}-${exec.vu.idInTest}-${iteration}`,
        'x-correlation-id': `k6-${RUN_ID}-${exec.vu.idInTest}-${iteration}`,
      },
      tags: { name: 'upload' },
    },
  );
  uploadsSent.add(1);
  uploadsAccepted.add(res.status === 202);
  check(res, { 'upload 202': (r) => r.status === 202 });
  sleep(PAUSE_S);
}

/** Every video of one user (all pages). */
function listVideos(token) {
  const videos = [];
  for (let page = 1; ; page += 1) {
    const res = http.get(`${BASE_URL}/api/videos?page=${page}&limit=100`, {
      headers: { authorization: `Bearer ${token}` },
      tags: { name: 'list' },
    });
    if (res.status !== 200) break;
    const items = res.json('items') || [];
    videos.push(...items);
    if (items.length < 100) break;
  }
  return videos;
}

/** Waits for the queue to drain and checks that every accepted video ended COMPLETED. */
export function teardown(data) {
  const deadline = Date.now() + PROCESS_TIMEOUT_S * 1000;
  const snapshot = () => {
    const all = data.users.flatMap((user) => listVideos(user.token));
    const queued = all.filter((v) => v.status === 'QUEUED' || v.status === 'PROCESSING').length;
    return { videos: all, pending: queued };
  };
  let { videos, pending } = snapshot();
  while (pending > 0 && Date.now() < deadline) {
    console.log(`aguardando o processamento: ${pending} de ${videos.length} na fila`);
    sleep(3);
    ({ videos, pending } = snapshot());
  }
  const completed = videos.filter((v) => v.status === 'COMPLETED').length;
  for (const v of videos) videosCompleted.add(v.status === 'COMPLETED');
  videosFound.add(videos.length);
  console.log(
    `resultado: ${videos.length} vídeos aceitos, ${completed} COMPLETED, ` +
      `${videos.length - completed - pending} FAILED, ${pending} ainda na fila`,
  );
}

export function handleSummary(data) {
  const metric = (name, field) => (data.metrics[name] ? data.metrics[name].values[field] : 0);
  const sent = metric('uploads_sent', 'count');
  const found = metric('videos_found', 'count');
  const p95 = metric('http_req_duration{name:upload}', 'p(95)');
  const lines = [
    '',
    '=== FIAP Frames: teste de pico (k6) ===',
    `uploads enviados ............ ${sent}`,
    `uploads aceitos (202) ....... ${(metric('uploads_accepted', 'rate') * 100).toFixed(2)}%`,
    `vídeos encontrados no fim ... ${found} (perdidos: ${Math.max(0, sent - found)})`,
    `vídeos COMPLETED ............ ${(metric('videos_completed', 'rate') * 100).toFixed(2)}%`,
    `p95 do upload ............... ${p95 ? p95.toFixed(0) : '?'} ms (SLO < 5000 ms)`,
    '',
    'thresholds:',
  ];
  for (const [name, values] of Object.entries(data.metrics)) {
    for (const [expression, result] of Object.entries(values.thresholds || {})) {
      lines.push(`  ${result.ok ? 'OK    ' : 'FALHOU'} ${name}: ${expression}`);
    }
  }
  lines.push('');
  return { stdout: lines.join('\n') };
}
