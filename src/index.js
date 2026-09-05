/**
 * 体操&トランポリンクラブ LINE Webhook Gateway
 * 体験予約LIFF + イベント・大会申込LIFF
 *
 * 役割:
 * 1. LINE Webhookの署名を会場ごとに検証し、共通GASへ転送
 * 2. /reserve でLINE内体験予約フォームを表示
 * 3. LINEのIDトークンをサーバー側で検証してから、予約を共通GASへ保存
 * 4. /apply でイベント・大会申込をLINE内で完了し、申込控えをLINEトークへ残す
 *
 * 必須Bindings:
 * - GAS_WEBHOOK_URL
 * - GAS_FORWARD_KEY
 * - LIFF_ID
 * - LINE_LOGIN_CHANNEL_ID
 * - 下記 ROUTES で指定した LINE_SECRET_*（有効化する会場分のみ）
 *
 * 活動申込用LIFF IDは、配信用URLとの食い違いを防ぐため本コード内で固定します。
 * CloudflareのACTIVITY_LIFF_ID変数は参照しないため、残っていても動作へ影響しません。
 */

const ROUTES = Object.freeze({
  'a/saitama-shibakawa': route_('LINE_SECRET_A_SAITAMA_SHIBAKAWA', 'A', '01_さいたま芝川', 'さいたま市立芝川小学校体育館'),
  'a/sugishita': route_('LINE_SECRET_A_SUGISHITA', 'A', '02_杉下', '杉下小学校体育館'),
  'a/mizuhodai': route_('LINE_SECRET_A_MIZUHODAI', 'A', '03_みずほ台', 'みずほ台小学校体育館'),
  'a/kamekubo': route_('LINE_SECRET_A_KAMEKUBO', 'A', '04_亀久保', '亀久保小学校体育館'),
  'a/ageo-fujimi': route_('LINE_SECRET_A_AGEO_FUJIMI', 'A', '05_上尾富士見', '上尾市立富士見小学校体育館', '前半'),
  'a/ageo-shibakawa': route_('LINE_SECRET_A_AGEO_SHIBAKAWA', 'A', '06_上尾芝川', '上尾市立芝川小学校体育館'),
  'a/kasumigaseki-nishi': route_('LINE_SECRET_A_KASUMIGASEKI_NISHI', 'A', '07_霞ヶ関西', '霞ヶ関西小学校体育館'),

  'b/tsuruse': route_('LINE_SECRET_B_TSURUSE', 'B', '鶴瀬', '鶴瀬小学校体育館'),
  'b/meiho': route_('LINE_SECRET_B_MEIHO', 'B', '明峰', '明峰小学校体育館'),
  'b/omiya-higashi': route_('LINE_SECRET_B_OMIYA_HIGASHI', 'B', '大宮東', '大宮東小学校体育館'),
  'b/tsurugashima-daiichi': route_('LINE_SECRET_B_TSURUGASHIMA_DAIICHI', 'B', '鶴ヶ島第一', '鶴ヶ島第一小学校体育館'),
  'b/okegawa-nishi': route_('LINE_SECRET_B_OKEGAWA_NISHI', 'B', '桶川西', '桶川西小学校体育館'),
  'b/kitamoto-higashi': route_('LINE_SECRET_B_KITAMOTO_HIGASHI', 'B', '北本東', '北本東小学校体育館'),
  'b/kamihira-kita': route_('LINE_SECRET_B_KAMIHIRA_KITA', 'B', '上平北', '上平北小学校体育館'),

  'c/katayanagi': route_('LINE_SECRET_C_KATAYANAGI', 'C', '片柳', '片柳小学校体育館'),
  'c/muneoka-daini': route_('LINE_SECRET_C_MUNEOKA_DAINI', 'C', '宗岡第二', '宗岡第二小学校体育館'),
  'c/kamine': route_('LINE_SECRET_C_KAMINE', 'C', '神根', '神根小学校体育館'),
  'c/kumagaya-nishi': route_('LINE_SECRET_C_KUMAGAYA_NISHI', 'C', '熊谷西', '熊谷西小学校体育館'),
  'c/gyoda-nishi': route_('LINE_SECRET_C_GYODA_NISHI', 'C', '行田西', '行田西小学校体育館'),
  'c/asaka-dai10': route_('LINE_SECRET_C_ASAKA_DAI10', 'C', '朝霞第十', '朝霞第十小学校体育館'),
  'c/tokorozawa-minami': route_('LINE_SECRET_C_TOKOROZAWA_MINAMI', 'C', '所沢南', '所沢南小学校体育館'),
  'c/kurohama-minami': route_('LINE_SECRET_C_KUROHAMA_MINAMI', 'C', '黒浜南', '黒浜南小学校体育館'),

  'd/obukuro-higashi': route_('LINE_SECRET_D_OBUKURO_HIGASHI', 'D', '大袋東', '大袋東小学校体育館'),
  'd/shimooshi': route_('LINE_SECRET_D_SHIMOOSHI', 'D', '下忍', '下忍小学校体育館'),
  'd/izumi': route_('LINE_SECRET_D_IZUMI', 'D', '泉', '泉小学校体育館'),
  'd/yagisaki': route_('LINE_SECRET_D_YAGISAKI', 'D', '八木崎', '八木崎小学校体育館'),
  'd/nakano': route_('LINE_SECRET_D_NAKANO', 'D', '中野', '中野小学校体育館'),
  'd/ebinuma': route_('LINE_SECRET_D_EBINUMA', 'D', '海老沼', '海老沼小学校体育館'),
  'd/komatsu': route_('LINE_SECRET_D_KOMATSU', 'D', '幸松', '幸松小学校体育館'),
  'd/shima': route_('LINE_SECRET_D_SHIMA', 'D', '島', '島小学校体育館'),
});

const LINE_ID_TOKEN_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
// 活動申込は全会場共通URLで使います。GAS転送時だけ既存の有効ルートを内部利用します。
const ACTIVITY_GAS_ROUTE = 'a/saitama-shibakawa';
const ACTIVITY_LIFF_ID = '2011040394-O4z7w36C';
const WORKER_BUILD = '2026-08-12-reservation-stable2';
const WORKER_RELEASE = '2026-08-12-reservation-stable2';
const EXPECTED_GAS_BUILD = '2026-08-12-activity-stable2';
// 体験予約の公開情報（開催日・クラス・時間）だけをCloudflare側で短時間キャッシュします。
// LINE本人確認は予約保存時に必ず実施し、初期表示では外部のLINE検証APIを待たない設計です。
const RESERVATION_AVAILABILITY_EDGE_FRESH_MS = 180000;
const RESERVATION_AVAILABILITY_EDGE_STALE_MS = 3600000;
// GASのHTTP入口だけが一時失敗した場合に限り、同じCache API内の最終正常値を最大24時間まで退避利用します。
// 予約保存時はGASで日程・クラスを再検証するため、古い表示だけで予約が確定することはありません。
const RESERVATION_AVAILABILITY_EDGE_EMERGENCY_MS = 86400000;
const GRADES = Object.freeze([
  '年少', '年中', '年長', '1年生', '2年生', '3年生',
  '4年生', '5年生', '6年生',
]);
const CLASSES = Object.freeze(['前半', '後半', '相談したい']);
const CLASS_LABELS_BY_ROUTE = Object.freeze({
  'a/saitama-shibakawa': Object.freeze({
    '前半': '前半（18:15〜19:05）',
    '後半': '後半（19:15〜20:05）',
  }),
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = normalizePath_(url.pathname);

    if (request.method === 'GET' && (path === '' || path === 'health')) {
      return json_({
        ok: true,
        service: 'gymnastics and trampoline club reservation form',
        build: WORKER_BUILD,
        release: WORKER_RELEASE,
      }, 200);
    }

    if (request.method === 'GET' && path === 'health/gas') {
      return handleGasHealth_(env);
    }

    if (request.method === 'GET' && (path === 'reserve' || path.startsWith('reserve/'))) {
      if (!env.LIFF_ID) return json_({ ok: false, message: 'liff_not_configured' }, 503);
      return html_(buildReservationHtml_(env.LIFF_ID));
    }

    if (request.method === 'GET' && (path === 'apply' || path.startsWith('apply/'))) {
      return html_(buildActivityApplicationHtml_(ACTIVITY_LIFF_ID));
    }

    if (request.method === 'POST' && path === 'api/reservations/availability') {
      return handleReservationAvailability_(request, env, ctx);
    }

    if (request.method === 'POST' && path === 'api/reservations') {
      return handleReservationSubmit_(request, env);
    }

    if (request.method === 'POST' && path === 'api/activities/form') {
      return handleActivityForm_(request, env);
    }

    if (request.method === 'POST' && path === 'api/activity-applications') {
      return handleActivityApplicationSubmit_(request, env);
    }

    if (request.method === 'POST' && path.startsWith('line/')) {
      return handleLineWebhook_(request, env, path.slice('line/'.length));
    }

    return json_({ ok: false, message: 'not_found' }, 404);
  },
};

function route_(secretBinding, team, venue, publicVenue, fixedClass) {
  return Object.freeze({
    secretBinding: secretBinding,
    team: team,
    venue: venue,
    publicVenue: publicVenue,
    fixedClass: fixedClass || '',
  });
}

async function handleLineWebhook_(request, env, rawRoute) {
  const routeKey = normalizeRoute_(rawRoute);
  const route = ROUTES[routeKey];
  if (!route) return json_({ ok: false, message: 'unknown_route' }, 404);

  // さいたま芝川は旧Secret名を残したまま段階移行できます。
  const channelSecret = env[route.secretBinding] ||
    (routeKey === 'a/saitama-shibakawa' ? env.LINE_CHANNEL_SECRET : '');
  if (!channelSecret || !env.GAS_WEBHOOK_URL || !env.GAS_FORWARD_KEY) {
    return json_({ ok: false, message: 'gateway_not_configured' }, 503);
  }

  const signature = request.headers.get('x-line-signature') || '';
  const body = await request.text();
  const valid = await verifyLineSignature_(body, signature, channelSecret);
  if (!valid) return json_({ ok: false, message: 'invalid_signature' }, 401);

  try {
    const result = await forwardToGas_(env, routeKey, body);
    if (result && result.ok === false) {
      return json_({ ok: false, message: 'gas_rejected' }, 502);
    }
    return json_({ ok: true }, 200);
  } catch (error) {
    return json_({ ok: false, message: 'gas_unreachable' }, 502);
  }
}

function reservationAvailabilityCacheKey_(request, routeKey) {
  const url = new URL(request.url);
  url.pathname = '/__prospect_cache__/reservation-availability';
  url.search = 'route=' + encodeURIComponent(routeKey);
  return new Request(url.toString(), { method: 'GET' });
}

function reservationAvailabilityResponse_(payload, cachedAt) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 3分を超えたら更新し、通常は1時間まで利用します。1〜24時間は通信障害時だけの退避値です。
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'x-prospect-cached-at': String(cachedAt || Date.now()),
    },
  });
}

async function loadReservationAvailabilityPayload_(env, routeKey, forceRefresh) {
  const requestBody = JSON.stringify({
    source: forceRefresh ? 'reservation_availability_refresh' : 'reservation_availability',
  });
  // 初期表示は専用の有限リトライを使います。GASの正常応答を待てる長さを確保しつつ、
  // 無限待機やブラウザ側からの多重送信を避けます。
  const result = forceRefresh
    ? await forwardToGas_(env, routeKey, requestBody)
    : await forwardAvailabilityToGas_(env, routeKey, requestBody);
  if (!result) throw new Error('gas_empty_response');
  if (result.ok === false) throw new Error(mapGasRejection_(result.message));
  if (!Array.isArray(result.dates)) throw new Error('gas_wrong_or_old_backend');
  // The legacy upstream fallback has no original generation timestamp. Only
  // this edge's bounded last-good entry may be used during an outage.
  if (result.fallback) throw new Error('availability_unverified_fallback');
  const dates = result.dates.map(function (item) {
    return {
      value: safeSingleLine_(item && item.value, 10),
      label: safeSingleLine_(item && item.label, 40),
    };
  }).filter(function (item) {
    return /^\d{4}-\d{2}-\d{2}$/.test(item.value) && item.label;
  }).slice(0, 15);
  if (!Array.isArray(result.classes) || !result.classes.length) throw new Error('availability_classes_missing');
  const rawClasses = result.classes;
  const classesByValue = {};
  rawClasses.forEach(function (item) {
    const value = safeSingleLine_(item && item.value, 20);
    const label = safeSingleLine_(item && item.label, 80) || value;
    const time = safeSingleLine_(item && item.time, 40);
    const status = safeSingleLine_(item && item.status, 20).toLowerCase();
    if (CLASSES.indexOf(value) !== -1 && ['open', 'waitlist', 'closed'].indexOf(status) !== -1) {
      if (classesByValue[value]) throw new Error('availability_classes_invalid');
      classesByValue[value] = { value: value, label: label, time: time, status: status };
    } else { throw new Error('availability_classes_invalid'); }
  });
  let classes = CLASSES.map(function (value) { return classesByValue[value]; }).filter(Boolean);
  const gasFixedClass = safeSingleLine_(result.fixedClass, 20);
  const fixedClass = CLASSES.indexOf(gasFixedClass) !== -1
    ? gasFixedClass
    : ROUTES[routeKey].fixedClass;
  if (fixedClass) {
    classes = classes.filter(function (item) { return item.value === fixedClass; });
    if (!classes.length) throw new Error('availability_fixed_class_missing');
  }
  return {
    ok: true,
    dates: dates,
    classes: classes,
    fixedClass: fixedClass || '',
    fallback: Boolean(result.fallback),
  };
}

