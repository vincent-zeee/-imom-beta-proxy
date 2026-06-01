// ─────────────────────────────────────────────────────────────
// Vercel 프록시 (권장 버전) — Anthropic API 호출 대행
//
// 보호 2단계:
//  1) ORIGIN 허용 목록 — 우리 앱 도메인에서 온 요청만 CORS 허용
//  2) Firebase ID 토큰 검증 (firebase-admin) — 로그인한 우리 사용자만 호출 가능
//
// ── 설치 (깃허브 레포에서) ──
//   package.json 에 의존성 추가:  "firebase-admin": "^12.0.0"
//   (Vercel이 배포 시 자동 설치)
//
// ── Vercel 환경변수 ──
//   ANTHROPIC_API_KEY      : 기존 그대로
//   FIREBASE_PROJECT_ID    : imom-beta
//   FIREBASE_CLIENT_EMAIL  : (서비스 계정 이메일)
//   FIREBASE_PRIVATE_KEY   : (서비스 계정 비공개 키, 줄바꿈 \n 포함)
//
//   서비스 계정은 Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 →
//   "새 비공개 키 생성"으로 JSON 받으면 그 안에 세 값이 있어요.
//   FIREBASE_PRIVATE_KEY 는 줄바꿈이 \n 으로 들어가야 하니, 아래 코드에서 복원합니다.
// ─────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

// 우리 앱 도메인만 허용 (깃허브 페이지 주소로 교체, 경로 말고 도메인만)
const ALLOWED_ORIGINS = [
  'https://YOUR-GITHUB-USERNAME.github.io',
  // 'http://localhost:3000',   // 로컬 테스트 시에만 잠깐
];

// firebase-admin 1회 초기화 (서버리스 재사용 대비 guard)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // 환경변수에 저장된 \n 을 실제 줄바꿈으로 복원
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // 1단계: origin 차단
  if (!allowed) {
    return res.status(403).json({ error: { message: 'origin not allowed' } });
  }

  // 2단계: 로그인 토큰 검증
  const authz = req.headers.authorization || '';
  const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!idToken) {
    return res.status(401).json({ error: { message: 'missing auth token' } });
  }
  try {
    await admin.auth().verifyIdToken(idToken); // 실패 시 throw
    // 필요하면 여기서 decoded.uid 로 사용자별 호출 한도 등을 적용할 수 있음
  } catch (e) {
    return res.status(401).json({ error: { message: 'invalid auth token' } });
  }

  // 통과: Anthropic 호출 대행
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: { message: 'upstream error: ' + e.message } });
  }
}
