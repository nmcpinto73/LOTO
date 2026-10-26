/* =========================================================
   LoTo Manager — núcleo de regras
   Portado 1:1 de "Gestão LoTo.xlsm"
   (EuroResinas — Gestão de Cadeados & Bloqueios LOTO)
   ========================================================= */
(function (global) {
  'use strict';

  var LIVRE = 'Livre';
  var USO = 'Em Uso';
  var VAZIO = '—';

  // Folha "Consignacao" -> validação de dados C10
  var USERS = [
    'António Monteiro', 'Paulo Oliveira', 'António Pereira', 'Ricardo Carrilho',
    'Nuno Pinto', 'Ricardo Pereira', 'Frederico Magro', 'João Carrilho',
    'Paulo Casanova', 'Vitor Monteiro'
  ];

  // Folha oculta "Cadeados" -> coluna A (58 cadeados na produção)
  var SEED_IDS = [
    1012, 1019, 1032, 1033, 1034, 1035, 1039, 1164, 1181, 1182, 1183, 1184, 1185,
    1186, 1187, 1188, 1189, 1190, 1191, 1192, 1193, 1194, 1195, 1199, 1201, 1203,
    1205, 1207, 1208, 1209, 1210, 1211, 1212, 1213, 1214, 1215, 1216, 1217, 1218,
    1219, 1221, 1222, 1223, 1224, 1225, 1227, 1228, 1229, 1230,
    'AB 02283-1019-1', 'AB 02283-1036-1', 'H 00050', 'H 02133',
    'HX 03519', 'HX 03529', 'HX 03955', 'HX 03960', 'HX 04001'
  ];

  function seedState(nowIso) {
    return {
      version: 1,
      locks: SEED_IDS.map(function (id) {
        return { id: String(id), estado: LIVRE, equipamento: VAZIO, responsavel: VAZIO, dt: nowIso };
      }),
      history: [],
      users: USERS.slice()
    };
  }

  /* ---------- Início: KPIs (espelha as fórmulas) ---------- */
  // B5 =COUNTA(Cadeados!A2:A203)
  function totalLocks(s) { return s.locks.length; }
  // C5 / D5 =COUNTIF(Cadeados!B2:B201;"Livre"|"Em Uso")
  function countEstado(s, estado) {
    return s.locks.filter(function (l) { return l.estado === estado; }).length;
  }
  function livres(s) { return countEstado(s, LIVRE); }
  function emUso(s) { return countEstado(s, USO); }
  // E5 =D5/B5
  function taxaOcupacao(s) {
    var t = totalLocks(s);
    return t ? emUso(s) / t : 0;
  }
  // D9 =C9/B5  |  D10 =C10/B5
  function pctDe(n, s) {
    var t = totalLocks(s);
    return t ? n / t : 0;
  }
  function estadoOperacional(estado) {
    return estado === LIVRE
      ? 'Disponíveis para novas consignacoes'
      : 'Bloqueio LOTO ativo em equipamento';
  }

  /* ---------- Utilitários ---------- */
  function findLock(s, id) {
    var key = String(id == null ? '' : id).trim();
    for (var i = 0; i < s.locks.length; i++) {
      if (s.locks[i].id === key) return s.locks[i];
    }
    return null;
  }
  function locksByState(s, estado) {
    return s.locks.filter(function (l) { return l.estado === estado; });
  }
  function clone(s) { return JSON.parse(JSON.stringify(s)); }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  // Formato usado pelo VBA: Format(Now, "DD-MM-YYYY HH:MM")
  function fmtDT(iso) {
    if (!iso) return VAZIO;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear() +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDateShort(iso) {
    if (!iso) return VAZIO;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function pctLabel(x) { return (Math.round(x * 1000) / 10).toFixed(1).replace('.', ',') + '%'; }

  /* ---------- Consignação (VBA ExecutarConsignacao) ---------- */
  function validarConsignacao(s, form) {
    var erros = [];
    var id = String(form.id || '').trim();
    var equip = String(form.equipamento || '').trim();
    var resp = String(form.responsavel || '').trim();
    var at = String(form.at || '').trim();

    if (!id || !equip || !resp || !at) {
      erros.push('Por favor, preencha todos os campos obrigatórios (Cadeado, Equipamento, Responsável e AT).');
      return erros;
    }
    var lock = findLock(s, id);
    if (!lock) {
      erros.push('Cadeado ' + id + ' não encontrado.');
      return erros;
    }
    if (lock.estado === USO) {
      erros.push('O cadeado ' + id + ' já se encontra em uso no equipamento: ' + lock.equipamento);
    }
    return erros;
  }

  function consignar(state, form, nowIso) {
    var erros = validarConsignacao(state, form);
    if (erros.length) return { ok: false, erros: erros, state: state };

    var s = clone(state);
    var id = String(form.id).trim();
    var lock = findLock(s, id);
    var dtTxt = fmtDT(nowIso);

    // 1. Atualizar status na folha Cadeados
    lock.estado = USO;
    lock.equipamento = String(form.equipamento).trim();
    lock.responsavel = String(form.responsavel).trim();
    lock.dt = nowIso;

    // 2. Registar no Histórico
    var entrada = {
      dt: nowIso,
      dtTexto: dtTxt,
      tipo: 'Consignação',
      id: lock.id,
      equipamento: lock.equipamento,
      responsavel: lock.responsavel,
      status: 'Em Bloqueio',
      at: String(form.at).trim()
    };
    s.history.unshift(entrada);

    return {
      ok: true,
      state: s,
      entrada: entrada,
      mensagem: 'Consignação do equipamento ' + lock.equipamento + ' com o cadeado ' + lock.id + ' efectuada!'
    };
  }

  /* ---------- Desconsignação (VBA ExecutarDesconsignacao) ---------- */
  var AVISO_SEGURANCA = 'Antes de efetuar a Desconsignação, garantir que todas as condições de segurança estão repostas!';

  function validarDesconsignacao(s, form) {
    var erros = [];
    var id = String(form.id || '').trim();
    var resp = String(form.responsavel || '').trim();

    if (!id || !resp) {
      erros.push('Por favor, indique o ID do Cadeado e o Responsável pela Desconsignação.');
      return erros;
    }
    var lock = findLock(s, id);
    if (!lock) {
      erros.push('Cadeado ' + id + ' não encontrado.');
      return erros;
    }
    if (lock.estado === LIVRE) {
      erros.push('O cadeado ' + id + ' já está Livre.');
      return erros;
    }
    if (!form.segurancaConfirmada) {
      erros.push(AVISO_SEGURANCA);
    }
    return erros;
  }

  function desconsignar(state, form, nowIso) {
    var erros = validarDesconsignacao(state, form);
    if (erros.length) return { ok: false, erros: erros, state: state };

    var s = clone(state);
    var id = String(form.id).trim();
    var lock = findLock(s, id);
    var equip = lock.equipamento;
    var dtTxt = fmtDT(nowIso);

    // 1. Atualizar status na folha Cadeados
    lock.estado = LIVRE;
    lock.equipamento = VAZIO;
    lock.responsavel = VAZIO;
    lock.dt = nowIso;

    // 2. Registar no Histórico (VBA grava Status="Livre" e AT vazio)
    var entrada = {
      dt: nowIso,
      dtTexto: dtTxt,
      tipo: 'Desconsignação',
      id: lock.id,
      equipamento: equip,
      responsavel: String(form.responsavel).trim(),
      status: 'Livre',
      at: ''
    };
    s.history.unshift(entrada);

    return {
      ok: true,
      state: s,
      entrada: entrada,
      mensagem: 'Desconsignação do equipamento ' + equip + ' com o cadeado ' + lock.id + ' efectuada!'
    };
  }

  /* ---------- Cadeados (equivalente à folha oculta) ---------- */
  function adicionarCadeado(state, id, nowIso) {
    var key = String(id == null ? '' : id).trim();
    if (!key) return { ok: false, erros: ['Indique o ID do cadeado.'] };
    if (findLock(state, key)) return { ok: false, erros: ['O cadeado ' + key + ' já existe no quadro.'] };
    var s = clone(state);
    s.locks.push({ id: key, estado: LIVRE, equipamento: VAZIO, responsavel: VAZIO, dt: nowIso });
    return { ok: true, state: s };
  }

  function removerCadeado(state, id) {
    var lock = findLock(state, id);
    if (!lock) return { ok: false, erros: ['Cadeado não encontrado.'] };
    if (lock.estado === USO) return { ok: false, erros: ['Cadeado ' + lock.id + ' está em uso — desconsigne antes de remover.'] };
    var s = clone(state);
    s.locks = s.locks.filter(function (l) { return l.id !== lock.id; });
    return { ok: true, state: s };
  }

  /* ---------- Histórico ---------- */
  function filtrarHistorico(s, tipo, termo) {
    var t = (termo || '').toLowerCase().trim();
    return s.history.filter(function (h) {
      if (tipo && tipo !== 'Todos' && h.tipo !== tipo) return false;
      if (!t) return true;
      return (h.id + ' ' + h.equipamento + ' ' + h.responsavel + ' ' + h.at).toLowerCase().indexOf(t) >= 0;
    });
  }

  function toCSV(s) {
    var head = ['Data/Hora Registro', 'Tipo Operação', 'ID Cadeado', 'Equipamento', 'Responsável', 'Status', 'Autorização de Trabalho'];
    var rows = s.history.slice().reverse().map(function (h) {
      return [h.dtTexto, h.tipo, h.id, h.equipamento, h.responsavel, h.status, h.at];
    });
    return [head].concat(rows).map(function (r) {
      return r.map(function (c) {
        var v = String(c == null ? '' : c);
        return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(';');
    }).join('\r\n');
  }

  var api = {
    LIVRE: LIVRE, USO: USO, VAZIO: VAZIO, USERS: USERS, SEED_IDS: SEED_IDS,
    AVISO_SEGURANCA: AVISO_SEGURANCA,
    seedState: seedState, totalLocks: totalLocks, countEstado: countEstado,
    livres: livres, emUso: emUso, taxaOcupacao: taxaOcupacao, pctDe: pctDe,
    estadoOperacional: estadoOperacional, findLock: findLock, locksByState: locksByState,
    fmtDT: fmtDT, fmtDateShort: fmtDateShort, pctLabel: pctLabel,
    validarConsignacao: validarConsignacao, consignar: consignar,
    validarDesconsignacao: validarDesconsignacao, desconsignar: desconsignar,
    adicionarCadeado: adicionarCadeado, removerCadeado: removerCadeado,
    filtrarHistorico: filtrarHistorico, toCSV: toCSV
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LoTo = api;
})(typeof window !== 'undefined' ? window : globalThis);