async function refreshReservationAvailabilityEdgeCache_(env, routeKey, cacheKey) {
  try {
    // Edge拠点ごとの更新が同時発生しても、GASの5分キャッシュを迂回してSpreadsheetへ集中しないようにします。
    const payload = await loadReservationAvailabilityPayload_(env, routeKey, false);
    if (payload.fallback) return; // Never renew the age of an upstream fallback.
    const response = reservationAvailabilityResponse_(payload, Date.now());
    if (typeof caches !== 'undefined' && caches.default) {
      await caches.default.put(cacheKey, response.clone());
    }
  } catch (error) {
    console.error('Reservation availability background refresh failed', String(error && error.message || error));
  }
}

async function handleReservationAvailability_(request, env, ctx) {
  try {
    const body = await readJsonBody_(request);
    const routeKey = requireRoute_(body.route);

    // 開催日・クラス・表示時間は個人情報ではないため、初期表示ではLINE IDトークン検証を待ちません。
    // 本人確認は /api/reservations の保存時に必ず実施します。
    const cacheAvailable = typeof caches !== 'undefined' && Boolean(caches.default);
    const cacheKey = reservationAvailabilityCacheKey_(request, routeKey);
    let emergencyCached = null;
    if (cacheAvailable) {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const cachedAt = Number(cached.headers.get('x-prospect-cached-at') || 0);
        const age = cachedAt > 0 && cachedAt <= Date.now() ? Date.now() - cachedAt : Number.MAX_SAFE_INTEGER;
        if (age <= RESERVATION_AVAILABILITY_EDGE_FRESH_MS) {
          return cached;
        }
        if (age <= RESERVATION_AVAILABILITY_EDGE_STALE_MS) {
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(refreshReservationAvailabilityEdgeCache_(env, routeKey, cacheKey));
          }
          return await emergencyReservationAvailabilityResponse_(cached);
        }
        if (age <= RESERVATION_AVAILABILITY_EDGE_EMERGENCY_MS) {
          emergencyCached = cached;
        }
      }
    }

    let payload;
    try {
      payload = await loadReservationAvailabilityPayload_(env, routeKey, false);
    } catch (error) {
      if (emergencyCached && isTransientAvailabilityError_(error)) {
        console.warn(JSON.stringify({
          event: 'reservation_availability_edge_fallback',
          route: routeKey,
          reason: String(error && error.message || error),
        }));
        return await emergencyReservationAvailabilityResponse_(emergencyCached);
      }
      throw error;
    }
    const response = reservationAvailabilityResponse_(payload, Date.now());
    if (cacheAvailable && !payload.fallback) {
      await caches.default.put(cacheKey, response.clone());
    }
    if (payload.fallback && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(refreshReservationAvailabilityEdgeCache_(env, routeKey, cacheKey));
    }
    return payload.fallback ? json_(payload, 200) : response;
  } catch (error) {
    return reservationError_(error);
  }
}

async function emergencyReservationAvailabilityResponse_(cached) {
  const payload = await cached.json();
  if (!payload || payload.ok !== true || !Array.isArray(payload.dates) || !Array.isArray(payload.classes) || !payload.classes.length) {
    throw new Error('gas_unreachable');
  }
  payload.fallback = true;
  payload.edgeFallback = true;
  return json_(payload, 200);
}

function isTransientAvailabilityError_(error) {
  const code = String(error && error.message || '').toLowerCase();
  return code === 'availability_unverified_fallback' ||
    code === 'gas_http_error' ||
    code.indexOf('gas_http_error_') === 0 ||
    code === 'gas_http_retryable' ||
    code === 'gas_timeout' ||
    code === 'gas_unreachable' ||
    code === 'gas_invalid_json' ||
    code === 'gas_empty_response' ||
    code === 'availability_temporarily_unavailable';
}

/**
 * CloudflareとGASの接続だけを確認する安全な診断口。
 * URL・共通キー・個人情報は返しません。
 */
async function handleGasHealth_(env) {
  try {
    const result = await forwardToGas_(
      env,
      'a/saitama-shibakawa',
      JSON.stringify({ source: 'reservation_diagnostics' })
    );
    if (!result) throw new Error('gas_empty_response');
    if (result.ok === false) throw new Error(mapGasRejection_(result.message));
    if (result.service !== 'gymnastics and trampoline club LINE intake' ||
        String(result.build || '') !== EXPECTED_GAS_BUILD) {
      throw new Error('gas_wrong_or_old_backend');
    }
    return json_({
      ok: true,
      workerBuild: WORKER_BUILD,
      gasService: result.service,
      gasBuild: result.build,
      gasRelease: result.release || '',
      authorization: result.authorization === 'ok' ? 'ok' : 'unknown',
      activityCalendar: result.activityCalendar === 'ok' ? 'ok' : 'unknown',
      availableDateCount: Number(result.availableDateCount || 0),
    }, 200);
  } catch (error) {
    return json_({
      ok: false,
      workerBuild: WORKER_BUILD,
      message: String(error && error.message || 'gas_diagnostics_failed'),
    }, 502);
  }
}

function mapGasRejection_(message) {
  const code = safeSingleLine_(message, 120).toLowerCase();
  if (code === 'unauthorized') return 'gas_forward_key_or_url_invalid';
  if (code === 'unknown_route') return 'gas_route_unknown';
  if (code.indexOf('availability_temporarily_unavailable') === 0) {
    return 'availability_temporarily_unavailable';
  }
  return 'gas_activity_calendar_error';
}

async function handleReservationSubmit_(request, env) {
  try {
    const body = await readJsonBody_(request);
    const routeKey = requireRoute_(body.route);
    const identity = await verifyLineIdToken_(body.idToken, env);
    const reservation = validateReservation_(body, routeKey);
    const result = await forwardToGas_(env, routeKey, JSON.stringify({
      source: 'reservation_form',
      requestId: reservation.requestId,
      lineUserId: identity.sub,
      lineDisplayName: safeSingleLine_(identity.name, 80),
      experienceDate: reservation.experienceDate,
      className: reservation.className,
      receptionType: reservation.receptionType,
      children: reservation.children,
      referrer: reservation.referrer,
      notes: reservation.notes,
    }), 2);
    if (!result) throw new Error('gas_empty_response');
    if (result.ok === false) throw new Error(mapGasReservationError_(result.message));
    return json_({
      ok: true,
      receiptId: safeSingleLine_(result.receiptId, 100),
      duplicate: Boolean(result.duplicate),
      childCount: reservation.children.length,
      receptionType: reservation.receptionType,
    }, 200);
  } catch (error) {
    return reservationError_(error);
  }
}

async function handleActivityForm_(request, env) {
  try {
    const body = await readJsonBody_(request);
    const routeKey = activityRoute_(body.route);
    const activityId = requireActivityId_(body.activityId);
    const identity = await verifyLineIdToken_(body.idToken, env);
    const result = await forwardToGas_(env, routeKey, JSON.stringify({
      source: 'activity_form',
      activityId: activityId,
      lineUserId: identity.sub,
      lineDisplayName: safeSingleLine_(identity.name, 80),
    }));
    if (!result) throw new Error('gas_empty_response');
    if (result.ok === false) throw new Error(mapGasActivityError_(result.message));
    const rawActivity = result.activity || {};
    const activity = {
      id: requireActivityId_(rawActivity.id),
      type: safeSingleLine_(rawActivity.type, 40),
      name: safeSingleLine_(rawActivity.name, 120),
      startDate: safeSingleLine_(rawActivity.startDate, 40),
      endDate: safeSingleLine_(rawActivity.endDate, 40),
      venue: safeSingleLine_(rawActivity.venue, 160),
      targetTeams: safeStringArray_(rawActivity.targetTeams, 10, 10),
      fee: safeSingleLine_(rawActivity.fee, 80),
      feeLabel: safeSingleLine_(rawActivity.feeLabel || rawActivity.fee, 80),
      publicState: safeSingleLine_(rawActivity.publicState, 20),
      open: Boolean(rawActivity.open),
      state: safeSingleLine_(rawActivity.state, 30),
      openAt: safeSingleLine_(rawActivity.openAt, 40),
      closeAt: safeSingleLine_(rawActivity.closeAt, 40),
      maxParticipants: Math.max(1, Math.min(6, Number(rawActivity.maxParticipants) || 1)),
      capacity: Math.max(0, Number(rawActivity.capacity) || 0),
      fullAction: safeSingleLine_(rawActivity.fullAction, 30),
      manualEntryAllowed: Boolean(rawActivity.manualEntryAllowed),
      participantTypes: safeStringArray_(rawActivity.participantTypes, 30, 120),
      selectionMode: safeSingleLine_(rawActivity.selectionMode, 30) === '複数選択可'
        ? '複数選択可'
        : '1枠選択',
      slots: sanitizeActivitySlots_(rawActivity.slots),
      consent: safeMultiline_(rawActivity.consent, 1000),
      completionMessage: safeMultiline_(rawActivity.completionMessage, 1000),
      receiptTitle: safeSingleLine_(rawActivity.receiptTitle, 120),
      afterMessage: safeMultiline_(rawActivity.afterMessage, 1000),
    };
    if (!activity.name) throw new Error('gas_wrong_or_old_backend');
    const participants = (Array.isArray(result.participants) ? result.participants : []).map(function (item) {
      return {
        personId: safeSingleLine_(item && item.personId, 60),
        memberId: safeSingleLine_(item && item.memberId, 60),
        name: safeSingleLine_(item && item.name, 80),
        kana: safeSingleLine_(item && item.kana, 80),
        grade: safeSingleLine_(item && item.grade, 20),
        team: safeSingleLine_(item && item.team, 10),
        venue: safeSingleLine_(item && item.venue, 80),
        status: safeSingleLine_(item && item.status, 20),
      };
    }).filter(function (item) {
      return /^PERS-[A-Za-z0-9-]+$/i.test(item.personId) && item.name;
    }).slice(0, 12);
    const questions = sanitizeActivityQuestions_(result.questions);
    return json_({ ok: true, activity: activity, participants: participants, questions: questions }, 200);
  } catch (error) {
    return activityError_(error);
  }
}

async function handleActivityApplicationSubmit_(request, env) {
  try {
    const body = await readJsonBody_(request);
    const routeKey = activityRoute_(body.route);
    const identity = await verifyLineIdToken_(body.idToken, env);
    const application = validateActivityApplication_(body);
    const result = await forwardToGas_(env, routeKey, JSON.stringify({
      source: 'activity_application',
      requestId: application.requestId,
      activityId: application.activityId,
      lineUserId: identity.sub,
      lineDisplayName: safeSingleLine_(identity.name, 80),
      participants: application.participants,
      slot: application.slotIds[0] || '',
      slotIds: application.slotIds,
      participantType: application.participantType,
      answers: application.answers,
      notes: application.notes,
      consent: application.consent,
    }));
    if (!result) throw new Error('gas_empty_response');
    if (result.ok === false) throw new Error(mapGasActivityError_(result.message));
    const applicants = (Array.isArray(result.applicants) ? result.applicants : []).map(function (item) {
      return {
        name: safeSingleLine_(item && item.name, 80),
        team: safeSingleLine_(item && item.team, 10),
        venue: safeSingleLine_(item && item.venue, 80),
        status: safeSingleLine_(item && item.status, 30),
        matchStatus: safeSingleLine_(item && item.matchStatus, 30),
      };
    }).filter(function (item) { return Boolean(item.name); }).slice(0, 6);
    const answerSummary = (Array.isArray(result.answerSummary) ? result.answerSummary : []).map(function (item) {
      return {
        key: safeSingleLine_(item && item.key, 40),
        label: safeSingleLine_(item && item.label, 120),
        value: safeMultiline_(item && item.value, 1000),
      };
    }).filter(function (item) { return item.label && item.value; }).slice(0, 20);
    const participants = (Array.isArray(result.participants) ? result.participants : []).map(function (item) {
      return {
        name: safeSingleLine_(item && item.name, 80),
        grade: safeSingleLine_(item && item.grade, 20),
        team: safeSingleLine_(item && item.team, 10),
        venue: safeSingleLine_(item && item.venue, 80),
      };
    }).filter(function (item) { return Boolean(item.name); }).slice(0, 6);
    const slots = sanitizeActivityReceiptSlots_(result.slots);
    return json_({
      ok: true,
      receiptId: safeSingleLine_(result.receiptId, 100),
      duplicate: Boolean(result.duplicate),
      activityId: safeSingleLine_(result.activityId, 80),
      activityName: safeSingleLine_(result.activityName, 120),
      activityType: safeSingleLine_(result.activityType, 40),
      receiptTitle: safeSingleLine_(result.receiptTitle, 120),
      completionMessage: safeMultiline_(result.completionMessage, 1000),
      afterMessage: safeMultiline_(result.afterMessage, 1000),
      applicants: applicants,
      participants: participants,
      slots: slots,
      slot: safeSingleLine_(result.slot, 120),
      participantType: safeSingleLine_(result.participantType, 120),
      answerSummary: answerSummary,
      applicationStatus: safeSingleLine_(result.applicationStatus, 30),
    }, 200);
  } catch (error) {
    return activityError_(error);
  }
}

