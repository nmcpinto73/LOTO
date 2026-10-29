/* ============================================================================
   LoTo — camada de dados
   ----------------------------------------------------------------------------
   Dois modos, decididos por config.js:
     • NUVEM   -> Supabase (Postgres + login). Todos veem o mesmo histórico.
     • LOCAL   -> localStorage. Só neste telemóvel (comportamento antigo).

   Sem SDK: usa a API REST/GoTrue do Supabase por fetch, para a app continuar
   leve e a funcionar offline através do service worker.
   ============================================================================ */
(function (global) {
  'use strict';

  var CFG = global.LOTO_CONFIG || {};

  /* O campo Project URL deve ser apenas https://ID.supabase.co.
     Muita gente cola o endpoint REST (…/rest/v1/) que aparece no painel.
     Normalizamos aqui para que as duas formas funcionem. */
  function normalizarUrl(u) {
    var s = String(u || '').trim().replace(/^['"\s]+|['"\s]+$/g, '');
    for (var i = 0; i < 3; i++) {
      s = s.replace(/\/+$/, '');
      s = s.replace(/\/(rest|auth)\/v1$/i, '');
    }
    return s.replace(/\/+$/, '');
  }

  var URL_CRUA = String(CFG.supabaseUrl || '').trim();
  var URL_BASE = normalizarUrl(CFG.supabaseUrl);
  var URL_CORRIGIDO = !!(URL_CRUA && URL_CRUA !== URL_BASE);
  var KEY = CFG.supabaseAnonKey || '';
  var NUVEM = !!(URL_BASE && KEY);

  var K_SESSAO = 'loto.sessao.v1';
  var K_EQUIPA = 'loto.equipa.v1';
  var K_FILA = 'loto.fila.v1';
  var K_CACHE = 'loto.cache.v1';
  var K_FALHAS = 'loto.falhas.v1';

  /* ---------------- utilitários ---------------- */
  function read(k, def) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function online() { return navigator.onLine !== false; }

  /* ---------------- sessão / auth ---------------- */
  function sessao() { return read(K_SESSAO, null); }
  function guardarSessao(s) { write(K_SESSAO, s); }
  function user() { var s = sessao(); return s && s.user ? s.user : null; }

  /* Envolve fetch: "Failed to fetch" é erro de rede/CORS, nunca de credenciais.
     Aqui passa a indicar o URL exacto que não respondeu. */
  function pedido(url, init) {
    return fetch(url, init).catch(function (e) {
      var m = String((e && e.message) || e);
      if (/Failed to fetch|NetworkError|Load failed|fetch failed|Network request failed/i.test(m)) {
        var dica = 'A app não conseguiu contactar o servidor. O pedido nunca chegou ao Supabase. ' +
                   'Verifique o URL em config.js, se o projecto está activo e se a rede (Wi-Fi/VPN/firewall) ' +
                   'não bloqueia supabase.co.';
        var err = new Error('Rede: falhou a ligação a ' + url + '\n' + dica);
        err.rede = true;
        err.url = url;
        throw err;
      }
      throw e;
    });
  }

  function authFetch(path, body) {
    var url = URL_BASE + '/auth/v1/' + path;
    return pedido(url, {
      method: 'POST',
      headers: { 'apikey': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) { d = null; }
        if (!r.ok) {
          var msg = (d && (d.msg || d.error_description || d.message || d.error)) || 'Falha de autenticação.';
          if (/Invalid login credentials/i.test(msg)) msg = 'Email ou palavra-passe incorretos.';
          else if (/User already registered/i.test(msg)) msg = 'Este email já tem conta. Use “Entrar”.';
          else if (/Password should be at least/i.test(msg)) msg = 'A palavra-passe deve ter pelo menos 6 caracteres.';
          else if (/Signups not allowed|signups are disabled|signup is disabled/i.test(msg)) msg = 'O registo por email está desactivado no Supabase (Authentication → Providers → Email).';
          else if (/Email rate limit exceeded/i.test(msg)) msg = 'Demasiadas tentativas seguidas. Espere alguns minutos.';
          else if (/Unable to validate email|invalid format/i.test(msg)) msg = 'Email inválido para o Supabase.';
          var e2 = new Error(msg + ' [HTTP ' + r.status + ' em ' + url + ']');
          e2.http = r.status;
          throw e2;
        }
        return d;
      });
    });
  }

  function gravarTokens(d) {
    if (!d || !d.access_token) return null;
    var s = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + ((d.expires_in || 3600) * 1000) - 60000,
      user: d.user || (sessao() || {}).user
    };
    guardarSessao(s);
    return s;
  }

  function entrar(email, password) {
    return authFetch('token?grant_type=password', { email: email, password: password })
      .then(function (d) { var s = gravarTokens(d); return s; });
  }

  function registar(email, password) {
    return authFetch('signup', { email: email, password: password }).then(function (d) {
      if (d && d.access_token) { gravarTokens(d); return { confirmado: true }; }
      return { confirmado: false };
    });
  }

  function renovar() {
    var s = sessao();
    if (!s || !s.refresh_token) return Promise.reject(new Error('Sem sessão.'));
    return authFetch('token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      .then(function (d) { gravarTokens(d); return sessao(); });
  }

  function sair() {
    localStorage.removeItem(K_SESSAO);
    localStorage.removeItem(K_EQUIPA);
    localStorage.removeItem(K_CACHE);
  }

  /* ---------------- REST ---------------- */
  function rest(path, opts, tentativa) {
    opts = opts || {};
    tentativa = tentativa || 0;
    var s = sessao();
    if (!s) return Promise.reject(new Error('Sessão expirada. Volte a entrar.'));

    var cabeçalhos = {
      'apikey': KEY,
      'Authorization': 'Bearer ' + s.access_token,
      'Content-Type': 'application/json'
    };
    if (opts.prefer) cabeçalhos['Prefer'] = opts.prefer;

    return pedido(URL_BASE + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers: cabeçalhos,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) { d = null; }

        if (r.status === 401 && tentativa === 0) {
          return renovar().then(function () { return rest(path, opts, 1); });
        }
        if (!r.ok) {
          var msg = (d && (d.message || d.hint || d.error_description)) || ('Erro ' + r.status);
          msg = String(msg).replace(/^.*?exception\s*/i, '');
          throw new Error(msg);
        }
        return d;
      });
    });
  }

  /* ---------------- equipa ---------------- */
  function equipa() { return read(K_EQUIPA, null); }
  function guardarEquipa(e) { write(K_EQUIPA, e); }

  function criarEquipa(nome, codigo, membro, cadeados) {
    return rest('rpc/criar_equipa', {
      method: 'POST',
      body: { p_nome: nome, p_codigo: codigo, p_cadeados: cadeados || [], p_membro: membro || null }
    }).then(function (id) {
      var e = { id: id, nome: nome, codigo: String(codigo).toUpperCase(), papel: 'admin' };
      guardarEquipa(e);
      return e;
    });
  }

  function entrarEquipa(codigo, membro) {
    return rest('rpc/entrar_equipa', {
      method: 'POST',
      body: { p_codigo: codigo, p_membro: membro || null }
    }).then(function (id) {
      return rest('equipas?id=eq.' + id + '&select=id,nome,codigo').then(function (rows) {
        var r = (rows && rows[0]) || { id: id, nome: 'Equipa', codigo: codigo };
        var e = { id: r.id, nome: r.nome, codigo: r.codigo, papel: 'tecnico' };
        guardarEquipa(e);
        return e;
      });
    });
  }

  /* ---------------- fila offline ---------------- */
  function fila() { return read(K_FILA, []); }
  function guardarFila(f) { write(K_FILA, f); }
  function falhas() { return read(K_FALHAS, []); }

  /* ---------------- tempo real (WebSocket nativo) ----------------
     Protocolo Realtime do Supabase, falado directamente. Quando outro
     dispositivo grava, o servidor avisa e a UI recarrega sozinha.
     Se a publicação não estiver activa não chegam eventos: nesse caso
     a app continua a funcionar por pull periódico (ver index.html). */
  var ws = null, rtPing = null, rtRef = 1, rtEstado = 'desligado',
      rtTentativas = 0, rtReconectar = null, rtCallback = null, escritaPropria = 0;

  function estadoTempoReal() { return rtEstado; }
  function marcarEscritaPropria() { escritaPropria = Date.now(); }

  function desligarTempoReal() {
    rtEstado = 'desligado';
    if (rtReconectar) { clearTimeout(rtReconectar); rtReconectar = null; }
    if (rtPing) { clearInterval(rtPing); rtPing = null; }
    if (ws) {
      try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(); } catch (e) {}
      ws = null;
    }
  }

  function ligarTempoReal(aoMudar) {
    rtCallback = aoMudar || rtCallback;
    if (!NUVEM || typeof WebSocket === 'undefined') return;
    var s = sessao(), eq = equipa();
    if (!s || !s.access_token || !eq) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

    desligarTempoReal();
    rtEstado = 'a ligar';

    var base = URL_BASE.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    var url = base + '/realtime/v1/websocket?apikey=' + encodeURIComponent(KEY) + '&vsn=1.0.0';
    try { ws = new WebSocket(url); } catch (e) { rtEstado = 'desligado'; return; }

    ws.onopen = function () {
      rtTentativas = 0;
      rtEstado = 'ligado';
      var filtro = 'equipa_id=eq.' + eq.id;
      ws.send(JSON.stringify({
        topic: 'realtime:loto-' + eq.id,
        event: 'phx_join',
        join_ref: '1',
        ref: String(rtRef++),
        payload: {
          access_token: sessao() ? sessao().access_token : null,
          config: {
            postgres_changes: [
              { event: '*', schema: 'public', table: 'cadeados', filter: filtro },
              { event: '*', schema: 'public', table: 'eventos', filter: filtro }
            ]
          }
        }
      }));
      rtPing = setInterval(function () {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', ref: String(rtRef++), payload: {} }));
        }
      }, 25000);
    };

    ws.onmessage = function (m) {
      var d;
      try { d = JSON.parse(m.data); } catch (e) { return; }
      if (d.event === 'phx_reply' && d.payload && d.payload.status === 'error') { rtEstado = 'desligado'; return; }
      var alteracao = d.event === 'postgres_changes' ||
        (d.payload && d.payload.data && (d.payload.data.type || d.payload.data.table));
      if (!alteracao) return;
      if (Date.now() - escritaPropria < 2500) return;   // eco da nossa escrita
      if (rtCallback) rtCallback(d);
    };

    ws.onerror = function () { rtEstado = 'desligado'; };

    ws.onclose = function () {
      rtEstado = 'desligado';
      if (rtPing) { clearInterval(rtPing); rtPing = null; }
      ws = null;
      if (!online()) return;
      rtTentativas++;
      var espera = Math.min(30000, 1500 * Math.pow(2, Math.min(rtTentativas, 4)));
      rtReconectar = setTimeout(function () { ligarTempoReal(rtCallback); }, espera);
    };
  }

  function guardarFalhas(f) { write(K_FALHAS, f); }

  function aplicarLocal(locks, history, op) {
    if (op.tipo === 'Consignação') {
      for (var i = 0; i < locks.length; i++) {
        if (locks[i].id === op.codigo) {
          locks[i].estado = 'Em Uso';
          locks[i].equipamento = op.equipamento;
          locks[i].responsavel = op.responsavel;
          locks[i].dt = op.quando;
        }
      }
    } else {
      for (var j = 0; j < locks.length; j++) {
        if (locks[j].id === op.codigo) {
          locks[j].estado = 'Livre';
          locks[j].equipamento = '—';
          locks[j].responsavel = '—';
          locks[j].dt = op.quando;
        }
      }
    }
    history.unshift({
      dt: op.quando,
      dtTexto: fmt(op.quando),
      tipo: op.tipo,
      id: op.codigo,
      equipamento: op.tipo === 'Consignação' ? op.equipamento : op.equipamentoAnterior,
      responsavel: op.responsavel,
      status: op.tipo === 'Consignação' ? 'Em Bloqueio' : 'Livre',
      at: op.tipo === 'Consignação' ? op.at : '',
      quem: (user() && user().email) || '',
      pendente: op.pendente === true
    });
  }

  function fmt(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return p(d.getDate()) + '-' + p(d.getMonth() + 1) + '-' + d.getFullYear() +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------------- instantâneo (snapshot) ---------------- */
  function carregar() {
    var eq = equipa();
    if (!NUVEM || !eq) return Promise.reject(new Error('Sem equipa.'));

    return Promise.all([
      rest('cadeados?equipa_id=eq.' + eq.id + '&select=codigo,estado,equipamento,responsavel,atualizado_em&order=codigo.asc'),
      rest('eventos?equipa_id=eq.' + eq.id + '&select=codigo,tipo,equipamento,responsavel,status,autorizacao,criado_em,criado_por_nome&order=criado_em.desc&limit=400'),
      rest('membros?equipa_id=eq.' + eq.id + '&select=nome').catch(function () { return []; })
    ]).then(function (r) {
      var locks = (r[0] || []).map(function (c) {
        return {
          id: c.codigo, estado: c.estado, equipamento: c.equipamento,
          responsavel: c.responsavel, dt: c.atualizado_em
        };
      });
      var hist = (r[1] || []).map(function (e) {
        return {
          dt: e.criado_em, dtTexto: fmt(e.criado_em), tipo: e.tipo, id: e.codigo,
          equipamento: e.equipamento || '—', responsavel: e.responsavel || '—',
          status: e.status || '', at: e.autorizacao || '', quem: e.criado_por_nome || ''
        };
      });
      var nomes = (r[2] || []).map(function (m) { return m.nome; }).filter(Boolean);

      // aplica a fila local por cima (otimista)
      fila().forEach(function (op) { aplicarLocal(locks, hist, op); });

      var snap = { locks: locks, history: hist, users: nomes, equipa: eq };
      write(K_CACHE, snap);
      return snap;
    }).catch(function (err) {
      var c = read(K_CACHE, null);
      if (c) { c.offline = true; return c; }
      throw err;
    });
  }

  function cache() { return read(K_CACHE, null); }

  /* ---------------- operações ---------------- */
  function consignar(form) {
    var eq = equipa();
    var op = {
      cliente_id: uuid(),
      tipo: 'Consignação',
      codigo: String(form.id).trim(),
      equipamento: String(form.equipamento).trim(),
      responsavel: String(form.responsavel).trim(),
      at: String(form.at).trim(),
      quando: new Date().toISOString()
    };

    if (!online()) { enfileirar(op); return Promise.resolve({ ok: true, fila: true, op: op }); }

    return rest('rpc/loto_consignar', {
      method: 'POST',
      body: {
        p_equipa: eq.id, p_codigo: op.codigo, p_equipamento: op.equipamento,
        p_responsavel: op.responsavel, p_at: op.at,
        p_cliente_id: op.cliente_id, p_quando: op.quando
      }
    }).then(function () {
      marcarEscritaPropria();
      return { ok: true, op: op };
    }).catch(function (err) {
      // erro de rede -> fica em fila; erro de negócio -> devolve ao utilizador
      if (/Failed to fetch|NetworkError|Load failed|network/i.test(err.message)) {
        enfileirar(op);
        return { ok: true, fila: true, op: op };
      }
      throw err;
    });
  }

  function desconsignar(form, equipamentoAnterior) {
    var eq = equipa();
    var op = {
      cliente_id: uuid(),
      tipo: 'Desconsignação',
      codigo: String(form.id).trim(),
      equipamentoAnterior: equipamentoAnterior || '—',
      responsavel: String(form.responsavel).trim(),
      quando: new Date().toISOString()
    };

    if (!online()) { enfileirar(op); return Promise.resolve({ ok: true, fila: true, op: op }); }

    return rest('rpc/loto_desconsignar', {
      method: 'POST',
      body: {
        p_equipa: eq.id, p_codigo: op.codigo, p_responsavel: op.responsavel,
        p_cliente_id: op.cliente_id, p_quando: op.quando
      }
    }).then(function () {
      marcarEscritaPropria();
      return { ok: true, op: op };
    }).catch(function (err) {
      if (/Failed to fetch|NetworkError|Load failed|network/i.test(err.message)) {
        enfileirar(op);
        return { ok: true, fila: true, op: op };
      }
      throw err;
    });
  }

  function enfileirar(op) {
    var f = fila();
    op.pendente = true;
    f.push(op);
    guardarFila(f);
  }

  var aSincronizar = false;
  function sincronizar() {
    if (!NUVEM || aSincronizar || !online()) return Promise.resolve({ enviados: 0, pendentes: fila().length });
    var f = fila();
    if (!f.length) return Promise.resolve({ enviados: 0, pendentes: 0 });

    aSincronizar = true;
    var eq = equipa();
    var enviados = 0;
    var restantes = f.slice();
    var novasFalhas = falhas();

    function passo() {
      if (!restantes.length) return Promise.resolve();
      var op = restantes[0];
      var p = op.tipo === 'Consignação'
        ? rest('rpc/loto_consignar', {
            method: 'POST',
            body: {
              p_equipa: eq.id, p_codigo: op.codigo, p_equipamento: op.equipamento,
              p_responsavel: op.responsavel, p_at: op.at,
              p_cliente_id: op.cliente_id, p_quando: op.quando
            }
          })
        : rest('rpc/loto_desconsignar', {
            method: 'POST',
            body: {
              p_equipa: eq.id, p_codigo: op.codigo, p_responsavel: op.responsavel,
              p_cliente_id: op.cliente_id, p_quando: op.quando
            }
          });

      return p.then(function () {
        enviados++;
        restantes.shift();
        guardarFila(restantes.slice());
        return passo();
      }).catch(function (err) {
        if (/Failed to fetch|NetworkError|Load failed|network/i.test(err.message)) {
          return; // sem rede: tenta mais tarde, mantém a fila
        }
        // erro de negócio: registado em falhas, retirado da fila
        novasFalhas.unshift({
          quando: op.quando, tipo: op.tipo, codigo: op.codigo,
          motivo: err.message, lido: false
        });
        guardarFalhas(novasFalhas.slice(0, 40));
        restantes.shift();
        guardarFila(restantes.slice());
        return passo();
      });
    }

    return passo().then(function () {
      aSincronizar = false;
      return { enviados: enviados, pendentes: fila().length };
    }).catch(function () {
      aSincronizar = false;
      return { enviados: enviados, pendentes: fila().length };
    });
  }

  function limparFalhas() { write(K_FALHAS, []); }

  /* ---------------- cadeados ---------------- */
  function adicionarCadeado(id) {
    var eq = equipa();
    return rest('cadeados', {
      method: 'POST', prefer: 'return=minimal',
      body: { equipa_id: eq.id, codigo: String(id).trim() }
    });
  }
  function removerCadeado(id) {
    var eq = equipa();
    return rest('cadeados?equipa_id=eq.' + eq.id + '&codigo=eq.' + encodeURIComponent(String(id).trim()), {
      method: 'DELETE', prefer: 'return=minimal'
    });
  }

  /* ---------------- migração do modo local ---------------- */
  function migrarLocal(estadoLocal) {
    var eq = equipa();
    if (!eq || !estadoLocal) return Promise.resolve(0);
    var hist = (estadoLocal.history || []).slice().reverse();
    var i = 0, n = 0;

    function passo() {
      if (i >= hist.length) return Promise.resolve(n);
      var h = hist[i++];
      var op = {
        cliente_id: 'migr-' + uuid(),
        tipo: h.tipo,
        codigo: h.id,
        equipamento: h.equipamento,
        responsavel: h.responsavel,
        at: h.at,
        quando: h.dt
      };
      var p = h.tipo === 'Consignação'
        ? rest('rpc/loto_consignar', {
            method: 'POST',
            body: {
              p_equipa: eq.id, p_codigo: op.codigo, p_equipamento: op.equipamento,
              p_responsavel: op.responsavel, p_at: op.at || '—',
              p_cliente_id: op.cliente_id, p_quando: op.quando
            }
          })
        : rest('rpc/loto_desconsignar', {
            method: 'POST',
            body: {
              p_equipa: eq.id, p_codigo: op.codigo, p_responsavel: op.responsavel,
              p_cliente_id: op.cliente_id, p_quando: op.quando
            }
          });
      return p.then(function () { n++; return passo(); })
              .catch(function () { return passo(); });
    }
    return passo();
  }

  /* ---------------- diagnóstico da configuração ---------------- */
  function tipoChave(k) {
    if (!k) return 'vazia';
    if (/^sb_publishable_/.test(k)) return 'publishable';
    if (/^sb_secret_/.test(k)) return 'secret';
    if (/^eyJ/.test(k)) {
      try {
        var p = k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        var j = JSON.parse(atob(p + '==='.slice((p.length + 3) % 4)));
        if (j && j.role) return j.role;
      } catch (e) {}
      return 'jwt';
    }
    return 'desconhecida';
  }

  function validarConfig() {
    var itens = [];
    var u = String(CFG.supabaseUrl || '').trim();
    var k = String(CFG.supabaseAnonKey || '').trim();

    if (!u) itens.push({ n: 'URL do projecto', e: 'erro', d: 'config.js está vazio. Cole o Project URL do Supabase.' });
    else {
      if (/\s/.test(u)) itens.push({ n: 'URL do projecto', e: 'erro', d: 'Contém espaços ou mudança de linha. Apague tudo e cole só o URL.' });
      if (!/^https:\/\//i.test(u)) itens.push({ n: 'URL do projecto', e: 'erro', d: 'Tem de começar por https:// (se está http://, o browser bloqueia).' });
      if (/dashboard|supabase\.com\/project/i.test(u)) itens.push({ n: 'URL do projecto', e: 'erro', d: 'Isto é o endereço do painel, não a API. Tem de ser https://SEU-ID.supabase.co' });
      if (/\/(rest|auth)\/v1\/?$/i.test(u)) itens.push({ n: 'URL do projecto', e: 'aviso', d: 'Tinha /rest/v1 (ou /auth/v1) no fim. A app já removeu automaticamente — mas convém corrigir o config.js.' });
      if (/\/$/.test(u)) itens.push({ n: 'URL do projecto', e: 'aviso', d: 'Tem uma barra no fim. A app remove-a, mas convém limpar.' });
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u) && /^https:\/\//i.test(u) && !/\//.test(u.slice(8)))
        itens.push({ n: 'URL do projecto', e: 'aviso', d: 'Não tem o formato habitual ID.supabase.co. Confirme que copiou o Project URL.' });
      if (location.protocol === 'https:' && /^http:\/\//i.test(u)) itens.push({ n: 'Conteúdo misto', e: 'erro', d: 'Página em https a chamar http — o browser bloqueia antes de sair.' });
    }

    var t = tipoChave(k);
    if (!k) itens.push({ n: 'Chave pública', e: 'erro', d: 'config.js está vazio. Cole a chave anon public.' });
    else if (/service_role|^sb_secret_/.test(t)) itens.push({ n: 'Chave pública', e: 'erro', d: 'Essa é a chave secreta. NUNCA a use no browser — use a anon public.' });
    else if (t !== 'anon' && t !== 'publishable' && t !== 'jwt') itens.push({ n: 'Chave pública', e: 'aviso', d: 'Formato inesperado (tipo: ' + t + '). Confirme que copiou a chave anon public inteira.' });
    else itens.push({ n: 'Chave pública', e: 'ok', d: 'Formato aceite (' + t + ').' });

    if (/\s/.test(k)) itens.push({ n: 'Chave pública', e: 'erro', d: 'Contém espaços ou aspas. Cole só o valor entre as plicas.' });

    return itens;
  }

  function sonda(url, opts) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 9000);
    var init = opts || {};
    if (ctl) init.signal = ctl.signal;
    return fetch(url, init).then(function (r) {
      clearTimeout(t);
      return { ok: r.ok, status: r.status };
    }).catch(function (e) {
      clearTimeout(t);
      var m = String((e && e.message) || e);
      if (/abort/i.test(m)) return { ok: false, erro: 'sem resposta em 9 s (firewall/projecto em pausa?)' };
      return { ok: false, erro: m };
    });
  }

  function diagnostico() {
    var itens = validarConfig();
    var u = URL_BASE;
    var testes = [];

    if (!u) return Promise.resolve({ url: '', urlCrua: URL_CRUA, urlCorrigido: URL_CORRIGIDO, itens: itens, testes: testes, nuvem: NUVEM });

    return sonda(u + '/auth/v1/health', { headers: { 'apikey': KEY } })
      .then(function (r1) {
        testes.push({
          n: 'GET /auth/v1/health',
          e: r1.ok ? 'ok' : 'erro',
          d: r1.ok ? 'HTTP ' + r1.status + ' — servidor de autenticação a responder.'
                   : (r1.status ? 'HTTP ' + r1.status + ' — o endereço responde mas não é a API de autenticação.' : r1.erro)
        });
        return sonda(u + '/rest/v1/', { headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY } });
      })
      .then(function (r2) {
        testes.push({
          n: 'GET /rest/v1/',
          e: r2.ok ? 'ok' : 'erro',
          d: r2.ok ? 'HTTP ' + r2.status + ' — base de dados a responder.'
                   : (r2.status ? 'HTTP ' + r2.status + ' — projecto existe mas a chave pode estar errada/expirada.' : r2.erro)
        });

        var s = sessao();
        if (s && s.access_token) {
          return sonda(u + '/rest/v1/equipas?select=id&limit=1', {
            headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + s.access_token }
          }).then(function (r3) {
            testes.push({
              n: 'Tabelas (com sessão)',
              e: r3.ok ? 'ok' : 'erro',
              d: r3.ok ? 'HTTP ' + r3.status + ' — tabelas criadas e visíveis.'
                       : (r3.status === 404 ? 'HTTP 404 — o schema.sql ainda não foi executado no SQL Editor.'
                                            : (r3.status ? 'HTTP ' + r3.status + ' — verifique as políticas RLS.' : r3.erro))
            });
          });
        }
      })
      .then(function () {
        return { url: u, urlCrua: URL_CRUA, urlCorrigido: URL_CORRIGIDO, chave: tipoChave(KEY), itens: itens, testes: testes, nuvem: NUVEM };
      });
  }

  /* ---------------- exportação ---------------- */
  function api() {
    return {
      nuvem: NUVEM,
      urlBase: URL_BASE,
      user: user, sessao: sessao, equipa: equipa,
      entrar: entrar, registar: registar, sair: sair,
      criarEquipa: criarEquipa, entrarEquipa: entrarEquipa,
      carregar: carregar, cache: cache,
      consignar: consignar, desconsignar: desconsignar,
      sincronizar: sincronizar, fila: fila, falhas: falhas, limparFalhas: limparFalhas,
      adicionarCadeado: adicionarCadeado, removerCadeado: removerCadeado,
      migrarLocal: migrarLocal, online: online, fmt: fmt,
      ligarTempoReal: ligarTempoReal, desligarTempoReal: desligarTempoReal,
      estadoTempoReal: estadoTempoReal, marcarEscritaPropria: marcarEscritaPropria,
      diagnostico: diagnostico, validarConfig: validarConfig, tipoChave: tipoChave,
      url: URL_BASE, chave: KEY, urlCrua: URL_CRUA, urlCorrigido: URL_CORRIGIDO
  };
  }

  global.Store = api();
})(typeof window !== 'undefined' ? window : globalThis);