function validateActivityApplication_(body) {
  const requestId = safeSingleLine_(body.requestId, 80);
  const activityId = requireActivityId_(body.activityId);
  if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw new Error('application_request_id_invalid');
  const rawParticipants = Array.isArray(body.participants) ? body.participants : [];
  if (!rawParticipants.length || rawParticipants.length > 6) throw new Error('participants_invalid');
  const participants = rawParticipants.map(function (item) {
    const personId = safeSingleLine_(item && item.personId, 60);
    if (personId) {
      if (!/^PERS-[A-Za-z0-9-]+$/i.test(personId)) throw new Error('participant_person_id_invalid');
      return { personId: personId };
    }
    const participant = {
      name: safeSingleLine_(item && item.name, 60),
      kana: safeSingleLine_(item && item.kana, 60),
      birthDate: safeSingleLine_(item && item.birthDate, 10),
      grade: safeSingleLine_(item && item.grade, 20),
      team: safeSingleLine_(item && item.team, 10).toUpperCase(),
      venue: safeSingleLine_(item && item.venue, 80),
    };
    if (participant.name.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(participant.birthDate) ||
        ['A', 'B', 'C', 'D'].indexOf(participant.team) === -1 || !participant.venue) {
      throw new Error('manual_participant_invalid');
    }
    return participant;
  });
  const answers = {};
  const rawAnswers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
    ? body.answers
    : {};
  const keys = Object.keys(rawAnswers);
  if (keys.length > 20) throw new Error('answers_too_many');
  keys.forEach(function (key) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) throw new Error('answer_key_invalid');
    const raw = rawAnswers[key];
    answers[key] = Array.isArray(raw)
      ? raw.slice(0, 30).map(function (value) { return safeSingleLine_(value, 200); })
      : safeMultiline_(raw, 2000);
  });
  const rawSlotIds = Array.isArray(body.slotIds)
    ? body.slotIds
    : (body.slot ? [body.slot] : []);
  if (rawSlotIds.length > 30) throw new Error('activity_slot_invalid');
  const slotIds = rawSlotIds.map(function (value) {
    const id = safeSingleLine_(value, 80);
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(id)) throw new Error('activity_slot_invalid');
    return id;
  }).filter(function (value, index, values) {
    return values.indexOf(value) === index;
  });
  return {
    requestId: requestId,
    activityId: activityId,
    participants: participants,
    slot: slotIds.length ? slotIds[0] : '',
    slotIds: slotIds,
    participantType: safeSingleLine_(body.participantType, 120),
    answers: answers,
    notes: safeMultiline_(body.notes, 1000),
    consent: Boolean(body.consent),
  };
}

function requireActivityId_(value) {
  const id = safeSingleLine_(value, 80);
  if (!/^[A-Za-z0-9_.-]{3,80}$/.test(id)) throw new Error('activity_id_invalid');
  return id;
}

function safeStringArray_(value, maxItems, maxLength) {
  return (Array.isArray(value) ? value : []).slice(0, maxItems).map(function (item) {
    return safeSingleLine_(item, maxLength);
  }).filter(function (item, index, values) { return item && values.indexOf(item) === index; });
}

function sanitizeActivitySlots_(value) {
  const seen = {};
  return (Array.isArray(value) ? value : []).map(function (item) {
    const id = safeSingleLine_(item && item.id, 80);
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(id) || seen[id]) return null;
    seen[id] = true;
    const rawStatus = safeSingleLine_(item && item.receptionStatus, 20).toLowerCase();
    const receptionStatus = ['open', 'waitlist', 'closed'].indexOf(rawStatus) !== -1
      ? rawStatus
      : 'closed';
    const rawRemaining = item && item.remaining;
    return {
      id: id,
      date: safeSingleLine_(item && item.date, 20),
      venue: safeSingleLine_(item && item.venue, 120),
      time: safeSingleLine_(item && item.time, 80),
      capacity: Math.max(0, Number(item && item.capacity) || 0),
      fee: Math.max(0, Number(item && item.fee) || 0),
      applied: Math.max(0, Number(item && item.applied) || 0),
      remaining: rawRemaining === null || rawRemaining === undefined || rawRemaining === ''
        ? null
        : Math.max(0, Number(rawRemaining) || 0),
      receptionStatus: receptionStatus,
    };
  }).filter(Boolean).slice(0, 30);
}

function sanitizeActivityReceiptSlots_(value) {
  const seen = {};
  return (Array.isArray(value) ? value : []).map(function (item) {
    const id = safeSingleLine_(item && item.id, 80);
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(id) || seen[id]) return null;
    seen[id] = true;
    return {
      id: id,
      date: safeSingleLine_(item && item.date, 20),
      venue: safeSingleLine_(item && item.venue, 120),
      time: safeSingleLine_(item && item.time, 80),
      fee: Math.max(0, Number(item && item.fee) || 0),
    };
  }).filter(Boolean).slice(0, 30);
}

function sanitizeActivityQuestions_(value) {
  const allowed = ['text', 'textarea', 'select', 'radio', 'checkbox'];
  return (Array.isArray(value) ? value : []).map(function (item) {
    const type = safeSingleLine_(item && item.type, 20).toLowerCase();
    const key = safeSingleLine_(item && item.key, 40);
    if (allowed.indexOf(type) === -1 || !/^[A-Za-z0-9_.-]{1,40}$/.test(key)) return null;
    return {
      id: safeSingleLine_(item && item.id, 80),
      key: key,
      label: safeSingleLine_(item && item.label, 120),
      type: type,
      required: Boolean(item && item.required),
      options: safeStringArray_(item && item.options, 30, 200),
      maxLength: Math.max(1, Math.min(2000, Number(item && item.maxLength) || 200)),
      hint: safeSingleLine_(item && item.hint, 200),
      defaultValue: safeSingleLine_(item && item.defaultValue, 200),
    };
  }).filter(function (item) { return item && item.label; }).slice(0, 20);
}

function mapGasActivityError_(message) {
  const code = safeSingleLine_(message, 240).toLowerCase();
  if (code === 'unauthorized') return 'gas_forward_key_or_url_invalid';
  if (code === 'unknown_route') return 'gas_route_unknown';
  if (code.indexOf('activity_already_applied:') === 0) return code;
  const exact = [
    'activity_id_invalid', 'activity_not_found', 'activity_not_open', 'activity_not_open_yet',
    'activity_closed', 'activity_full', 'activity_slot_required', 'activity_slot_invalid',
    'activity_slot_closed', 'multiple_slots_not_allowed', 'activity_slots_invalid',
    'participant_type_invalid', 'activity_consent_required',
    'participants_invalid', 'participants_limit_exceeded', 'participant_not_linked',
    'participant_member_missing', 'participant_person_id_invalid', 'participant_duplicate',
    'participant_team_not_eligible', 'manual_participant_invalid', 'manual_entry_not_allowed',
    'application_request_id_invalid', 'answers_too_many', 'answer_key_invalid',
    'activity_application_busy', 'activity_application_incomplete',
  ];
  if (exact.indexOf(code) !== -1 || code.indexOf('required_answer_missing:') === 0 ||
      code.indexOf('answer_option_invalid:') === 0) return code;
  return mapGasReservationError_(code);
}

function activityError_(error) {
  const code = String(error && error.message || 'activity_application_error');
  const conflict = code === 'activity_full' || code === 'activity_not_open' ||
    code === 'activity_not_open_yet' || code === 'activity_closed' ||
    code === 'activity_slot_closed' ||
    code.indexOf('activity_already_applied:') === 0;
  const unauthorized = code === 'invalid_line_identity' || code === 'line_login_not_configured';
  const badRequest = code.indexOf('invalid') !== -1 || code.indexOf('required_') === 0 ||
    code.indexOf('answer_option_') === 0 || code.indexOf('participant_') === 0 ||
    code.indexOf('manual_') === 0 || code === 'participants_limit_exceeded' ||
    code === 'activity_consent_required' || code === 'activity_slot_required' ||
    code === 'multiple_slots_not_allowed';
  const status = unauthorized ? 401 : (conflict ? 409 : (badRequest ? 400 : 502));
  return json_({ ok: false, message: code }, status);
}

function validateReservation_(body, routeKey) {
  const requestId = safeSingleLine_(body.requestId, 80);
  const className = safeSingleLine_(body.className, 20);
  const receptionType = safeSingleLine_(body.receptionType, 20).toLowerCase();
  const experienceDate = safeSingleLine_(body.experienceDate, 10);
  const rawChildren = Array.isArray(body.children)
    ? body.children
    : [{ name: body.childName, kana: body.childKana, grade: body.grade }];
  if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw new Error('invalid_request_id');
  if (!ROUTES[routeKey]) throw new Error('invalid_route');
  if (!rawChildren.length || rawChildren.length > 6) throw new Error('invalid_children');
  const children = rawChildren.map(function (child) {
    const name = safeSingleLine_(child && child.name, 50);
    const kana = safeSingleLine_(child && child.kana, 50);
    const grade = safeSingleLine_(child && child.grade, 20);
    if (name.length < 2) throw new Error('invalid_child_name');
    if (GRADES.indexOf(grade) === -1) throw new Error('invalid_grade');
    return { name: name, kana: kana, grade: grade };
  });
  if (CLASSES.indexOf(className) === -1) throw new Error('invalid_class');
  if (ROUTES[routeKey].fixedClass && className !== ROUTES[routeKey].fixedClass) {
    throw new Error('invalid_class');
  }
  if (['reservation', 'waitlist'].indexOf(receptionType) === -1) {
    throw new Error('invalid_reception_type');
  }
  if (receptionType === 'reservation' && !isBookableDate_(experienceDate)) {
    throw new Error('invalid_experience_date');
  }
  if (receptionType === 'waitlist' && experienceDate) throw new Error('invalid_experience_date');
  return {
    requestId: requestId,
    children: children,
    className: className,
    experienceDate: experienceDate,
    receptionType: receptionType,
    referrer: safeSingleLine_(body.referrer, 80),
    notes: safeMultiline_(body.notes, 300),
  };
}

function isBookableDate_(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const selected = new Date(value + 'T00:00:00+09:00');
  if (Number.isNaN(selected.getTime())) return false;
  const today = new Date(jstDateString_() + 'T00:00:00+09:00');
  const days = Math.floor((selected.getTime() - today.getTime()) / 86400000);
  return days >= 0 && days <= 120;
}

function jstDateString_() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(function (part) { map[part.type] = part.value; });
  return map.year + '-' + map.month + '-' + map.day;
}

async function verifyLineIdToken_(idToken, env) {
  const token = String(idToken || '').trim();
  const clientId = String(env.LINE_LOGIN_CHANNEL_ID || '').trim();
  if (!token || !clientId) throw new Error('line_login_not_configured');
  let response = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetchWithTimeout_(LINE_ID_TOKEN_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: token, client_id: clientId }),
    }, 12000).catch(function () { return null; });
    if (response && (response.ok || !isRetryableHttpStatus_(response.status))) break;
    if (attempt < 2) await delay_(300 * (attempt + 1));
  }
  if (!response) throw new Error('line_identity_temporarily_unavailable');
  if (!response.ok) throw new Error('invalid_line_identity');
  const identity = await response.json();
  if (String(identity.aud || '') !== clientId || !/^U[0-9a-f]{32}$/i.test(String(identity.sub || ''))) {
    throw new Error('invalid_line_identity');
  }
  return identity;
}

/**
 * 初期表示専用のGAS転送。
 * 1回目を十分待ち、タイムアウトは最大2回、すぐ返るHTTPエラーは最大3回までに限定します。
 * ブラウザはこの1リクエストだけを待つため、同じ会場への多重アクセスを増やしません。
 */
async function forwardAvailabilityToGas_(env, routeKey, body) {
  if (!env.GAS_WEBHOOK_URL || !env.GAS_FORWARD_KEY) throw new Error('gas_not_configured');
  const forwardUrl = new URL(env.GAS_WEBHOOK_URL);
  forwardUrl.searchParams.set('key', env.GAS_FORWARD_KEY);
  forwardUrl.searchParams.set('route', routeKey);
  const timeouts = [30000, 18000, 12000];
  let lastError = new Error('gas_unreachable');
  let lastResult = null;
  let timeoutCount = 0;

  for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
    try {
      const response = await fetchWithTimeout_(forwardUrl.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        redirect: 'follow',
      }, timeouts[attempt]);
      if (!response.ok) {
        lastError = gasHttpError_(response, 'reservation_availability', attempt + 1, true);
        // GAS本体の認証エラーはHTTP 200のJSONで返ります。GoogleのHTTP入口が返す
        // 403/405等も一時応答になり得るため、初期表示では有限回だけ再確認します。
        if (!isRetryableGasGatewayStatus_(response.status)) throw lastError;
      } else {
        const text = await response.text();
        try {
          lastResult = text ? JSON.parse(text) : { ok: true };
        } catch (parseError) {
          lastError = new Error('gas_invalid_json');
          lastResult = null;
        }
        if (lastResult && (lastResult.ok !== false || !isRetryableGasRejection_(lastResult.message))) {
          return lastResult;
        }
        if (lastResult) lastError = new Error(mapGasReservationError_(lastResult.message));
      }
    } catch (error) {
      const code = String(error && error.message || '');
      if (code === 'gas_not_configured' || code.indexOf('gas_http_error_') === 0) {
        lastError = error;
        if (code.indexOf('gas_http_error_') === 0 &&
            !isRetryableGasGatewayStatus_(error && error.upstreamStatus)) throw error;
      } else if (code === 'upstream_timeout') {
        timeoutCount += 1;
        lastError = new Error('gas_timeout');
        if (timeoutCount >= 2) break;
      } else {
        lastError = new Error(code || 'gas_unreachable');
      }
    }
    if (attempt + 1 < timeouts.length) await delay_(attempt === 0 ? 800 : 1500);
  }
  if (lastResult) return lastResult;
  throw lastError;
}

async function forwardToGas_(env, routeKey, body, maxAttempts) {
  if (!env.GAS_WEBHOOK_URL || !env.GAS_FORWARD_KEY) throw new Error('gas_not_configured');
  const forwardUrl = new URL(env.GAS_WEBHOOK_URL);
  forwardUrl.searchParams.set('key', env.GAS_FORWARD_KEY);
  forwardUrl.searchParams.set('route', routeKey);
  let lastError = new Error('gas_unreachable');
  let lastResult = null;
  const attemptLimit = Math.max(1, Math.min(3, Number(maxAttempts) || 3));
  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    try {
      const response = await fetchWithTimeout_(forwardUrl.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        redirect: 'follow',
      }, 25000);
      if (!response.ok) {
        lastError = gasHttpError_(response, 'gas_forward', attempt + 1, false);
      } else {
        const text = await response.text();
        try {
          lastResult = text ? JSON.parse(text) : { ok: true };
        } catch (parseError) {
          lastError = new Error('gas_invalid_json');
          lastResult = null;
        }
        if (lastResult && (lastResult.ok !== false || !isRetryableGasRejection_(lastResult.message))) {
          return lastResult;
        }
        if (lastResult) lastError = new Error(mapGasReservationError_(lastResult.message));
      }
    } catch (error) {
      const code = String(error && error.message || '');
      lastError = new Error(code === 'upstream_timeout' ? 'gas_timeout' : 'gas_unreachable');
    }
    if (attempt + 1 < attemptLimit) await delay_(500 * (attempt + 1));
  }
  if (lastResult) return lastResult;
  throw lastError;
}

function mapGasReservationError_(message) {
  const code = safeSingleLine_(message, 200).toLowerCase();
  if (code === 'unauthorized') return 'gas_forward_key_or_url_invalid';
  if (code === 'unknown_route') return 'gas_route_unknown';
  if (code === 'reservation_busy') return 'reservation_temporarily_busy';
  if (code === 'selected_date_unavailable') return 'selected_date_unavailable';
  if (code === 'class_status_changed') return 'class_status_changed';
  if (code === 'class_closed') return 'class_closed';
  if (code.indexOf('availability_temporarily_unavailable') === 0) {
    return 'availability_temporarily_unavailable';
  }
  if (code.indexOf('activity_') === 0 || code.indexOf('participant_') === 0 ||
      code.indexOf('manual_') === 0 || code.indexOf('application_') === 0 ||
      code.indexOf('required_answer_missing:') === 0 || code.indexOf('answer_option_invalid:') === 0 ||
      code.indexOf('answers_') === 0 || code.indexOf('answer_key_') === 0) {
    return code;
  }
  return 'reservation_save_failed';
}

function isRetryableGasRejection_(message) {
  const code = safeSingleLine_(message, 200).toLowerCase();
  const activityPermanent = [
    'activity_id_invalid', 'activity_not_found', 'activity_not_open', 'activity_full',
    'activity_slot_invalid', 'participant_type_invalid', 'activity_consent_required',
    'participants_invalid', 'participants_limit_exceeded', 'participant_not_linked',
    'participant_member_missing', 'participant_person_id_invalid', 'participant_duplicate',
    'participant_team_not_eligible', 'manual_participant_invalid', 'manual_entry_not_allowed',
    'application_request_id_invalid', 'answers_too_many', 'answer_key_invalid',
  ];
  if (activityPermanent.indexOf(code) !== -1 || code.indexOf('activity_already_applied:') === 0 ||
      code.indexOf('required_answer_missing:') === 0 || code.indexOf('answer_option_invalid:') === 0) {
    return false;
  }
  return code !== 'unauthorized' &&
    code !== 'unknown_route' &&
    code !== 'selected_date_unavailable' &&
    code !== 'class_status_changed' &&
    code !== 'class_closed' &&
    code.indexOf('受付idが不正') === -1 &&
    code.indexOf('lineユーザーidが不正') === -1 &&
    code.indexOf('学年が不正') === -1 &&
    code.indexOf('希望クラスが不正') === -1 &&
    code.indexOf('体験希望日が不正') === -1;
}

function isRetryableHttpStatus_(status) {
  return [408, 425, 429, 500, 502, 503, 504].indexOf(Number(status)) !== -1;
}

function isRetryableGasGatewayStatus_(status) {
  return isRetryableHttpStatus_(status) || [401, 403, 405, 409].indexOf(Number(status)) !== -1;
}

function gasHttpError_(response, operation, attempt, includeStatus) {
  const status = Math.max(0, Number(response && response.status) || 0);
  let finalHost = '';
  try {
    finalHost = response && response.url ? new URL(response.url).hostname : '';
  } catch (error) {
    finalHost = '';
  }
  console.error(JSON.stringify({
    event: 'gas_http_error',
    operation: operation,
    attempt: Number(attempt) || 1,
    status: status,
    retryable: isRetryableGasGatewayStatus_(status),
    finalHost: finalHost,
    contentType: safeSingleLine_(response && response.headers && response.headers.get('content-type'), 80),
    server: safeSingleLine_(response && response.headers && response.headers.get('server'), 40),
  }));
  const errorCode = includeStatus
    ? 'gas_http_error_' + String(status || 'unknown')
    : (isRetryableGasGatewayStatus_(status) ? 'gas_http_retryable' : 'gas_http_error');
  const error = new Error(errorCode);
  error.upstreamStatus = status;
  return error;
}

async function fetchWithTimeout_(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('upstream_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function delay_(milliseconds) {
  return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

async function readJsonBody_(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 32000) throw new Error('request_too_large');
  const text = await request.text();
  if (!text || text.length > 32000) throw new Error('invalid_request');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('invalid_json');
  }
}

function requireRoute_(value) {
  const routeKey = normalizeRoute_(value);
  if (!ROUTES[routeKey]) throw new Error('invalid_route');
  return routeKey;
}

function activityRoute_(value) {
  const routeKey = normalizeRoute_(value);
  return ROUTES[routeKey] ? routeKey : ACTIVITY_GAS_ROUTE;
}

function normalizePath_(value) {
  return String(value || '').toLowerCase().replace(/^\/+|\/+$/g, '');
}

function normalizeRoute_(value) {
  return normalizePath_(value).replace(/^line\//, '').replace(/^reserve\//, '');
}

async function verifyLineSignature_(body, signature, secret) {
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = bytesToBase64_(new Uint8Array(digest));
  return constantTimeEqual_(expected, signature);
}

function bytesToBase64_(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function safeSingleLine_(value, maxLength) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

function safeMultiline_(value, maxLength) {
  return String(value || '').replace(/\r/g, '').trim().slice(0, maxLength);
}

function reservationError_(error) {
  const code = String(error && error.message || 'reservation_error');
  const badRequestCodes = [
    'invalid_request_id', 'invalid_route', 'invalid_children', 'invalid_child_name', 'invalid_grade',
    'invalid_class', 'invalid_reception_type', 'invalid_experience_date', 'selected_date_unavailable',
    'request_too_large', 'invalid_request', 'invalid_json',
  ];
  const unauthorizedCodes = ['invalid_line_identity', 'line_login_not_configured'];
  const conflictCodes = ['class_status_changed', 'class_closed'];
  const status = badRequestCodes.indexOf(code) !== -1 ? 400 :
    (conflictCodes.indexOf(code) !== -1 ? 409 :
    (unauthorizedCodes.indexOf(code) !== -1 ? 401 : 502));
  return json_({ ok: false, message: code }, status);
}

function json_(value, status) {
  return new Response(JSON.stringify(value), {
    status: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function html_(content) {
  return new Response(content, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // HTML自体には個人情報を含めないため、短時間キャッシュして初期表示を安定化します。
      'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}

function buildReservationHtml_(liffId) {
  const publicRoutes = {};
  Object.keys(ROUTES).forEach(function (key) {
    publicRoutes[key] = { venue: ROUTES[key].publicVenue };
  });
  const config = JSON.stringify({
    liffId: String(liffId), routes: publicRoutes, grades: GRADES, classes: CLASSES,
    classLabelsByRoute: CLASS_LABELS_BY_ROUTE,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>体操&amp;トランポリンクラブ｜体験予約</title>
  <link rel="preconnect" href="https://static.line-scdn.net" crossorigin>
  <link rel="dns-prefetch" href="//static.line-scdn.net">
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    :root{color-scheme:light;--navy:#17324d;--blue:#1677ff;--pale:#eef5fb;--ink:#1d2733;--muted:#667383;--line:#d7e0e8;--danger:#bf2f38}
    *{box-sizing:border-box}body{margin:0;background:#f4f7fa;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif}
    main{max-width:620px;margin:0 auto;padding:20px 14px calc(38px + env(safe-area-inset-bottom))}
    .hero{background:linear-gradient(135deg,#17324d,#245a83);color:#fff;padding:22px 20px;border-radius:18px;box-shadow:0 10px 30px rgba(23,50,77,.18)}
    .hero small{opacity:.82}.hero h1{font-size:23px;margin:5px 0 8px}.hero p{font-size:14px;line-height:1.7;margin:0;opacity:.9}
    .card{background:#fff;margin-top:14px;border-radius:18px;padding:20px 16px;box-shadow:0 6px 24px rgba(25,45,65,.08)}
    .venue{display:flex;align-items:center;background:var(--pale);border-radius:12px;padding:13px;margin-bottom:18px}.venue strong{font-size:17px;line-height:1.5}
    .field{margin:0 0 16px}.field label{display:block;font-weight:700;font-size:14px;margin:0 0 7px}.required{color:var(--danger);font-size:11px;margin-left:5px}
    input,select,textarea{width:100%;font:inherit;font-size:16px;border:1px solid var(--line);border-radius:11px;background:#fff;padding:12px 12px;color:var(--ink);outline:none}input:focus,select:focus,textarea:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(22,119,255,.12)}textarea{min-height:86px;resize:vertical}
    .hint{font-size:12px;line-height:1.6;color:var(--muted);margin-top:5px}.fixed-class{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#f7f9fb;border:1px solid var(--line);border-radius:11px;padding:12px 13px;margin:0 0 16px}.fixed-class span{font-size:13px;color:var(--muted)}.fixed-class strong{font-size:16px;color:var(--navy)}.class-notice{font-size:13px;line-height:1.75;border-radius:11px;padding:12px;margin:-5px 0 16px}.waitlist-notice{background:#fff7e6;color:#7a4a00;border:1px solid #f2d29a}.hidden{display:none!important}
    button{width:100%;border:0;border-radius:13px;padding:14px 16px;font:inherit;font-weight:800;font-size:16px;cursor:pointer}.primary{background:var(--blue);color:#fff;box-shadow:0 7px 18px rgba(22,119,255,.24)}.primary:disabled{opacity:.5;box-shadow:none}.secondary{background:var(--pale);color:var(--navy);margin-top:10px}
    .children-title{font-size:15px;margin:3px 0 10px}.child-card{border:1px solid var(--line);border-radius:14px;padding:15px 13px;margin:0 0 12px;background:#fbfcfd}.child-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px}.child-head h3{font-size:15px;margin:0}.remove-child{width:auto;padding:7px 10px;border:1px solid #e5b7ba;background:#fff;color:#9b2f36;border-radius:9px;font-size:12px}.add-child{margin:0 0 18px;background:#fff;color:var(--blue);border:1px dashed var(--blue)}
    .status{padding:12px;border-radius:11px;margin:0 0 14px;font-size:13px;line-height:1.6;white-space:pre-line}.loading{background:#eef5fb;color:#335b7c}.error{background:#fff0f1;color:#8b2229}.success{background:#e9f8ef;color:#216c3d;text-align:center;padding:22px}.success h2{font-size:20px;margin:0 0 8px}
  </style>
</head>
<body>
<main>
  <section class="hero"><small>体操&amp;トランポリンクラブ</small><h1>体験予約</h1><p>選択式のフォームで、約1分で予約できます。</p></section>
  <section class="card" id="formCard">
    <div id="status" class="status loading">LINEと接続しています。<br>通常10秒ほどかかります。<br>画面を閉じずにそのままお待ちください。</div>
    <form id="reservationForm" class="hidden">
      <div class="venue"><strong id="venueName"></strong></div>
      <div id="classField" class="field"><label for="className">希望クラス<span class="required">必須</span></label><select id="className" name="className" required></select></div>
      <div id="fixedClassField" class="fixed-class hidden"><span>活動時間</span><strong id="fixedClassTime"></strong></div>
      <div id="classNotice" class="class-notice waitlist-notice hidden"></div>
      <div id="dateField" class="field hidden"><label for="experienceDate">体験希望日<span class="required">必須</span></label><select id="experienceDate" name="experienceDate"></select><div class="hint">体験活動日が決まり次第、順次追加されます。</div></div>
      <h2 class="children-title">体験するお子さま</h2>
      <div id="childrenArea"></div>
      <button id="addChildButton" class="add-child" type="button">＋ 兄弟・姉妹を追加する</button>
      <div class="field"><label for="referrer">紹介してくれた方</label><input id="referrer" name="referrer" maxlength="80" placeholder="知人・お友達のお名前（いなければ空欄）"></div>
      <div class="field"><label for="notes">相談・連絡事項</label><textarea id="notes" name="notes" maxlength="300" placeholder="体操経験や心配なことなど（任意）"></textarea></div>
      <button id="submitButton" class="primary" type="submit">この内容で予約する</button>
    </form>
    <div id="success" class="success hidden"><h2 id="successTitle">予約を受け付けました</h2><p id="chatStatus">担当スタッフが内容を確認後、こちらからLINEいたしますので、しばらくお待ちください。</p><button id="retryChatButton" class="primary hidden" type="button">LINEのトークへ送信する</button><button id="closeButton" class="secondary" type="button">閉じる</button></div>
  </section>
</main>
<script>
  const CONFIG=${config};
  const statusBox=document.getElementById('status');
  const form=document.getElementById('reservationForm');
  const submitButton=document.getElementById('submitButton');
  const classField=document.getElementById('classField');
  const classSelect=document.getElementById('className');
  const fixedClassField=document.getElementById('fixedClassField');
  const fixedClassTime=document.getElementById('fixedClassTime');
  const classNotice=document.getElementById('classNotice');
  const dateField=document.getElementById('dateField');
  const dateSelect=document.getElementById('experienceDate');
  const childrenArea=document.getElementById('childrenArea');
  const addChildButton=document.getElementById('addChildButton');
  const successTitle=document.getElementById('successTitle');
  const chatStatus=document.getElementById('chatStatus');
  const retryChatButton=document.getElementById('retryChatButton');
  const closeButton=document.getElementById('closeButton');
  const MAX_CHILDREN=6;
  let routeKey='';let idToken='';let lineReady=false;let pendingRequestId='';let pendingPayloadKey='';let pendingChatMessage='';let pendingReceptionType='reservation';let availableDates=[];let currentFixedClass='';

  function getRoute(){
    const direct=new URLSearchParams(location.search).get('route');
    if(direct&&CONFIG.routes[direct])return direct;
    const state=new URLSearchParams(location.search).get('liff.state');
    if(state){try{const decoded=decodeURIComponent(state);const q=decoded.indexOf('?')>=0?decoded.slice(decoded.indexOf('?')):decoded;const value=new URLSearchParams(q).get('route');if(value&&CONFIG.routes[value])return value;}catch(e){}}
    const prefix='/reserve/';const path=location.pathname.toLowerCase();const pathRoute=path.startsWith(prefix)?path.slice(prefix.length):'';return CONFIG.routes[pathRoute]?pathRoute:'';
  }
  function setStatus(message,type){statusBox.textContent=message;statusBox.className='status '+type;statusBox.classList.remove('hidden')}
  function clearProgressTimers(timers){while(timers.length)clearTimeout(timers.pop())}
  function startLineProgress(timers){clearProgressTimers(timers);setStatus('LINEと接続しています。\\n通常10秒ほどかかります。\\n画面を閉じずにそのままお待ちください。','loading');timers.push(setTimeout(()=>setStatus('LINEと会場情報を確認しています。\\n通常10秒ほどかかります。\\n画面を閉じずにそのままお待ちください。','loading'),4000));timers.push(setTimeout(()=>setStatus('LINEとの接続に時間がかかっています。\\n接続完了を待っていますので、そのままお待ちください。','loading'),15000))}
  function startAvailabilityProgress(timers){clearProgressTimers(timers);setStatus('LINEと会場情報を確認しています。\\n通常10秒ほどかかります。\\n画面を閉じずにそのままお待ちください。','loading');timers.push(setTimeout(()=>setStatus('通信に時間がかかっています。\\nそのまま接続完了を待っています…','loading'),12000));timers.push(setTimeout(()=>setStatus('通信に時間がかかっています。\\n自動でもう一度確認しています…','loading'),23000))}
  function withTimeout(promise,ms,label){let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label||'timeout')),ms)});return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer))}
  function isPermanentLiffInitError(error){return ['INVALID_CONFIG','UNAUTHORIZED','FORBIDDEN'].includes(String(error&&error.code||''))}
  async function initializeLiffWithRetry(){
    try{return await withTimeout(liff.init({liffId:CONFIG.liffId,withLoginOnExternalBrowser:true}),25000,'LIFF_INIT_TIMEOUT')}
    catch(error){
      if((error&&error.message)==='LIFF_INIT_TIMEOUT'||isPermanentLiffInitError(error))throw error;
      setStatus('LINEとの接続に時間がかかっています。\\n自動でもう一度確認しています…','loading');
      await wait(1000);
      return await withTimeout(liff.init({liffId:CONFIG.liffId,withLoginOnExternalBrowser:true}),20000,'LIFF_INIT_TIMEOUT');
    }
  }
  function liffErrorText(error){
    const code=error&&error.code?String(error.code):'';
    const message=error&&error.message?String(error.message):String(error||'unknown_error');
    const labels={gas_forward_key_or_url_invalid:'CloudflareのGAS_WEBHOOK_URLが予約受付GASではないか、共通キーが一致していません',gas_wrong_or_old_backend:'Cloudflareの接続先が予約受付GASではないか、GASが古いバージョンです',gas_invalid_json:'予約受付GASのWebアプリ公開設定または接続先URLを確認してください',gas_http_error:'予約受付GASへ接続できませんでした',gas_http_retryable:'予約受付GASが一時的に混み合っています',gas_timeout:'予約受付GASの応答が一時的に遅れています',gas_unreachable:'予約受付GASへ一時的に接続できませんでした',gas_not_configured:'CloudflareのGAS_WEBHOOK_URLまたはGAS_FORWARD_KEYが未設定です',gas_activity_calendar_error:'予約受付GASで体験活動日を読み取れませんでした',gas_route_unknown:'予約受付GASがこの会場を認識していません',gas_empty_response:'予約受付GASから応答がありませんでした',availability_temporarily_unavailable:'体験活動日の取得が一時的に混み合っています',reservation_temporarily_busy:'予約受付が一時的に混み合っています',selected_date_unavailable:'選択した体験活動日は現在受付できません',class_status_changed:'クラスの受付状況が変更されました',class_closed:'このクラスは現在受付を停止しています',line_identity_temporarily_unavailable:'LINEとの本人確認が一時的に混み合っています',LIFF_SDK_NOT_LOADED:'LINE接続用プログラムを読み込めませんでした',LIFF_INIT_TIMEOUT:'LINEとの接続完了を確認できませんでした',MISSING_ID_TOKEN:'LINEの本人確認情報を取得できませんでした',OPEN_FROM_OFFICIAL_ACCOUNT_CHAT:'LINE公式アカウントのトーク内から開いてください',CHAT_MESSAGE_SCOPE_NOT_CONFIGURED:'LINEトークへ控えを送る権限が設定されていません',CHAT_MESSAGE_PERMISSION_REQUIRED:'LINEトークへ控えを送る権限を許可してください',CHAT_MESSAGE_PERMISSION_TIMEOUT:'LINEトーク権限の確認に時間がかかっています',INVALID_ROUTE:'会場情報を確認できませんでした',request_timeout:'予約受付の応答を時間内に確認できませんでした'};
    const labelKey=message.startsWith('gas_http_error_')?'gas_http_error':message;const statusSuffix=message.startsWith('gas_http_error_')?'／HTTP '+message.slice('gas_http_error_'.length):'';const detail=labels[labelKey]?(labels[labelKey]+statusSuffix+'（'+message+'）'):message;
    return code?(code+' / '+detail):detail;
  }
  function option(value){const node=document.createElement('option');node.value=value;node.textContent=value;return node}
  function fillSelect(id,values,placeholder){const select=document.getElementById(id);select.textContent='';const first=option('');first.textContent=placeholder;select.appendChild(first);values.forEach(v=>select.appendChild(option(v)))}
  function fillSelectNode(select,values,placeholder){select.textContent='';const first=option('');first.textContent=placeholder;select.appendChild(first);values.forEach(v=>select.appendChild(option(v)))}
  function fillClassSelect(items){classSelect.textContent='';const first=option('');first.textContent='選択してください';classSelect.appendChild(first);const fallbackLabels=CONFIG.classLabelsByRoute[routeKey]||{};const source=Array.isArray(items)?items:[];source.forEach(item=>{if(!item||!CONFIG.classes.includes(item.value))return;const status=['open','waitlist','closed'].includes(item.status)?item.status:'closed';const node=option(item.value);node.dataset.status=status;node.dataset.time=item.time||'';node.dataset.label=item.label||fallbackLabels[item.value]||item.value;node.textContent=node.dataset.label+(status==='waitlist'?' ※キャンセル待ち':status==='closed'?' ※受付停止':'');if(status==='closed')node.disabled=true;classSelect.appendChild(node)})}
  function requestId(){if(crypto.randomUUID)return crypto.randomUUID();const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('')}
  function fillDateSelect(items){availableDates=Array.isArray(items)?items:[];dateSelect.textContent='';const first=option('');first.textContent=availableDates.length?'体験日を選択してください':'現在、受付可能な体験日はありません';dateSelect.appendChild(first);availableDates.forEach(item=>{const node=option(item.value);node.textContent=item.label;dateSelect.appendChild(node)})}
  function selectedClassStatus(){const selected=classSelect.selectedOptions[0];return selected&&selected.dataset.status?selected.dataset.status:''}
  function selectedClassDisplay(){const selected=classSelect.selectedOptions[0];return selected&&selected.dataset.label?selected.dataset.label:(selected?selected.textContent:classSelect.value)}
  function updateReceptionMode(){const status=selectedClassStatus();classNotice.classList.add('hidden');classNotice.textContent='';if(status==='waitlist'){dateField.classList.add('hidden');dateSelect.required=false;dateSelect.value='';classNotice.textContent='このクラスは現在、キャンセル待ちです。空きが出ましたら、キャンセル待ちの申込順にLINEでご案内します。空きが出るまでは体験には参加できません。お早めにお申し込みください。';classNotice.classList.remove('hidden');submitButton.textContent='キャンセル待ちに申し込む';return}if(status==='open'){dateField.classList.remove('hidden');dateSelect.required=true;submitButton.textContent='この内容で予約する';if(!availableDates.length){classNotice.textContent='現在、受付可能な体験活動日はありません。体験活動日が決まり次第、順次追加されます。';classNotice.classList.remove('hidden')}return}dateField.classList.add('hidden');dateSelect.required=false;dateSelect.value='';submitButton.textContent='この内容で予約する'}
  function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
  function retryableStatus(status){return [0,408,425,429,500,502,503,504].includes(Number(status||0))}
  async function postJson(path,payload,options){
    const settings=options||{};const attempts=Math.max(1,Number(settings.attempts||1));const timeoutMs=Math.max(5000,Number(settings.timeoutMs||30000));let lastError=new Error('request_failed');
    for(let attempt=1;attempt<=attempts;attempt+=1){
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
        const data=await response.json().catch(()=>({ok:false,message:'invalid_response'}));
        if(response.ok&&data.ok)return data;
        const error=new Error(data.message||'request_failed');error.httpStatus=response.status;lastError=error;
        if(!retryableStatus(response.status))throw error;
      }catch(error){
        lastError=error&&error.name==='AbortError'?new Error('request_timeout'):error;
        const status=Number(lastError&&lastError.httpStatus||0);
        if(status&&!retryableStatus(status))throw lastError;
      }finally{clearTimeout(timer)}
      if(attempt<attempts){if(typeof settings.onRetry==='function')settings.onRetry(attempt,attempts,lastError);await wait(600*attempt)}
    }
    throw lastError;
  }
  function refreshChildHeaders(){const cards=Array.from(childrenArea.querySelectorAll('.child-card'));cards.forEach((card,index)=>{card.querySelector('h3').textContent='お子さま '+(index+1);card.querySelector('.remove-child').classList.toggle('hidden',cards.length===1)});addChildButton.classList.toggle('hidden',cards.length>=MAX_CHILDREN)}
  function addChild(){
    if(childrenArea.children.length>=MAX_CHILDREN)return;
    const card=document.createElement('section');card.className='child-card';
    card.innerHTML='<div class="child-head"><h3></h3><button class="remove-child" type="button">削除</button></div><div class="field"><label>お子さまの氏名<span class="required">必須</span></label><input class="child-name" autocomplete="name" maxlength="50" required></div><div class="field"><label>ふりがな</label><input class="child-kana" maxlength="50"></div><div class="field"><label>学年<span class="required">必須</span></label><select class="child-grade" required></select></div>';
    const grade=card.querySelector('.child-grade');
    fillSelectNode(grade,CONFIG.grades,'選択してください');
    card.querySelector('.remove-child').addEventListener('click',()=>{card.remove();refreshChildHeaders()});
    childrenArea.appendChild(card);refreshChildHeaders();
  }
  function collectChildren(){return Array.from(childrenArea.querySelectorAll('.child-card')).map(card=>({name:card.querySelector('.child-name').value,kana:card.querySelector('.child-kana').value,grade:card.querySelector('.child-grade').value}))}
  function buildReservationChatMessage(payload){
    const route=CONFIG.routes[routeKey];
    const selectedDate=document.getElementById('experienceDate').selectedOptions[0];
    const waitlist=payload.receptionType==='waitlist';
    const classLine=currentFixedClass?'活動時間：'+(fixedClassTime.textContent||selectedClassDisplay()):'希望クラス：'+selectedClassDisplay();
    const lines=waitlist?['【体験キャンセル待ちを申し込みました】','会場：'+route.venue,classLine,'空きが出ましたら、キャンセル待ちの申込順にご案内します。','空きが出るまでは体験には参加できません。','お子さま：']:['【体験予約を送信しました】','会場：'+route.venue,'体験希望日：'+(selectedDate?selectedDate.textContent:payload.experienceDate),classLine,'お子さま：'];
    payload.children.forEach(child=>lines.push('・'+child.name+(child.kana?'（'+child.kana+'）':'')+'／'+child.grade));
    if(payload.referrer)lines.push('紹介してくれた方：'+payload.referrer);
    if(payload.notes)lines.push('相談・連絡事項：'+payload.notes);
    return lines.join('\\n').slice(0,5000);
  }
  async function sendReservationToChat(message){
    const context=liff.getContext();
    if(!liff.isInClient()||!context||context.type!=='utou')throw new Error('OPEN_FROM_OFFICIAL_ACCOUNT_CHAT');
    const permission=await withTimeout(liff.permission.query('chat_message.write'),12000,'CHAT_MESSAGE_PERMISSION_TIMEOUT');
    if(!permission||permission.state!=='granted')throw new Error(permission&&permission.state==='unavailable'?'CHAT_MESSAGE_SCOPE_NOT_CONFIGURED':'CHAT_MESSAGE_PERMISSION_REQUIRED');
    await withTimeout(liff.sendMessages([{type:'text',text:message}]),15000,'CHAT_MESSAGE_SEND_TIMEOUT');
  }
  function successMessage(type){return type==='waitlist'?'空きが出ましたら、キャンセル待ちの申込順にLINEでご案内します。空きが出るまでは体験には参加できません。':'担当スタッフが内容を確認後、こちらからLINEいたしますので、しばらくお待ちください。'}
  function showReservationSuccess(data,chatSent,type){
    statusBox.classList.add('hidden');
    form.classList.add('hidden');
    document.getElementById('success').classList.remove('hidden');
    successTitle.textContent=type==='waitlist'?'キャンセル待ちを受け付けました':'予約を受け付けました';
    if(chatSent){
      chatStatus.textContent=successMessage(type);
      retryChatButton.classList.add('hidden');
      closeButton.classList.remove('hidden');
    }else{
      chatStatus.textContent=(type==='waitlist'?'キャンセル待ち申込':'予約')+'は受け付け済みです。LINEのトークへの送信だけ完了していません。下のボタンを押してください。';
      retryChatButton.classList.remove('hidden');
      closeButton.classList.add('hidden');
    }
  }
  function showForm(availability){const route=CONFIG.routes[routeKey];document.getElementById('venueName').textContent=route.venue;const classes=availability&&Array.isArray(availability.classes)?availability.classes:[];const selectable=classes.some(item=>item&&['open','waitlist'].includes(item.status));if(!selectable){form.classList.add('hidden');setStatus('現在、この会場の体験受付は停止しています。','error');return false}fillClassSelect(classes);currentFixedClass=availability&&CONFIG.classes.includes(availability.fixedClass)?availability.fixedClass:'';if(currentFixedClass){classSelect.value=currentFixedClass;const selected=classSelect.selectedOptions[0];classField.classList.add('hidden');classSelect.required=false;fixedClassTime.textContent=selected&&selected.dataset.time?selected.dataset.time:selectedClassDisplay();fixedClassField.classList.remove('hidden')}else{classField.classList.remove('hidden');classSelect.required=true;fixedClassField.classList.add('hidden');fixedClassTime.textContent=''}fillDateSelect(availability&&Array.isArray(availability.dates)?availability.dates:[]);if(!childrenArea.children.length)addChild();updateReceptionMode();statusBox.classList.add('hidden');form.classList.remove('hidden');if(!lineReady){submitButton.disabled=true;submitButton.textContent='LINE接続を確認しています…'}else{submitButton.disabled=false;updateReceptionMode()}return true}
  addChildButton.addEventListener('click',()=>addChild());
  classSelect.addEventListener('change',()=>updateReceptionMode());
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!form.reportValidity())return;
    idToken=liff.getIDToken()||idToken;
    const receptionType=selectedClassStatus()==='waitlist'?'waitlist':'reservation';
    const reservationData={route:routeKey,receptionType:receptionType,experienceDate:receptionType==='waitlist'?'':dateSelect.value,className:classSelect.value,children:collectChildren(),referrer:document.getElementById('referrer').value,notes:document.getElementById('notes').value};
    const payloadKey=JSON.stringify(reservationData);
    if(!pendingRequestId||pendingPayloadKey!==payloadKey){pendingRequestId=requestId();pendingPayloadKey=payloadKey}
    const payload=Object.assign({idToken:idToken,requestId:pendingRequestId},reservationData);
    pendingReceptionType=receptionType;submitButton.disabled=true;submitButton.textContent=receptionType==='waitlist'?'申し込んでいます…':'予約しています…';statusBox.classList.add('hidden');
    try{
      const data=await postJson('/api/reservations',payload,{attempts:1,timeoutMs:95000});
      pendingChatMessage=buildReservationChatMessage(payload);let chatSent=false;
      try{await sendReservationToChat(pendingChatMessage);chatSent=true}catch(chatError){console.error('Reservation chat message failed',chatError)}
      showReservationSuccess(data,chatSent,receptionType);
    }catch(e){
      console.error('Reservation submission failed',e);
      const code=e&&e.message?String(e.message):'';
      if(code==='class_status_changed'||code==='class_closed'){setStatus('クラスの受付状況が変更されました。画面を閉じて、もう一度「体験予約」を開いてください。\\n'+liffErrorText(e),'error');submitButton.disabled=true;return}
      setStatus('通信が安定せず、受付完了を確認できませんでした。入力内容は残っていますので、下のボタンをもう一度押してください。\\n確認用番号：FORM-'+pendingRequestId,'error');
      submitButton.disabled=false;submitButton.textContent=receptionType==='waitlist'?'同じ内容でもう一度確認する':'同じ内容でもう一度確認する';
    }
  });
  retryChatButton.addEventListener('click',async()=>{if(!pendingChatMessage)return;retryChatButton.disabled=true;retryChatButton.textContent='LINEへ送信しています…';try{await sendReservationToChat(pendingChatMessage);chatStatus.textContent=successMessage(pendingReceptionType);retryChatButton.classList.add('hidden');closeButton.classList.remove('hidden')}catch(e){chatStatus.textContent='LINEへの送信が完了していません。画面を閉じず、もう一度お試しください。';retryChatButton.disabled=false;retryChatButton.textContent='LINEのトークへ送信する'}});
  closeButton.addEventListener('click',()=>{if(window.liff&&liff.isInClient())liff.closeWindow();else location.href='about:blank'});
  (async()=>{
    const progressTimers=[];
    try{
      if(!window.liff)throw new Error('LIFF_SDK_NOT_LOADED');
      routeKey=getRoute();
      if(!routeKey)throw new Error('INVALID_ROUTE');

      // 安定性を優先し、LINE初期化・本人状態確認を完了してから会場情報を取得します。
      // フォームは両方が完了するまで表示しません。
      startLineProgress(progressTimers);
      await initializeLiffWithRetry();
      if(!liff.isLoggedIn()){
        clearProgressTimers(progressTimers);
        liff.login({redirectUri:location.href});
        return;
      }
      idToken=liff.getIDToken();
      if(!idToken)throw new Error('MISSING_ID_TOKEN');
      const context=liff.getContext();
      if(!liff.isInClient()||!context||context.type!=='utou')throw new Error('OPEN_FROM_OFFICIAL_ACCOUNT_CHAT');

      // 権限は初期表示時に確認します。LINE側の確認通信だけがタイムアウトした場合は
      // フォーム表示を妨げず、控え送信直前に必ず再確認します。
      let permission=null;
      try{
        permission=await withTimeout(liff.permission.query('chat_message.write'),12000,'CHAT_MESSAGE_PERMISSION_TIMEOUT');
      }catch(permissionError){
        console.warn('Initial chat_message.write check delayed',permissionError);
      }
      if(permission&&permission.state!=='granted'){
        throw new Error(permission.state==='unavailable'?'CHAT_MESSAGE_SCOPE_NOT_CONFIGURED':'CHAT_MESSAGE_PERMISSION_REQUIRED');
      }
      lineReady=true;

      startAvailabilityProgress(progressTimers);
      const availability=await postJson('/api/reservations/availability',{route:routeKey},{attempts:1,timeoutMs:55000});
      clearProgressTimers(progressTimers);
      if(!showForm(availability))return;
      submitButton.disabled=false;
      updateReceptionMode();
    }catch(e){
      clearProgressTimers(progressTimers);
      form.classList.add('hidden');
      const detail=liffErrorText(e);
      setStatus('予約画面を開けませんでした。\\nエラー：'+detail+'\\n画面を閉じて、LINEの「体験予約」をもう一度押してください。','error');
      console.error('LIFF initialization failed',e);
    }
  })();
</script>
</body>
</html>`;
}

function buildActivityApplicationHtml_(liffId) {
  const publicRoutes = {};
  Object.keys(ROUTES).forEach(function (key) {
    publicRoutes[key] = {
      team: ROUTES[key].team,
      venue: ROUTES[key].venue,
      publicVenue: ROUTES[key].publicVenue,
    };
  });
  const config = JSON.stringify({
    liffId: String(liffId),
    routes: publicRoutes,
    grades: GRADES,
    activityGasRoute: ACTIVITY_GAS_ROUTE,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>体操&amp;トランポリンクラブ｜イベント・大会申込</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    :root{color-scheme:light;--navy:#17324d;--blue:#1677ff;--pale:#eef5fb;--ink:#1d2733;--muted:#667383;--line:#d7e0e8;--danger:#b32933;--green:#207548;--amber:#8a5700}
    *{box-sizing:border-box}body{margin:0;background:#f4f7fa;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif}
    main{max-width:650px;margin:0 auto;padding:20px 14px calc(38px + env(safe-area-inset-bottom))}.hidden{display:none!important}
    .hero{background:linear-gradient(135deg,#17324d,#245a83);color:#fff;padding:22px 20px;border-radius:18px;box-shadow:0 10px 30px rgba(23,50,77,.18)}
    .hero small{opacity:.82}.hero h1{font-size:23px;margin:5px 0 8px}.hero p{font-size:14px;line-height:1.7;margin:0;opacity:.9}
    .card{background:#fff;margin-top:14px;border-radius:18px;padding:20px 16px;box-shadow:0 6px 24px rgba(25,45,65,.08)}
    .activity{background:var(--pale);border-radius:14px;padding:15px;margin-bottom:18px}.activity h2{font-size:19px;line-height:1.5;margin:0 0 8px;color:var(--navy)}.meta{font-size:13px;line-height:1.75;color:#405268}.meta div:empty{display:none}
    .section-title{font-size:16px;margin:20px 0 10px}.field{margin:0 0 16px}.field label,.label{display:block;font-weight:700;font-size:14px;margin:0 0 7px}.required{color:var(--danger);font-size:11px;margin-left:5px}
    input,select,textarea{width:100%;font:inherit;font-size:16px;border:1px solid var(--line);border-radius:11px;background:#fff;padding:12px;color:var(--ink);outline:none}input:focus,select:focus,textarea:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(22,119,255,.12)}textarea{min-height:90px;resize:vertical}
    .hint{font-size:12px;line-height:1.6;color:var(--muted);margin-top:5px}.notice{font-size:13px;line-height:1.7;padding:12px;border-radius:11px;margin:0 0 14px}.notice-info{background:#eef5fb;color:#335b7c}.notice-warn{background:#fff7e6;color:var(--amber)}
    .participant{display:flex;gap:11px;align-items:flex-start;border:1px solid var(--line);border-radius:13px;padding:13px;margin-bottom:10px;background:#fbfcfd}.participant input{width:22px;height:22px;margin:1px 0 0;flex:0 0 auto}.participant strong{display:block;font-size:15px}.participant span{display:block;font-size:12px;color:var(--muted);margin-top:3px;line-height:1.5}
    .manual-card{border:1px solid var(--line);border-radius:14px;padding:15px 13px;margin:0 0 12px;background:#fbfcfd}.manual-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.manual-head h3{font-size:15px;margin:0}.remove{width:auto;padding:7px 10px;border:1px solid #e5b7ba;background:#fff;color:#9b2f36;border-radius:9px;font-size:12px}
    .slot-options{display:grid;gap:10px}.slot-card{display:flex;gap:11px;align-items:flex-start;border:1px solid var(--line);border-radius:13px;padding:13px;background:#fff}.slot-card input{width:22px;height:22px;margin:1px 0 0;flex:0 0 auto}.slot-copy{min-width:0}.slot-copy strong{display:block;font-size:15px;line-height:1.5}.slot-copy span{display:block;font-size:12px;color:var(--muted);line-height:1.6;margin-top:3px}.slot-card.waitlist{border-color:#e2bd74;background:#fffaf0}.slot-card.closed{opacity:.58;background:#f2f4f6}.slot-status{font-weight:700;color:var(--amber)!important}
    .choice{display:flex;gap:9px;align-items:flex-start;margin:8px 0}.choice input{width:20px;height:20px;margin:1px 0 0}.choice label{font-size:14px;line-height:1.5}.question{margin-bottom:18px}.options{border:1px solid var(--line);border-radius:11px;padding:8px 12px;background:#fff}
    button{width:100%;border:0;border-radius:13px;padding:14px 16px;font:inherit;font-weight:800;font-size:16px;cursor:pointer}.primary{background:var(--blue);color:#fff;box-shadow:0 7px 18px rgba(22,119,255,.24)}.primary:disabled{opacity:.5;box-shadow:none}.secondary{background:var(--pale);color:var(--navy);margin-top:10px}.outline{background:#fff;color:var(--blue);border:1px dashed var(--blue);margin:0 0 18px}
    .status{padding:12px;border-radius:11px;margin:0 0 14px;font-size:13px;line-height:1.65;white-space:pre-line}.loading{background:#eef5fb;color:#335b7c}.error{background:#fff0f1;color:#8b2229}.success{background:#e9f8ef;color:var(--green);text-align:center;padding:22px}.success h2{font-size:20px;margin:0 0 8px}.success p{line-height:1.7}
  </style>
</head>
<body>
<main>
  <section class="hero"><small>体操&amp;トランポリンクラブ</small><h1>イベント・大会申込</h1><p>LINEの中で申込が完了し、申込内容をこのトークへ控えとして残します。</p></section>
  <section class="card" id="formCard">
    <div id="status" class="status loading">LINEと接続しています…</div>
    <form id="applicationForm" class="hidden">
      <div class="activity"><h2 id="activityName"></h2><div class="meta"><div id="activityType"></div><div id="activityDate"></div><div id="activityVenue"></div><div id="activityFee"></div></div></div>
      <h2 class="section-title">参加するお子さま</h2>
      <div id="linkedNotice" class="notice notice-info hidden">体験申込から入会情報まで確認できたお子さまです。参加する方を選択してください。</div>
      <div id="linkedArea"></div>
      <div id="manualNotice" class="notice notice-warn hidden">LINE IDがまだ会員情報と連携されていない場合は、氏名・生年月日・所属を入力して申込できます。人物IDは自動確定せず、確認対象として保存します。</div>
      <div id="manualArea"></div>
      <button id="addManualButton" class="outline hidden" type="button">＋ LINE未連携のお子さまを追加</button>
      <div id="slotField" class="field hidden"><div class="label">参加する開催枠<span class="required">必須</span></div><div id="slotOptions" class="slot-options"></div><div id="slotHint" class="hint"></div></div>
      <div id="participantTypeField" class="field hidden"><label for="participantType">参加区分<span class="required">必須</span></label><select id="participantType"></select></div>
      <div id="questionsArea"></div>
      <div class="field"><label for="notes">連絡事項</label><textarea id="notes" maxlength="1000" placeholder="スタッフへ伝えたいことがあれば入力してください（任意）"></textarea></div>
      <div id="consentArea" class="choice hidden"><input id="consent" type="checkbox"><label id="consentLabel" for="consent"></label></div>
      <button id="submitButton" class="primary" type="submit">この内容で申し込む</button>
    </form>
    <div id="success" class="success hidden"><h2 id="successTitle">申込を受け付けました</h2><p id="successMessage"></p><button id="retryChatButton" class="primary hidden" type="button">申込控えをLINEトークへ送信する</button><button id="closeButton" class="secondary" type="button">閉じる</button></div>
  </section>
</main>
<script>
  const CONFIG=${config};
  const statusBox=document.getElementById('status');
  const form=document.getElementById('applicationForm');
  const linkedArea=document.getElementById('linkedArea');
  const manualArea=document.getElementById('manualArea');
  const addManualButton=document.getElementById('addManualButton');
  const slotField=document.getElementById('slotField');
  const slotOptions=document.getElementById('slotOptions');
  const slotHint=document.getElementById('slotHint');
  const participantTypeField=document.getElementById('participantTypeField');
  const participantTypeSelect=document.getElementById('participantType');
  const questionsArea=document.getElementById('questionsArea');
  const consentArea=document.getElementById('consentArea');
  const consent=document.getElementById('consent');
  const consentLabel=document.getElementById('consentLabel');
  const submitButton=document.getElementById('submitButton');
  const retryChatButton=document.getElementById('retryChatButton');
  const closeButton=document.getElementById('closeButton');
  let routeKey='';let activityId='';let idToken='';let activityData=null;let questions=[];let linkedParticipants=[];let pendingRequestId='';let pendingPayloadKey='';let pendingChatMessage='';

  function setStatus(message,type){statusBox.textContent=message;statusBox.className='status '+type;statusBox.classList.remove('hidden')}
  function requestId(){if(crypto.randomUUID)return crypto.randomUUID();const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('')}
  function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
  function withTimeout(promise,ms,label){let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label||'timeout')),ms)});return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer))}
  function retryableStatus(status){return [0,408,425,429,500,502,503,504].includes(Number(status||0))}
  async function postJson(path,payload,options){
    const settings=options||{};const attempts=Math.max(1,Number(settings.attempts||1));const timeoutMs=Math.max(5000,Number(settings.timeoutMs||30000));let lastError=new Error('request_failed');
    for(let attempt=1;attempt<=attempts;attempt+=1){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);try{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});const data=await response.json().catch(()=>({ok:false,message:'invalid_response'}));if(response.ok&&data.ok)return data;const error=new Error(data.message||'request_failed');error.httpStatus=response.status;lastError=error;if(!retryableStatus(response.status))throw error}catch(error){lastError=error&&error.name==='AbortError'?new Error('request_timeout'):error;const status=Number(lastError&&lastError.httpStatus||0);if(status&&!retryableStatus(status))throw lastError}finally{clearTimeout(timer)}if(attempt<attempts){if(typeof settings.onRetry==='function')settings.onRetry(attempt,attempts,lastError);await wait(600*attempt)}}throw lastError
  }
  function getParam(name){
    const direct=new URLSearchParams(location.search).get(name);if(direct)return direct;
    const state=new URLSearchParams(location.search).get('liff.state');if(!state)return '';
    try{const decoded=decodeURIComponent(state);const query=decoded.indexOf('?')>=0?decoded.slice(decoded.indexOf('?')):decoded;return new URLSearchParams(query).get(name)||''}catch(e){return ''}
  }
  function option(value,label){const node=document.createElement('option');node.value=value;node.textContent=label||value;return node}
  function fillSelect(select,values,placeholder){select.textContent='';select.appendChild(option('',placeholder));values.forEach(value=>select.appendChild(option(value,value)))}
  function formatActivityDate(activity){const start=activity.startDate||'';const end=activity.endDate||'';if(start&&end&&start!==end)return '日程：'+start+'〜'+end;if(start)return '日程：'+start;return ''}
  function renderActivity(activity){document.getElementById('activityName').textContent=activity.name;document.getElementById('activityType').textContent=activity.type?'種別：'+activity.type:'';document.getElementById('activityDate').textContent=formatActivityDate(activity);document.getElementById('activityVenue').textContent=activity.venue?'会場：'+activity.venue:'';document.getElementById('activityFee').textContent=(activity.feeLabel||activity.fee)?'参加費：'+(activity.feeLabel||activity.fee):''}
  function formatSlotDate(value){const match=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return match?(Number(match[2])+'月'+Number(match[3])+'日'):String(value||'')}
  function formatSlotLine(slot){return [formatSlotDate(slot.date),slot.venue,slot.time].filter(Boolean).join('｜')}
  function renderSlots(slots,selectionMode){
    slotOptions.textContent='';const multiple=selectionMode==='複数選択可';let selectable=0;
    (slots||[]).forEach((slot,index)=>{const closed=slot.receptionStatus==='closed';if(!closed)selectable+=1;const wrapper=document.createElement('label');wrapper.className='slot-card '+(slot.receptionStatus||'closed');const input=document.createElement('input');input.type=multiple?'checkbox':'radio';input.name='activitySlot';input.value=slot.id;input.disabled=closed;input.dataset.index=String(index);const copy=document.createElement('div');copy.className='slot-copy';const title=document.createElement('strong');title.textContent=formatSlotLine(slot)||slot.id;const detail=document.createElement('span');const details=[];if(slot.fee)details.push('参加費 '+Number(slot.fee).toLocaleString('ja-JP')+'円');if(slot.capacity)details.push('定員 '+slot.capacity+'名');if(slot.remaining!==null&&slot.receptionStatus==='open')details.push('残り '+slot.remaining+'名');detail.textContent=details.join('／');copy.appendChild(title);if(detail.textContent)copy.appendChild(detail);if(slot.receptionStatus==='waitlist'){const badge=document.createElement('span');badge.className='slot-status';badge.textContent='キャンセル待ちで受付';copy.appendChild(badge)}else if(closed){const badge=document.createElement('span');badge.className='slot-status';badge.textContent='受付終了';copy.appendChild(badge)}wrapper.appendChild(input);wrapper.appendChild(copy);slotOptions.appendChild(wrapper)});
    slotHint.textContent=multiple?'上尾・志木の両方へ参加する場合は、2つとも選択できます。':'参加する開催枠を1つ選択してください。';
    const enabled=Array.from(slotOptions.querySelectorAll('input:not(:disabled)'));if(enabled.length===1)enabled[0].checked=true;slotField.classList.remove('hidden');return selectable>0
  }
  function selectedSlotIds(){return Array.from(slotOptions.querySelectorAll('input:checked:not(:disabled)')).map(node=>node.value)}
  function renderLinked(participants){linkedArea.textContent='';linkedParticipants=participants||[];document.getElementById('linkedNotice').classList.toggle('hidden',!linkedParticipants.length);linkedParticipants.forEach((item,index)=>{const wrapper=document.createElement('label');wrapper.className='participant';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='linked-check';checkbox.value=item.personId;checkbox.checked=linkedParticipants.length===1;checkbox.dataset.index=String(index);const text=document.createElement('div');const strong=document.createElement('strong');strong.textContent=item.name;const sub=document.createElement('span');sub.textContent=[item.team?' '+item.team+'チーム':'',item.venue,item.grade,item.status].filter(Boolean).join('／');text.appendChild(strong);text.appendChild(sub);wrapper.appendChild(checkbox);wrapper.appendChild(text);linkedArea.appendChild(wrapper)})}
  function venueOptions(){const seen={};return Object.keys(CONFIG.routes).map(key=>CONFIG.routes[key]).filter(item=>{const token=item.team+'|'+item.venue;if(seen[token])return false;seen[token]=true;return true})}
  function refreshManual(){const cards=Array.from(manualArea.querySelectorAll('.manual-card'));cards.forEach((card,index)=>{card.querySelector('h3').textContent='未連携のお子さま '+(index+1)});addManualButton.classList.toggle('hidden',!activityData||!activityData.manualEntryAllowed||cards.length>=activityData.maxParticipants);document.getElementById('manualNotice').classList.toggle('hidden',!activityData||!activityData.manualEntryAllowed)}
  function addManual(){
    if(!activityData||!activityData.manualEntryAllowed||manualArea.children.length>=activityData.maxParticipants)return;
    const card=document.createElement('section');card.className='manual-card';card.innerHTML='<div class="manual-head"><h3></h3><button class="remove" type="button">削除</button></div><div class="field"><label>氏名<span class="required">必須</span></label><input class="manual-name" maxlength="60" required></div><div class="field"><label>氏名カナ</label><input class="manual-kana" maxlength="60"></div><div class="field"><label>生年月日<span class="required">必須</span></label><input class="manual-birth" type="date" required></div><div class="field"><label>所属チーム・会場<span class="required">必須</span></label><select class="manual-venue" required></select></div><div class="field"><label>学年</label><select class="manual-grade"></select></div>';
    const venue=card.querySelector('.manual-venue');venue.appendChild(option('','選択してください'));venueOptions().forEach(item=>venue.appendChild(option(item.team+'|'+item.venue,item.team+'チーム｜'+item.publicVenue)));
    fillSelect(card.querySelector('.manual-grade'),CONFIG.grades,'選択してください');card.querySelector('.remove').addEventListener('click',()=>{card.remove();refreshManual()});manualArea.appendChild(card);refreshManual()
  }
  function collectParticipants(){
    const result=[];linkedArea.querySelectorAll('.linked-check:checked').forEach(node=>result.push({personId:node.value}));
    manualArea.querySelectorAll('.manual-card').forEach(card=>{const membership=card.querySelector('.manual-venue').value.split('|');result.push({name:card.querySelector('.manual-name').value,kana:card.querySelector('.manual-kana').value,birthDate:card.querySelector('.manual-birth').value,team:membership[0]||'',venue:membership.slice(1).join('|'),grade:card.querySelector('.manual-grade').value})});return result
  }
  function renderQuestions(items){questions=Array.isArray(items)?items:[];questionsArea.textContent='';questions.forEach(question=>{const wrap=document.createElement('section');wrap.className='question';const label=document.createElement('div');label.className='label';label.textContent=question.label;if(question.required){const required=document.createElement('span');required.className='required';required.textContent='必須';label.appendChild(required)}wrap.appendChild(label);let input;if(question.type==='text'||question.type==='textarea'){input=document.createElement(question.type==='textarea'?'textarea':'input');input.dataset.questionKey=question.key;input.maxLength=question.maxLength;input.value=question.defaultValue||'';if(question.required)input.required=true;wrap.appendChild(input)}else if(question.type==='select'){input=document.createElement('select');input.dataset.questionKey=question.key;fillSelect(input,question.options,'選択してください');if(question.defaultValue)input.value=question.defaultValue;if(question.required)input.required=true;wrap.appendChild(input)}else{const options=document.createElement('div');options.className='options';question.options.forEach(value=>{const line=document.createElement('div');line.className='choice';const choice=document.createElement('input');choice.type=question.type==='radio'?'radio':'checkbox';choice.name='q_'+question.key;choice.value=value;choice.dataset.questionKey=question.key;if(question.defaultValue&&question.defaultValue.split(/[／|]/).includes(value))choice.checked=true;const choiceLabel=document.createElement('label');choiceLabel.textContent=value;line.appendChild(choice);line.appendChild(choiceLabel);options.appendChild(line)});wrap.appendChild(options)}if(question.hint){const hint=document.createElement('div');hint.className='hint';hint.textContent=question.hint;wrap.appendChild(hint)}questionsArea.appendChild(wrap)})}
  function collectAnswers(){const answers={};questions.forEach(question=>{if(question.type==='checkbox'){answers[question.key]=Array.from(document.querySelectorAll('[data-question-key="'+question.key+'"]:checked')).map(node=>node.value)}else if(question.type==='radio'){const checked=document.querySelector('[data-question-key="'+question.key+'"]:checked');answers[question.key]=checked?checked.value:''}else{const node=document.querySelector('[data-question-key="'+question.key+'"]');answers[question.key]=node?node.value:''}});return answers}
  function showForm(data){activityData=data.activity;renderActivity(activityData);if(!activityData.open){const message=activityData.state==='before_open'&&activityData.openAt?'申込受付は'+activityData.openAt+'から開始します。':'現在、このイベント・大会の申込受付は停止しています。';setStatus(message,'error');return false}const participants=data.participants||[];if(!participants.length&&!activityData.manualEntryAllowed){setStatus('このLINEアカウントと申込対象会員の連携を確認できませんでした。スタッフへお問い合わせください。','error');return false}renderLinked(participants);if(activityData.manualEntryAllowed){addManualButton.classList.remove('hidden');if(!participants.length)addManual()}refreshManual();if(activityData.slots.length&&!renderSlots(activityData.slots,activityData.selectionMode)){setStatus('現在、選択できる開催枠がありません。','error');return false}if(activityData.participantTypes.length){fillSelect(participantTypeSelect,activityData.participantTypes,'選択してください');participantTypeSelect.required=true;participantTypeField.classList.remove('hidden')}renderQuestions(data.questions||[]);if(activityData.consent){consentLabel.textContent=activityData.consent;consent.required=true;consentArea.classList.remove('hidden')}statusBox.classList.add('hidden');form.classList.remove('hidden');return true}
  function readableError(error){const code=error&&error.message?String(error.message):'unknown_error';if(code.startsWith('activity_already_applied:'))return 'すでに申込済みです：'+code.split(':').slice(1).join(':');if(code.startsWith('required_answer_missing:'))return '必須の設問に回答してください。';if(code.startsWith('answer_option_invalid:'))return '設問の選択肢を選び直してください。';const labels={activity_not_found:'指定されたイベント・大会が見つかりません',activity_not_open:'現在は申込受付期間外です',activity_not_open_yet:'申込受付開始前です',activity_closed:'申込受付は終了しています',activity_full:'定員に達したため受付を終了しました',activity_slot_required:'参加する開催枠を選択してください',activity_slot_invalid:'開催枠を選び直してください',activity_slot_closed:'選択した開催枠の受付は終了しています',multiple_slots_not_allowed:'この募集では開催枠を1つだけ選択できます',participant_not_linked:'選択した会員のLINE連携を確認できませんでした。画面を閉じて開き直してください',manual_entry_not_allowed:'この募集はLINE ID連携済み会員のみ申込できます',manual_participant_invalid:'未連携のお子さまの氏名・生年月日・所属を確認してください',activity_consent_required:'同意事項を確認してください',participant_type_invalid:'参加区分を選び直してください',participants_limit_exceeded:'一度に申し込める人数を超えています',line_identity_temporarily_unavailable:'LINEとの本人確認が一時的に混み合っています',gas_unreachable:'申込受付へ一時的に接続できませんでした',gas_timeout:'申込受付の応答が一時的に遅れています',LIFF_SDK_NOT_LOADED:'LINE接続用プログラムを読み込めませんでした',LIFF_INIT_TIMEOUT:'LINEとの接続が時間内に完了しませんでした',MISSING_ID_TOKEN:'LINEの本人確認情報を取得できませんでした',OPEN_FROM_OFFICIAL_ACCOUNT_CHAT:'LINE公式アカウントのトーク内から開いてください',CHAT_MESSAGE_SCOPE_NOT_CONFIGURED:'申込控えをLINEへ送る権限が設定されていません',CHAT_MESSAGE_PERMISSION_REQUIRED:'申込控えをLINEへ送る権限を許可してください',INVALID_ACTIVITY:'申込URLのイベントIDが正しくありません'};return labels[code]||code}
  function buildReceipt(data,payload){const lines=[data.receiptTitle||'【イベント・大会申込を受け付けました】','活動名：'+data.activityName];if(data.applicationStatus==='キャンセル待ち')lines.push('受付状態：キャンセル待ち');lines.push('参加者：');const source=(data.participants&&data.participants.length)?data.participants:data.applicants;const seen={};(source||[]).forEach(item=>{const key=[item.name,item.team,item.venue].join('|');if(seen[key])return;seen[key]=true;lines.push('・'+item.name+'／'+[item.team?item.team+'チーム':'',item.venue].filter(Boolean).join('・'))});if(data.slots&&data.slots.length){lines.push('開催枠：');data.slots.forEach(slot=>lines.push('・'+formatSlotLine(slot)+(slot.fee?'／'+Number(slot.fee).toLocaleString('ja-JP')+'円':'')))}else if(data.slot){lines.push('開催枠：'+data.slot)}if(data.participantType)lines.push('参加区分：'+data.participantType);(data.answerSummary||[]).forEach(item=>lines.push(item.label+'：'+item.value));if(payload.notes)lines.push('連絡事項：'+payload.notes);lines.push('申込番号：'+data.receiptId);lines.push('※このメッセージが申込控えです。');return lines.join('\\n').slice(0,5000)}
  async function sendToChat(message){const context=liff.getContext();if(!liff.isInClient()||!context||context.type!=='utou')throw new Error('OPEN_FROM_OFFICIAL_ACCOUNT_CHAT');const permission=await liff.permission.query('chat_message.write');if(!permission||permission.state!=='granted')throw new Error('CHAT_MESSAGE_PERMISSION_REQUIRED');await withTimeout(liff.sendMessages([{type:'text',text:message}]),15000,'CHAT_MESSAGE_SEND_TIMEOUT')}
  function showSuccess(data,chatSent){statusBox.classList.add('hidden');form.classList.add('hidden');document.getElementById('success').classList.remove('hidden');document.getElementById('successTitle').textContent=data.applicationStatus==='キャンセル待ち'?'キャンセル待ちを受け付けました':'申込を受け付けました';document.getElementById('successMessage').textContent=chatSent?(data.completionMessage||'申込控えをLINEトークへ送信しました。'):('申込は保存済みです。申込控えのLINE送信だけ完了していません。下のボタンを押してください。');retryChatButton.classList.toggle('hidden',chatSent);closeButton.classList.toggle('hidden',!chatSent)}
  addManualButton.addEventListener('click',()=>addManual());
  form.addEventListener('submit',async event=>{event.preventDefault();if(!form.reportValidity())return;const participants=collectParticipants();if(!participants.length){setStatus('参加するお子さまを選択または入力してください。','error');return}if(participants.length>activityData.maxParticipants){setStatus('一度に申し込める人数は'+activityData.maxParticipants+'名までです。','error');return}const slotIds=selectedSlotIds();if(activityData.slots.length&&!slotIds.length){setStatus('参加する開催枠を選択してください。','error');return}if(activityData.selectionMode!=='複数選択可'&&slotIds.length>1){setStatus('参加する開催枠を1つだけ選択してください。','error');return}idToken=liff.getIDToken()||idToken;const formData={route:routeKey,activityId:activityId,participants:participants,slotIds:slotIds,participantType:participantTypeSelect.value,answers:collectAnswers(),notes:document.getElementById('notes').value,consent:consent.checked};const payloadKey=JSON.stringify(formData);if(!pendingRequestId||pendingPayloadKey!==payloadKey){pendingRequestId=requestId();pendingPayloadKey=payloadKey}const payload=Object.assign({idToken:idToken,requestId:pendingRequestId},formData);submitButton.disabled=true;submitButton.textContent='申し込んでいます…';statusBox.classList.add('hidden');try{const data=await postJson('/api/activity-applications',payload,{attempts:3,timeoutMs:70000,onRetry:(attempt,total)=>{setStatus('通信を再確認しています。入力内容はそのままです（'+attempt+'/'+(total-1)+'）','loading');submitButton.textContent='申込を確認しています…'}});pendingChatMessage=buildReceipt(data,payload);let chatSent=false;try{await sendToChat(pendingChatMessage);chatSent=true}catch(chatError){console.error('Activity receipt message failed',chatError)}showSuccess(data,chatSent)}catch(error){console.error('Activity application failed',error);setStatus(readableError(error),'error');submitButton.disabled=false;submitButton.textContent='同じ内容でもう一度確認する'}});
  retryChatButton.addEventListener('click',async()=>{if(!pendingChatMessage)return;retryChatButton.disabled=true;retryChatButton.textContent='LINEへ送信しています…';try{await sendToChat(pendingChatMessage);document.getElementById('successMessage').textContent='申込控えをLINEトークへ送信しました。';retryChatButton.classList.add('hidden');closeButton.classList.remove('hidden')}catch(error){document.getElementById('successMessage').textContent='申込は保存済みですが、控えの送信が完了していません。画面を閉じず、もう一度お試しください。';retryChatButton.disabled=false;retryChatButton.textContent='申込控えをLINEトークへ送信する'}});
  closeButton.addEventListener('click',()=>{if(window.liff&&liff.isInClient())liff.closeWindow();else location.href='about:blank'});
  (async()=>{try{if(!window.liff)throw new Error('LIFF_SDK_NOT_LOADED');await withTimeout(liff.init({liffId:CONFIG.liffId,withLoginOnExternalBrowser:true}),15000,'LIFF_INIT_TIMEOUT');routeKey=CONFIG.routes[getParam('route')]?getParam('route'):CONFIG.activityGasRoute;activityId=getParam('activity');if(!/^[A-Za-z0-9_.-]{3,80}$/.test(activityId))throw new Error('INVALID_ACTIVITY');if(!liff.isLoggedIn()){liff.login({redirectUri:location.href});return}idToken=liff.getIDToken();if(!idToken)throw new Error('MISSING_ID_TOKEN');const context=liff.getContext();if(!liff.isInClient()||!context||context.type!=='utou')throw new Error('OPEN_FROM_OFFICIAL_ACCOUNT_CHAT');const permission=await liff.permission.query('chat_message.write');if(!permission||permission.state!=='granted')throw new Error(permission&&permission.state==='unavailable'?'CHAT_MESSAGE_SCOPE_NOT_CONFIGURED':'CHAT_MESSAGE_PERMISSION_REQUIRED');setStatus('申込情報を読み込んでいます…','loading');const data=await postJson('/api/activities/form',{route:routeKey,activityId:activityId,idToken:idToken},{attempts:3,timeoutMs:50000});showForm(data)}catch(error){setStatus('申込画面を開けませんでした。\\n'+readableError(error)+'\\nLINE公式アカウントのトークから、申込ボタンをもう一度押してください。','error');console.error('Activity LIFF initialization failed',error)}})();
</script>
</body>
</html>`;
}
