// =====================================================================
// patioCore.js — Núcleo do Sistema de Agendamento de Pátio
//
// ETAPA "REVISÃO ESTRUTURAL" — RESUMO DAS MUDANÇAS DESTA REVISÃO
// (mantém tudo que já existia; adiciona o que faltava para o sistema
// se comportar como UM organismo em vez de telas com regras próprias):
//
// 1) SEM_RESPOSTA deixou de ser só um "fallback de documento corrompido"
//    e passou a ser um estado administrativo de verdade: quando um
//    veículo com agendamento PENDENTE aparece fisicamente na Portaria,
//    a dimensão de aprovação é resolvida automaticamente para
//    SEM_RESPOSTA (ninguém decidiu a tempo, mas o check-in não pode
//    ficar refém disso — ver registrarCheckIn).
//
// 2) Check-in NUNCA mais é bloqueado pela dimensão administrativa.
//    Antes, só dava para dar entrada em agendamentos "Aprovado". Agora
//    a única coisa que bloqueia check-in é o próprio agendamento já ter
//    tido check-in (dimensão operacional) ou ter sido Cancelado pela
//    própria transportadora (nesse caso a orientação é usar Encaixe).
//
// 3) Máscara de placa centralizada aqui (aplicarMascaraPlaca /
//    configurarMascaraPlaca / placaCompleta) — antes existiam 3 cópias
//    quase idênticas espalhadas em transportadora-dashboard.html e
//    logistica-dashboard.html.
//
// 4) escutarBookings(): um único listener em tempo real (onSnapshot)
//    para a coleção `bookings`, para ser reaproveitado por qualquer
//    tela que precise da lista completa sempre atualizada, em vez de
//    cada tela fazer sua própria leitura pontual (getDocs) e ficar
//    desatualizada até a próxima ação do usuário.
//
// 5) `status` legado ganhou o valor "Sem Resposta" e a função que o
//    deriva (`derivarStatusLegado`) agora prioriza o que fisicamente
//    aconteceu (Em Pátio/Concluído/No-Show) sobre a dimensão
//    administrativa quando os dois divergem — é exatamente o cenário
//    "recusado mas compareceu mesmo assim" ou "sem resposta mas
//    compareceu": a Portaria e o Painel do Dia precisam mostrar a
//    realidade física, não a burocracia parada.
// =====================================================================

import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* #######################################################################
   PARTE 1 — BOOKING SCHEMA (MODELO LEGADO — mantido por compatibilidade)
   ####################################################################### */

export const STATUS = {
  PENDENTE: "Pendente",
  APROVADO: "Aprovado",
  RECUSADO: "Recusado",
  EXPIRADO: "Expirado",
  CANCELADO: "Cancelado",
  SEM_RESPOSTA: "Sem Resposta",
  EM_PATIO: "Em Pátio",
  CONCLUIDO: "Concluído",
  NO_SHOW: "No-Show"
};

export const TODOS_STATUS = Object.values(STATUS);

export const STATUS_LEGADO = [
  STATUS.PENDENTE, STATUS.APROVADO, STATUS.RECUSADO, STATUS.EXPIRADO,
  STATUS.CANCELADO, STATUS.SEM_RESPOSTA
];
export const STATUS_NOVO = [STATUS.EM_PATIO, STATUS.CONCLUIDO, STATUS.NO_SHOW];

// Estados finais da dimensão administrativa (nenhuma transição sai deles
// PELA VIA ADMINISTRATIVA — check-in continua podendo acontecer por
// cima, ver registrarCheckIn, que é o próprio ponto desta revisão).
export const STATUS_FINAIS = [
  STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO, STATUS.CONCLUIDO, STATUS.NO_SHOW
];

// Enquanto o booking está em um desses status (legado), ele continua
// contando como vaga ocupada em timeSlots.ocupados (não foi liberada).
// SEM_RESPOSTA entra aqui pelo mesmo motivo que PENDENTE: a vaga só é
// liberada quando alguém decide (expira, cancela) ou o veículo conclui.
export const STATUS_OCUPA_VAGA = [
  STATUS.PENDENTE, STATUS.APROVADO, STATUS.SEM_RESPOSTA, STATUS.EM_PATIO, STATUS.CONCLUIDO
];

// Ao entrar em qualquer um destes status (legado), a vaga em
// timeSlots.ocupados deve ser liberada (decrementada).
export const STATUS_LIBERA_VAGA = [
  STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO, STATUS.NO_SHOW
];

export const TRANSICOES_VALIDAS = {
  [STATUS.PENDENTE]: [STATUS.APROVADO, STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO, STATUS.SEM_RESPOSTA],
  [STATUS.SEM_RESPOSTA]: [STATUS.APROVADO, STATUS.RECUSADO, STATUS.EXPIRADO, STATUS.CANCELADO],
  [STATUS.APROVADO]: [STATUS.EM_PATIO, STATUS.CANCELADO, STATUS.NO_SHOW],
  [STATUS.RECUSADO]: [],
  [STATUS.EXPIRADO]: [],
  [STATUS.CANCELADO]: [],
  [STATUS.EM_PATIO]: [STATUS.CONCLUIDO],
  [STATUS.CONCLUIDO]: [],
  [STATUS.NO_SHOW]: []
};

export function transicaoValida(statusAtual, novoStatus) {
  return (TRANSICOES_VALIDAS[statusAtual] || []).includes(novoStatus);
}

export function isStatusFinal(status) {
  return STATUS_FINAIS.includes(status);
}

export function ocupaVaga(status) {
  return STATUS_OCUPA_VAGA.includes(status);
}

export function deveLiberarVaga(statusAtual, novoStatus) {
  return !STATUS_LIBERA_VAGA.includes(statusAtual) && STATUS_LIBERA_VAGA.includes(novoStatus);
}

// ---------------------- TIPO DE AGENDAMENTO ----------------------

export const TIPO_AGENDAMENTO = {
  ANTECIPADO: "Antecipado",
  PORTARIA: "Portaria/Encaixe",
  OPERACIONAL: "Operacional"
};

export const TODOS_TIPOS_AGENDAMENTO = Object.values(TIPO_AGENDAMENTO);

// ---------------------- CHECK-IN — PONTUALIDADE ----------------------

export const PONTUALIDADE = {
  PONTUAL: "Pontual",
  ADIANTADO: "Adiantado",
  ATRASADO: "Atrasado"
};

export const TOLERANCIA_PONTUALIDADE_MIN = 10;

export function calcularPontualidade(horaAgendada, dataHoraCheckIn, toleranciaMin = TOLERANCIA_PONTUALIDADE_MIN) {
  const minutosAgendado = horaParaMinutos(horaAgendada);
  const minutosCheckIn = dataHoraCheckIn.getHours() * 60 + dataHoraCheckIn.getMinutes();
  const diferenca = minutosCheckIn - minutosAgendado;

  if (Math.abs(diferenca) <= toleranciaMin) return PONTUALIDADE.PONTUAL;
  return diferenca < 0 ? PONTUALIDADE.ADIANTADO : PONTUALIDADE.ATRASADO;
}

export function paraDate(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === "function") return valor.toDate();
  if (valor instanceof Date) return valor;
  const d = new Date(valor);
  return isNaN(d.getTime()) ? null : d;
}

export function calcularTempoPermanenciaMinutos(checkInDataHora, checkOutDataHora) {
  const entrada = paraDate(checkInDataHora);
  const saida = paraDate(checkOutDataHora);
  if (!entrada || !saida) return null;

  const diffMin = Math.round((saida.getTime() - entrada.getTime()) / 60000);
  return diffMin >= 0 ? diffMin : null;
}

export function formatarPermanencia(minutos) {
  if (minutos === null || minutos === undefined || isNaN(minutos)) return "-";
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}min` : `${m}min`;
}

export function checkInValido(checkIn) {
  return !!checkIn
    && Object.values(PONTUALIDADE).includes(checkIn.pontualidade)
    && typeof checkIn.dadosConferidos === "boolean";
}

export function checkOutValido(checkOut) {
  return !!checkOut && typeof checkOut.notaFiscal === "string";
}

/* #######################################################################
   PARTE 1B — MODELO TRIDIMENSIONAL DE ESTADOS (fonte de verdade)
   ####################################################################### */

// ---- Dimensão 1: administrativa (foi autorizado?) ----
export const APROVACAO = {
  PENDENTE: "PENDENTE",
  APROVADO: "APROVADO",
  RECUSADO: "RECUSADO",
  EXPIRADO: "EXPIRADO",
  CANCELADO: "CANCELADO",
  // Ninguém decidiu a tempo. Pode chegar aqui de duas formas: (a) a
  // varredura de expiração roda e não converte para EXPIRADO porque o
  // veículo já chegou fisicamente (checar operacionalStatus antes de
  // expirar — ver expirar-pendentes.mjs), ou (b) o check-in acontece
  // primeiro e resolve o PENDENTE para SEM_RESPOSTA na hora (ver
  // registrarCheckIn). Também serve de fallback para documentos
  // antigos/incompletos — não deveria aparecer em uso normal por esse
  // segundo motivo.
  SEM_RESPOSTA: "SEM_RESPOSTA"
};

// ---- Dimensão 2: física (o motorista apareceu?) ----
export const COMPARECIMENTO = {
  NAO_COMPARECEU: "NAO_COMPARECEU",
  COMPARECEU: "COMPARECEU",
  COMPARECEU_ATRASADO: "COMPARECEU_ATRASADO"
};

// ---- Dimensão 3: operacional (está no pátio agora?) ----
export const OPERACIONAL = {
  SEM_CHECKIN: "SEM_CHECKIN",
  EM_PATIO: "EM_PATIO",
  CONCLUIDO: "CONCLUIDO"
};

export const TODAS_APROVACAO = Object.values(APROVACAO);
export const TODOS_COMPARECIMENTO = Object.values(COMPARECIMENTO);
export const TODOS_OPERACIONAL = Object.values(OPERACIONAL);

/** @private */
function _entradaHistorico(dimensaoAlterada, valorAnterior, novoValor, usuarioId) {
  return {
    dataHora: new Date(),
    dimensaoAlterada,
    valorAnterior: valorAnterior ?? null,
    novoValor: novoValor ?? null,
    usuarioId
  };
}

/**
 * Deriva o `status` legado (string única) a partir das 3 dimensões.
 * ORDEM DE PRIORIDADE (revisada nesta etapa): o que fisicamente
 * aconteceu no pátio (Concluído/Em Pátio/No-Show) tem prioridade sobre
 * a dimensão administrativa — é assim que "recusado mas compareceu" ou
 * "sem resposta mas está em pátio agora" ficam visíveis corretamente em
 * telas que só leem este campo único (badges simples, filtros).
 */
export function derivarStatusLegado(dims) {
  const { aprovacaoStatus, comparecimentoStatus, operacionalStatus } = dims;

  if (operacionalStatus === OPERACIONAL.CONCLUIDO) return STATUS.CONCLUIDO;
  if (operacionalStatus === OPERACIONAL.EM_PATIO) return STATUS.EM_PATIO;
  if (comparecimentoStatus === COMPARECIMENTO.NAO_COMPARECEU) return STATUS.NO_SHOW;

  if (aprovacaoStatus === APROVACAO.RECUSADO) return STATUS.RECUSADO;
  if (aprovacaoStatus === APROVACAO.EXPIRADO) return STATUS.EXPIRADO;
  if (aprovacaoStatus === APROVACAO.CANCELADO) return STATUS.CANCELADO;
  if (aprovacaoStatus === APROVACAO.SEM_RESPOSTA) return STATUS.SEM_RESPOSTA;
  if (aprovacaoStatus === APROVACAO.APROVADO) return STATUS.APROVADO;
  return STATUS.PENDENTE;
}

/**
 * Rótulo de exibição "cru" (mesmos valores de `derivarStatusLegado` por
 * enquanto) — mantido como função própria para permitir que o rótulo de
 * tela e o status legado gravado no Firestore divirjam no futuro sem
 * quebrar um pelo outro.
 */
export function situacaoResumoLabel(booking) {
  return derivarStatusLegado({
    aprovacaoStatus: booking.aprovacaoStatus,
    comparecimentoStatus: booking.comparecimentoStatus,
    operacionalStatus: booking.operacionalStatus
  });
}

/**
 * Rótulo em linguagem operacional (não-técnica), pensado para quem
 * bate o olho na tela e precisa entender sem decifrar código. Cobre os
 * cenários A–H descritos na revisão estrutural do sistema.
 */
export function situacaoDetalhadaLabel(booking) {
  const a = booking.aprovacaoStatus;
  const c = booking.comparecimentoStatus;
  const o = booking.operacionalStatus;

  if (o === OPERACIONAL.CONCLUIDO) {
    if (a === APROVACAO.RECUSADO) return "Concluído (havia sido recusado)";
    if (a === APROVACAO.SEM_RESPOSTA) return "Concluído (sem resposta administrativa)";
    return "Concluído";
  }
  if (o === OPERACIONAL.EM_PATIO) {
    const atraso = c === COMPARECIMENTO.COMPARECEU_ATRASADO ? " — chegou atrasado" : "";
    if (a === APROVACAO.RECUSADO) return `Em pátio (recusado, compareceu mesmo assim)${atraso}`;
    if (a === APROVACAO.SEM_RESPOSTA) return `Em pátio (sem resposta administrativa)${atraso}`;
    return `Em pátio${atraso}`;
  }
  if (c === COMPARECIMENTO.NAO_COMPARECEU) {
    if (a === APROVACAO.RECUSADO) return "Não compareceu (recusado)";
    return "Não compareceu (No-Show)";
  }
  if (a === APROVACAO.RECUSADO) return "Recusado";
  if (a === APROVACAO.EXPIRADO) return "Expirado — prazo de aprovação encerrado";
  if (a === APROVACAO.CANCELADO) return "Cancelado";
  if (a === APROVACAO.SEM_RESPOSTA) return "Sem resposta administrativa";
  if (a === APROVACAO.APROVADO) return "Aprovado — aguardando chegada";
  return "Aguardando aprovação";
}

/**
 * Deriva as 3 dimensões a partir de um `status` legado — usada por
 * `normalizarBooking` para "traduzir" documentos antigos on-the-fly.
 */
export function derivarDimensoesDoStatusLegado(statusLegado, booking = {}) {
  switch (statusLegado) {
    case STATUS.PENDENTE:
      return { aprovacaoStatus: APROVACAO.PENDENTE, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.APROVADO:
      return { aprovacaoStatus: APROVACAO.APROVADO, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.SEM_RESPOSTA:
      return { aprovacaoStatus: APROVACAO.SEM_RESPOSTA, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.RECUSADO:
      return { aprovacaoStatus: APROVACAO.RECUSADO, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.EXPIRADO:
      return { aprovacaoStatus: APROVACAO.EXPIRADO, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.CANCELADO:
      return { aprovacaoStatus: APROVACAO.CANCELADO, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    case STATUS.EM_PATIO: {
      const atrasado = booking.checkIn?.pontualidade === PONTUALIDADE.ATRASADO;
      return { aprovacaoStatus: booking.aprovacaoStatus || APROVACAO.APROVADO, comparecimentoStatus: atrasado ? COMPARECIMENTO.COMPARECEU_ATRASADO : COMPARECIMENTO.COMPARECEU, operacionalStatus: OPERACIONAL.EM_PATIO };
    }
    case STATUS.CONCLUIDO: {
      const atrasado = booking.checkIn?.pontualidade === PONTUALIDADE.ATRASADO;
      return { aprovacaoStatus: booking.aprovacaoStatus || APROVACAO.APROVADO, comparecimentoStatus: atrasado ? COMPARECIMENTO.COMPARECEU_ATRASADO : COMPARECIMENTO.COMPARECEU, operacionalStatus: OPERACIONAL.CONCLUIDO };
    }
    case STATUS.NO_SHOW:
      return { aprovacaoStatus: booking.aprovacaoStatus || APROVACAO.APROVADO, comparecimentoStatus: COMPARECIMENTO.NAO_COMPARECEU, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
    default:
      return { aprovacaoStatus: APROVACAO.SEM_RESPOSTA, comparecimentoStatus: null, operacionalStatus: OPERACIONAL.SEM_CHECKIN };
  }
}

/**
 * Garante que um booking (vindo de `getDocs`/`getDoc`/`onSnapshot`, novo
 * ou antigo) tenha as 3 dimensões preenchidas, sem alterar nada no
 * Firestore.
 */
export function normalizarBooking(booking) {
  if (booking && booking.aprovacaoStatus) {
    return { historicoEstados: [], ...booking };
  }
  const dims = derivarDimensoesDoStatusLegado(booking?.status, booking);
  return { historicoEstados: [], ...booking, ...dims };
}

/* #######################################################################
   PARTE 1C — TEMPO REAL (fonte de dados única para todas as telas)
   ####################################################################### */

/**
 * Listener único em tempo real para a coleção `bookings`, normalizado.
 * Reaproveitado por todas as telas que precisam da lista completa
 * sempre atualizada (Painel do Dia, Portaria, Solicitações, Todos os
 * Agendamentos, KPIs) — evita que cada tela tenha sua própria cópia
 * desatualizada até a próxima ação manual do usuário.
 *
 * @param {Firestore} db
 * @param {(bookings: object[]) => void} callback chamado a cada mudança
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} função para cancelar o listener (unsubscribe)
 */
export function escutarBookings(db, callback, onError) {
  return onSnapshot(
    collection(db, "bookings"),
    (snap) => {
      const bookings = snap.docs.map(d => normalizarBooking({ id: d.id, ...d.data() }));
      callback(bookings);
    },
    (err) => {
      console.error("Erro no listener em tempo real de bookings:", err);
      if (onError) onError(err);
    }
  );
}

/* #######################################################################
   PARTE 1D — MÁSCARA DE PLACA (CENTRALIZADA)
   Aceita AAA-0000 (antigo) e AAA0A00 (Mercosul). Única implementação do
   sistema — antes existiam cópias quase idênticas em
   transportadora-dashboard.html e logistica-dashboard.html; qualquer
   tela/formulário que peça placa deve importar daqui.
   ####################################################################### */

export function aplicarMascaraPlaca(valorBruto) {
  const brutoLimpo = (valorBruto || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  let alfanumerico = "";

  for (let i = 0; i < brutoLimpo.length && alfanumerico.length < 7; i++) {
    const ch = brutoLimpo[i];
    const pos = alfanumerico.length;

    if (pos < 3) {
      if (/[A-Z]/.test(ch)) alfanumerico += ch;
    } else if (pos === 3) {
      if (/[0-9]/.test(ch)) alfanumerico += ch;
    } else if (pos === 4) {
      if (/[A-Z0-9]/.test(ch)) alfanumerico += ch;
    } else {
      if (/[0-9]/.test(ch)) alfanumerico += ch;
    }
  }

  // O 5º caractere (índice 4) define o formato: dígito = antigo (com
  // traço), letra = Mercosul (sem traço).
  if (alfanumerico.length >= 5 && /[0-9]/.test(alfanumerico[4])) {
    return alfanumerico.slice(0, 3) + "-" + alfanumerico.slice(3);
  }
  return alfanumerico;
}

export function placaCompleta(valorMascarado) {
  return (valorMascarado || "").replace("-", "").length === 7;
}

export function configurarMascaraPlaca(inputEl) {
  if (!inputEl) return;
  inputEl.addEventListener("input", () => {
    inputEl.value = aplicarMascaraPlaca(inputEl.value);
  });
}

/* #######################################################################
   PARTE 2 — DISPONIBILIDADE
   Regra master (timeSlotRules) -> Exceções recorrentes (timeSlotExceptions)
   -> Ajuste pontual (timeSlots) = disponibilidade final. Esta é a ÚNICA
   função de cálculo de horários do sistema; nenhuma tela deve calcular
   disponibilidade por conta própria.
   ####################################################################### */

export function horaParaMinutos(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutosParaHora(min) {
  const h = String(Math.floor(min / 60)).padStart(2, "0");
  const m = String(min % 60).padStart(2, "0");
  return `${h}:${m}`;
}

export function idSlotHorario(dataStr, horaInicio) {
  return `${dataStr}_${horaInicio.replace(":", "-")}`;
}

export function calcularBlocosHorario(obj) {
  const inicioMin = horaParaMinutos(obj.horaInicio);
  let fimMin = horaParaMinutos(obj.horaFim);
  if (fimMin <= inicioMin) fimMin += 24 * 60;
  const blocos = [];
  for (let m = inicioMin; m < fimMin; m += 60) {
    blocos.push(m % (24 * 60));
  }
  return blocos;
}

function diaSemanaDaData(dataStr) {
  const [ano, mes, dia] = dataStr.split("-").map(Number);
  return new Date(ano, mes - 1, dia).getDay();
}

export async function buscarSlotsVirtuaisDoDia(db, dataStr, opcoes = {}) {
  const { incluirFechados = false } = opcoes;
  const diaSemana = diaSemanaDaData(dataStr);
  const mapa = {};

  // 1) REGRA MASTER (Horários & Exceções -> Regra Padrão)
  const snapRegras = await getDocs(query(collection(db, "timeSlotRules"), where("ativo", "==", true)));
  snapRegras.docs.forEach(d => {
    const r = d.data();
    if (!(r.diasSemana || []).includes(diaSemana)) return;
    calcularBlocosHorario(r).forEach(min => {
      mapa[minutosParaHora(min)] = { capacidadeMax: r.capacidadePorHora, origem: "regra" };
    });
  });

  // 2) EXCEÇÕES RECORRENTES (sobrescrevem a regra master no dia/horário)
  const snapExc = await getDocs(query(collection(db, "timeSlotExceptions"), where("ativo", "==", true)));
  snapExc.docs.forEach(d => {
    const ex = d.data();
    if (!(ex.diasSemana || []).includes(diaSemana)) return;
    calcularBlocosHorario(ex).forEach(min => {
      const hora = minutosParaHora(min);
      if (Number(ex.capacidadePorHora) <= 0) {
        // Capacidade 0 = bloqueado explicitamente, não "sem regra".
        delete mapa[hora];
      } else {
        mapa[hora] = { capacidadeMax: ex.capacidadePorHora, origem: "excecao" };
      }
    });
  });

  const padraoAtual = {};
  Object.keys(mapa).forEach(hora => { padraoAtual[hora] = mapa[hora].capacidadeMax; });

  // 3) GESTÃO DE VAGAS (ajuste pontual — só afeta esta data específica,
  //    nunca sobrescreve a regra recorrente em si).
  const snapManual = await getDocs(query(collection(db, "timeSlots"), where("data", "==", dataStr)));
  const manuais = {};
  snapManual.docs.forEach(d => { manuais[d.data().horaInicio] = { id: d.id, ...d.data() }; });

  Object.keys(manuais).forEach(hora => {
    const m = manuais[hora];
    if (m.ativo === false) {
      if (incluirFechados) {
        mapa[hora] = { capacidadeMax: m.capacidadeMax || 0, origem: "manual", fechado: true };
      } else {
        delete mapa[hora];
      }
    } else {
      mapa[hora] = { capacidadeMax: m.capacidadeMax, origem: "manual", fechado: false };
    }
  });

  return Object.keys(mapa).sort().map(hora => {
    const info = mapa[hora];
    const manual = manuais[hora];
    const capacidadePadraoAtual = Object.prototype.hasOwnProperty.call(padraoAtual, hora) ? padraoAtual[hora] : null;
    const divergeDoPadrao = !!manual && !info.fechado
      && capacidadePadraoAtual !== info.capacidadeMax;
    return {
      horaInicio: hora,
      horaFim: minutosParaHora((horaParaMinutos(hora) + 60) % (24 * 60)),
      capacidadeMax: info.capacidadeMax,
      ocupados: manual ? (manual.ocupados || 0) : 0,
      origem: info.origem,
      fechado: !!info.fechado,
      temAjusteManual: !!manual,
      capacidadePadraoAtual,
      divergeDoPadrao
    };
  });
}

export async function obterHorariosDisponiveis(db, dataStr, opcoes = {}) {
  const slots = await buscarSlotsVirtuaisDoDia(db, dataStr, opcoes);
  return slots.map(slot => ({
    ...slot,
    vagasRestantes: Math.max(0, (slot.capacidadeMax || 0) - (slot.ocupados || 0))
  }));
}

/* #######################################################################
   PARTE 3 — AGENDAMENTO OPERACIONAL E DA TRANSPORTADORA
   ####################################################################### */

const REGEX_DATA = /^\d{4}-\d{2}-\d{2}$/;
const REGEX_HORA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const CAPACIDADE_PADRAO_FORA_DO_PADRAO = 1;

export async function buscarTransportadoraCadastrada(db, transportadoraId) {
  if (!transportadoraId) return null;

  const snap = await getDoc(doc(db, "users", transportadoraId));
  if (!snap.exists()) {
    throw new Error("Transportadora cadastrada não encontrada.");
  }

  const dadosUser = snap.data();
  if (dadosUser.tipo !== 1) {
    throw new Error("O usuário selecionado não é uma conta de Transportadora.");
  }
  if (dadosUser.status !== "aprovado") {
    throw new Error("Esta transportadora ainda não está com o cadastro aprovado.");
  }

  return { uid: snap.id, nome: dadosUser.nome || "", empresa: dadosUser.empresa || "" };
}

function validarCamposObrigatorios(dados) {
  const erros = [];

  if (!dados.empresa || !String(dados.empresa).trim()) {
    erros.push("Nome da empresa é obrigatório.");
  }
  if (!dados.tipoProcessoId) {
    erros.push("Tipo de processo é obrigatório.");
  }
  if (!REGEX_DATA.test(dados.dataAgendada || "")) {
    erros.push("Data agendada inválida (use o formato AAAA-MM-DD).");
  }
  if (!REGEX_HORA.test(dados.horaInicio || "")) {
    erros.push("Horário de início inválido (use o formato HH:MM).");
  }
  if (!dados.placaCavalo || !String(dados.placaCavalo).trim()) {
    erros.push("Placa do cavalo é obrigatória.");
  }
  if (!dados.motorista || !String(dados.motorista).trim()) {
    erros.push("Nome do motorista é obrigatório.");
  }

  if (erros.length > 0) {
    throw new Error(erros.join(" "));
  }
}

async function buscarCapacidadeReferencia(db, dataAgendada, horaInicio) {
  const slots = await buscarSlotsVirtuaisDoDia(db, dataAgendada, { incluirFechados: true });
  const slot = slots.find(s => s.horaInicio === horaInicio);
  return slot ? slot : null;
}

export async function criarAgendamentoOperacional(db, usuarioLogado, dados, opcoes = {}) {
  const { forcarAlemDaCapacidade = false, ignorarFechado = false } = opcoes;

  if (!usuarioLogado || !usuarioLogado.uid) {
    throw new Error("Usuário da Logística/Admin não identificado.");
  }

  validarCamposObrigatorios(dados);

  const transportadoraCadastrada = await buscarTransportadoraCadastrada(db, dados.transportadoraId);

  const dataAgendada = dados.dataAgendada;
  const horaInicio = dados.horaInicio;
  const horaFim = minutosParaHora((horaParaMinutos(horaInicio) + 60) % (24 * 60));

  const slotReferencia = await buscarCapacidadeReferencia(db, dataAgendada, horaInicio);
  if (slotReferencia && slotReferencia.fechado && !ignorarFechado) {
    throw new Error("Este horário está fechado manualmente para esta data. Use opcoes.ignorarFechado=true para forçar, se necessário.");
  }

  const slotId = idSlotHorario(dataAgendada, horaInicio);
  const slotRef = doc(db, "timeSlots", slotId);
  const bookingRef = doc(collection(db, "bookings"));

  let capacidadeMax;
  let ocupados;
  let capacidadeForcada = false;

  const dimsIniciais = {
    aprovacaoStatus: APROVACAO.APROVADO,
    comparecimentoStatus: null,
    operacionalStatus: OPERACIONAL.SEM_CHECKIN
  };

  await runTransaction(db, async (transaction) => {
    const slotSnap = await transaction.get(slotRef);

    let capacidadeAtual;
    let ocupadosAtuais;

    if (slotSnap.exists()) {
      const slotData = slotSnap.data();
      if (slotData.ativo === false && !ignorarFechado) {
        throw new Error("Este horário foi fechado manualmente para esta data (entre a consulta e a gravação).");
      }
      capacidadeAtual = slotData.capacidadeMax;
      ocupadosAtuais = slotData.ocupados || 0;
    } else {
      capacidadeAtual = slotReferencia
        ? slotReferencia.capacidadeMax
        : (dados.capacidadeManual || CAPACIDADE_PADRAO_FORA_DO_PADRAO);
      ocupadosAtuais = 0;
    }

    let novosOcupados = ocupadosAtuais + 1;

    if (novosOcupados > capacidadeAtual) {
      if (!forcarAlemDaCapacidade) {
        throw new Error(
          `Sem vaga disponível neste horário (${ocupadosAtuais}/${capacidadeAtual} já ocupado(s)). ` +
          `Use opcoes.forcarAlemDaCapacidade=true para registrar mesmo assim.`
        );
      }
      capacidadeAtual = novosOcupados;
      capacidadeForcada = true;
    }

    capacidadeMax = capacidadeAtual;
    ocupados = novosOcupados;

    transaction.set(slotRef, {
      data: dataAgendada,
      horaInicio,
      horaFim,
      capacidadeMax,
      ativo: true,
      ocupados
    }, { merge: true });

    transaction.set(bookingRef, {
      usuarioId: transportadoraCadastrada ? transportadoraCadastrada.uid : null,
      transportadoraCadastrada: !!transportadoraCadastrada,
      empresa: String(dados.empresa).trim(),
      tipoProcessoId: dados.tipoProcessoId,
      dataAgendada,
      horaInicio,
      horaFim,
      placaCavalo: String(dados.placaCavalo).trim().toUpperCase(),
      placaCarreta: dados.placaCarreta ? String(dados.placaCarreta).trim().toUpperCase() : "",
      motorista: String(dados.motorista).trim(),
      observacoes: dados.observacoes ? String(dados.observacoes).trim() : "",
      ...dimsIniciais,
      historicoEstados: [
        _entradaHistorico("aprovacaoStatus", null, dimsIniciais.aprovacaoStatus, usuarioLogado.uid),
        _entradaHistorico("operacionalStatus", null, dimsIniciais.operacionalStatus, usuarioLogado.uid)
      ],
      status: derivarStatusLegado(dimsIniciais),
      tipoAgendamento: TIPO_AGENDAMENTO.OPERACIONAL,
      vagaLiberada: false,
      criadoEm: serverTimestamp(),
      criadoPor: usuarioLogado.uid,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });

  try {
    await addDoc(collection(db, "auditLogs"), {
      bookingId: bookingRef.id,
      usuarioId: usuarioLogado.uid,
      acao: "Solicitou",
      dataHora: serverTimestamp()
    });
    await addDoc(collection(db, "auditLogs"), {
      bookingId: bookingRef.id,
      usuarioId: usuarioLogado.uid,
      acao: "Aprovou",
      dataHora: serverTimestamp()
    });
  } catch (errAudit) {
    console.error("Erro ao registrar log de auditoria do agendamento operacional:", errAudit);
  }

  return { bookingId: bookingRef.id, slotId, capacidadeMax, ocupados, capacidadeForcada };
}

export async function criarAgendamentoTransportadora(db, usuarioAtual, dados, slotReferencia) {
  if (!usuarioAtual || !usuarioAtual.uid) {
    throw new Error("Usuário não identificado.");
  }

  validarCamposObrigatorios(dados);

  if (!slotReferencia) {
    throw new Error("Este horário não está mais disponível. Selecione a data novamente.");
  }

  const slotId = idSlotHorario(dados.dataAgendada, dados.horaInicio);
  const slotRef = doc(db, "timeSlots", slotId);
  const bookingRef = doc(collection(db, "bookings"));

  const dimsIniciais = {
    aprovacaoStatus: APROVACAO.PENDENTE,
    comparecimentoStatus: null,
    operacionalStatus: OPERACIONAL.SEM_CHECKIN
  };

  await runTransaction(db, async (transaction) => {
    const slotSnap = await transaction.get(slotRef);

    let capacidadeMax;
    let ocupadosAtuais;

    if (!slotSnap.exists()) {
      capacidadeMax = slotReferencia.capacidadeMax;
      ocupadosAtuais = 0;
    } else {
      const slotData = slotSnap.data();
      if (slotData.ativo === false) {
        throw new Error("O horário selecionado não está mais disponível.");
      }
      capacidadeMax = slotData.capacidadeMax;
      ocupadosAtuais = slotData.ocupados || 0;
    }

    if (ocupadosAtuais >= capacidadeMax) {
      throw new Error("As vagas para este horário acabaram de esgotar. Escolha outro horário.");
    }

    transaction.set(slotRef, {
      data: dados.dataAgendada,
      horaInicio: dados.horaInicio,
      horaFim: slotReferencia.horaFim,
      capacidadeMax,
      ativo: true,
      ocupados: ocupadosAtuais + 1
    }, { merge: true });

    transaction.set(bookingRef, {
      usuarioId: usuarioAtual.uid,
      empresa: String(dados.empresa).trim(),
      tipoProcessoId: dados.tipoProcessoId,
      dataAgendada: dados.dataAgendada,
      horaInicio: dados.horaInicio,
      horaFim: slotReferencia.horaFim,
      placaCavalo: String(dados.placaCavalo).trim().toUpperCase(),
      placaCarreta: dados.placaCarreta ? String(dados.placaCarreta).trim().toUpperCase() : "",
      motorista: String(dados.motorista).trim(),
      observacoes: dados.observacoes ? String(dados.observacoes).trim() : "",
      ...dimsIniciais,
      historicoEstados: [
        _entradaHistorico("aprovacaoStatus", null, dimsIniciais.aprovacaoStatus, usuarioAtual.uid)
      ],
      status: derivarStatusLegado(dimsIniciais),
      tipoAgendamento: TIPO_AGENDAMENTO.ANTECIPADO,
      vagaLiberada: false,
      criadoEm: serverTimestamp()
    });
  });

  try {
    await addDoc(collection(db, "auditLogs"), {
      bookingId: bookingRef.id,
      usuarioId: usuarioAtual.uid,
      acao: "Solicitou",
      dataHora: serverTimestamp()
    });
  } catch (errAudit) {
    console.error("Erro ao registrar log de auditoria do agendamento da Transportadora:", errAudit);
  }

  return { bookingId: bookingRef.id, slotId };
}

/* #######################################################################
   PARTE 4 — KPI METRICS
   ####################################################################### */

export function filtrarBookings(bookings, dataInicio, dataFim, empresa = "todas") {
  return bookings.filter(b => {
    if (dataInicio && b.dataAgendada < dataInicio) return false;
    if (dataFim && b.dataAgendada > dataFim) return false;
    if (empresa && empresa !== "todas" && b.empresa !== empresa) return false;
    return true;
  });
}

export function calcularKPIs(bookingsFiltrados) {
  const totalGeral = bookingsFiltrados.length;

  const previstos = bookingsFiltrados.filter(b =>
    [STATUS.CONCLUIDO, STATUS.EM_PATIO, STATUS.APROVADO, STATUS.NO_SHOW].includes(b.status)
  );
  const totalPrevistos = previstos.length;
  const totalNoShow = previstos.filter(b => b.status === STATUS.NO_SHOW).length;
  const taxaNoShow = totalPrevistos > 0 ? ((totalNoShow / totalPrevistos) * 100).toFixed(1) : "0.0";

  const comCheckIn = bookingsFiltrados.filter(b => b.checkIn && b.checkIn.pontualidade);
  const totalCheckIns = comCheckIn.length;

  let noHorario = 0;
  let antecipado = 0;
  let atrasado = 0;

  comCheckIn.forEach(b => {
    const p = b.checkIn.pontualidade;
    if (p === PONTUALIDADE.PONTUAL) noHorario++;
    else if (p === PONTUALIDADE.ADIANTADO) antecipado++;
    else if (p === PONTUALIDADE.ATRASADO) atrasado++;
  });

  const pctNoHorario = totalCheckIns > 0 ? ((noHorario / totalCheckIns) * 100).toFixed(1) : "0.0";
  const pctAntecipado = totalCheckIns > 0 ? ((antecipado / totalCheckIns) * 100).toFixed(1) : "0.0";
  const pctAtrasado = totalCheckIns > 0 ? ((atrasado / totalCheckIns) * 100).toFixed(1) : "0.0";

  const totalEncaixes = bookingsFiltrados.filter(b => b.tipoAgendamento === TIPO_AGENDAMENTO.PORTARIA).length;
  const totalPrevio = totalGeral - totalEncaixes;
  const pctPrevio = totalGeral > 0 ? ((totalPrevio / totalGeral) * 100).toFixed(1) : "0.0";
  const pctEncaixe = totalGeral > 0 ? ((totalEncaixes / totalGeral) * 100).toFixed(1) : "0.0";

  const concluidos = bookingsFiltrados.filter(b =>
    b.status === STATUS.CONCLUIDO && b.checkOut?.permanenciaMinutos !== undefined
  );

  const somaMinutos = concluidos.reduce((acc, b) => acc + (b.checkOut.permanenciaMinutos || 0), 0);
  const mediaMinutos = concluidos.length > 0 ? Math.round(somaMinutos / concluidos.length) : 0;
  const dwellTimeFormatado = formatarPermanencia(mediaMinutos);

  let totalDivergencias = 0;
  comCheckIn.forEach(b => {
    if (b.checkIn?.dadosConferidos === true && b.checkIn?.divergente === true) {
      totalDivergencias++;
    }
  });

  const totalSemResposta = bookingsFiltrados.filter(b => b.aprovacaoStatus === APROVACAO.SEM_RESPOSTA).length;

  return {
    totalGeral,
    totalPrevistos,
    totalNoShow,
    taxaNoShow,
    totalCheckIns,
    totalSemResposta,
    pontualidade: { noHorario, antecipado, atrasado, pctNoHorario, pctAntecipado, pctAtrasado },
    modalidade: { totalPrevio, totalEncaixes, pctPrevio, pctEncaixe },
    dwellTime: { mediaMinutos, formatado: dwellTimeFormatado, totalAtendidos: concluidos.length },
    totalDivergencias
  };
}

/* #######################################################################
   PARTE 5 — LIBERAÇÃO DE VAGA (helper interno compartilhado)
   ####################################################################### */

function _liberarVagaNaTransacao(transaction, slotSnap) {
  if (slotSnap && slotSnap.exists()) {
    const slotData = slotSnap.data();
    const ocupadosAtuais = slotData.ocupados || 0;
    if (ocupadosAtuais > 0) {
      transaction.set(slotSnap.ref, { ...slotData, ocupados: ocupadosAtuais - 1 }, { merge: true });
    }
  }
}

export async function mudarStatusBooking(db, usuarioLogado, booking, novoStatus) {
  if (!usuarioLogado || !usuarioLogado.uid) {
    throw new Error("Usuário não identificado.");
  }
  if (!booking || !booking.id) {
    throw new Error("Agendamento não informado.");
  }

  const bookingRef = doc(db, "bookings", booking.id);
  let vagaFoiLiberada = false;

  await runTransaction(db, async (transaction) => {
    const bookingSnap = await transaction.get(bookingRef);
    if (!bookingSnap.exists()) {
      throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    }
    const dadosAtuais = bookingSnap.data();
    const statusAtual = dadosAtuais.status;

    if (!transicaoValida(statusAtual, novoStatus)) {
      throw new Error(
        `Não é possível mudar de "${statusAtual}" para "${novoStatus}" — outra pessoa pode já ter atualizado este agendamento. Atualize a lista e tente novamente.`
      );
    }

    const precisaLiberarVaga = deveLiberarVaga(statusAtual, novoStatus) && dadosAtuais.vagaLiberada !== true;

    let slotSnap = null;
    if (precisaLiberarVaga) {
      const slotRef = doc(db, "timeSlots", idSlotHorario(dadosAtuais.dataAgendada, dadosAtuais.horaInicio));
      slotSnap = await transaction.get(slotRef);
    }

    const novasDims = derivarDimensoesDoStatusLegado(novoStatus, dadosAtuais);

    const payloadBooking = {
      status: novoStatus,
      aprovacaoStatus: novasDims.aprovacaoStatus,
      comparecimentoStatus: novasDims.comparecimentoStatus,
      operacionalStatus: novasDims.operacionalStatus,
      historicoEstados: arrayUnion(
        _entradaHistorico("status(legado)", statusAtual, novoStatus, usuarioLogado.uid)
      ),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    };

    if (precisaLiberarVaga) {
      _liberarVagaNaTransacao(transaction, slotSnap);
      payloadBooking.vagaLiberada = true;
      vagaFoiLiberada = true;
    }

    transaction.update(bookingRef, payloadBooking);
  });

  return { vagaLiberada: vagaFoiLiberada };
}

/* #######################################################################
   PARTE 6 — AÇÕES DA LOGÍSTICA SOBRE A DIMENSÃO DE APROVAÇÃO
   ####################################################################### */

export async function aprovarSolicitacao(db, usuarioLogado, bookingId) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    const dadosAtuais = normalizarBooking(snap.data());

    if (![APROVACAO.PENDENTE, APROVACAO.SEM_RESPOSTA].includes(dadosAtuais.aprovacaoStatus)) {
      throw new Error(`Este agendamento não está mais aguardando decisão (situação atual: "${situacaoDetalhadaLabel(dadosAtuais)}"). Atualize a lista e tente novamente.`);
    }

    const novasDims = { aprovacaoStatus: APROVACAO.APROVADO, comparecimentoStatus: dadosAtuais.comparecimentoStatus, operacionalStatus: dadosAtuais.operacionalStatus };

    transaction.update(bookingRef, {
      aprovacaoStatus: APROVACAO.APROVADO,
      comparecimentoStatus: novasDims.comparecimentoStatus,
      operacionalStatus: novasDims.operacionalStatus,
      status: derivarStatusLegado(novasDims),
      historicoEstados: arrayUnion(_entradaHistorico("aprovacaoStatus", dadosAtuais.aprovacaoStatus, APROVACAO.APROVADO, usuarioLogado.uid)),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });
}

export async function recusarSolicitacao(db, usuarioLogado, bookingId) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);
  let vagaFoiLiberada = false;

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    const dadosAtuais = normalizarBooking(snap.data());

    if (![APROVACAO.PENDENTE, APROVACAO.SEM_RESPOSTA].includes(dadosAtuais.aprovacaoStatus)) {
      throw new Error(`Este agendamento não está mais aguardando decisão (situação atual: "${situacaoDetalhadaLabel(dadosAtuais)}"). Atualize a lista e tente novamente.`);
    }
    if (dadosAtuais.operacionalStatus !== OPERACIONAL.SEM_CHECKIN) {
      throw new Error(`Este veículo já tem movimentação registrada na Portaria (situação atual: "${situacaoDetalhadaLabel(dadosAtuais)}") — recusar não é mais aplicável.`);
    }

    const precisaLiberarVaga = dadosAtuais.vagaLiberada !== true;
    let slotSnap = null;
    if (precisaLiberarVaga) {
      const slotRef = doc(db, "timeSlots", idSlotHorario(dadosAtuais.dataAgendada, dadosAtuais.horaInicio));
      slotSnap = await transaction.get(slotRef);
    }

    const novasDims = { aprovacaoStatus: APROVACAO.RECUSADO, comparecimentoStatus: dadosAtuais.comparecimentoStatus, operacionalStatus: dadosAtuais.operacionalStatus };

    const payload = {
      aprovacaoStatus: APROVACAO.RECUSADO,
      comparecimentoStatus: novasDims.comparecimentoStatus,
      operacionalStatus: novasDims.operacionalStatus,
      status: derivarStatusLegado(novasDims),
      historicoEstados: arrayUnion(_entradaHistorico("aprovacaoStatus", dadosAtuais.aprovacaoStatus, APROVACAO.RECUSADO, usuarioLogado.uid)),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    };

    if (precisaLiberarVaga) {
      _liberarVagaNaTransacao(transaction, slotSnap);
      payload.vagaLiberada = true;
      vagaFoiLiberada = true;
    }

    transaction.update(bookingRef, payload);
  });

  return { vagaLiberada: vagaFoiLiberada };
}

/* #######################################################################
   PARTE 7 — MÓDULO PORTARIA: CHECK-IN, CHECK-OUT, NO-SHOW, ENCAIXE
   ####################################################################### */

/**
 * Registra o Check-in. REGRA CENTRAL DESTA REVISÃO: o check-in NUNCA é
 * bloqueado pela dimensão administrativa (Pendente/Recusado/Sem
 * Resposta) — só é bloqueado se o agendamento já tiver check-in
 * (dimensão operacional) ou tiver sido Cancelado pela própria
 * transportadora. Se estava Pendente, a aprovação é resolvida
 * automaticamente para "Sem Resposta" no mesmo movimento — preserva o
 * fato de que ninguém decidiu a tempo, sem travar a Portaria.
 */
export async function registrarCheckIn(db, usuarioLogado, bookingId, dadosConfirmados) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    const dadosAtuais = normalizarBooking(snap.data());

    if (dadosAtuais.operacionalStatus !== OPERACIONAL.SEM_CHECKIN) {
      throw new Error(`Este agendamento já tem check-in registrado (situação atual: "${situacaoDetalhadaLabel(dadosAtuais)}"). Atualize a lista e tente novamente.`);
    }
    if (dadosAtuais.aprovacaoStatus === APROVACAO.CANCELADO) {
      throw new Error("Este agendamento foi cancelado pela transportadora. Se o veículo está fisicamente no local, registre-o pela Entrada Expressa (Encaixe).");
    }

    const agora = new Date();
    const pontualidade = calcularPontualidade(dadosAtuais.horaInicio, agora);
    const novoComparecimento = pontualidade === PONTUALIDADE.ATRASADO
      ? COMPARECIMENTO.COMPARECEU_ATRASADO
      : COMPARECIMENTO.COMPARECEU;

    // Resolve automaticamente uma aprovação PENDENTE — o veículo chegou,
    // e o check-in não pode ficar refém de uma decisão administrativa
    // que não aconteceu a tempo.
    const aprovacaoFinal = dadosAtuais.aprovacaoStatus === APROVACAO.PENDENTE
      ? APROVACAO.SEM_RESPOSTA
      : dadosAtuais.aprovacaoStatus;

    const placaCavalo = String(dadosConfirmados.placaCavalo || "").trim().toUpperCase();
    const placaCarreta = dadosConfirmados.placaCarreta ? String(dadosConfirmados.placaCarreta).trim().toUpperCase() : "";
    const motorista = String(dadosConfirmados.motorista || "").trim();
    const divergente = placaCavalo !== (dadosAtuais.placaCavalo || "")
      || placaCarreta !== (dadosAtuais.placaCarreta || "")
      || motorista !== (dadosAtuais.motorista || "");

    const novasDims = { aprovacaoStatus: aprovacaoFinal, comparecimentoStatus: novoComparecimento, operacionalStatus: OPERACIONAL.EM_PATIO };

    const historico = [
      _entradaHistorico("comparecimentoStatus", null, novoComparecimento, usuarioLogado.uid),
      _entradaHistorico("operacionalStatus", OPERACIONAL.SEM_CHECKIN, OPERACIONAL.EM_PATIO, usuarioLogado.uid)
    ];
    if (aprovacaoFinal !== dadosAtuais.aprovacaoStatus) {
      historico.push(_entradaHistorico("aprovacaoStatus", dadosAtuais.aprovacaoStatus, aprovacaoFinal, usuarioLogado.uid));
    }

    transaction.update(bookingRef, {
      placaCavalo,
      placaCarreta,
      motorista,
      aprovacaoStatus: aprovacaoFinal,
      comparecimentoStatus: novoComparecimento,
      operacionalStatus: OPERACIONAL.EM_PATIO,
      status: derivarStatusLegado(novasDims),
      checkIn: {
        dataHora: serverTimestamp(),
        pontualidade,
        dadosConferidos: true,
        divergente
      },
      historicoEstados: arrayUnion(...historico),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });
}

export async function registrarCheckOut(db, usuarioLogado, bookingId, dados) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    const dadosAtuais = normalizarBooking(snap.data());

    if (dadosAtuais.operacionalStatus !== OPERACIONAL.EM_PATIO) {
      throw new Error(`Só é possível dar check-out em veículos Em Pátio (situação atual: "${situacaoDetalhadaLabel(dadosAtuais)}").`);
    }

    const notaFiscal = String(dados.notaFiscal || "").trim();
    if (!notaFiscal) throw new Error("O número da Nota Fiscal é obrigatório para o check-out.");

    const agora = new Date();
    const permanenciaMinutos = calcularTempoPermanenciaMinutos(dadosAtuais.checkIn?.dataHora, agora);

    const novasDims = { aprovacaoStatus: dadosAtuais.aprovacaoStatus, comparecimentoStatus: dadosAtuais.comparecimentoStatus, operacionalStatus: OPERACIONAL.CONCLUIDO };

    transaction.update(bookingRef, {
      aprovacaoStatus: novasDims.aprovacaoStatus,
      comparecimentoStatus: novasDims.comparecimentoStatus,
      operacionalStatus: OPERACIONAL.CONCLUIDO,
      status: derivarStatusLegado(novasDims),
      checkOut: {
        dataHora: serverTimestamp(),
        notaFiscal,
        observacoesSaida: dados.observacoesSaida ? String(dados.observacoesSaida).trim() : "",
        permanenciaMinutos: permanenciaMinutos ?? 0
      },
      historicoEstados: arrayUnion(
        _entradaHistorico("operacionalStatus", OPERACIONAL.EM_PATIO, OPERACIONAL.CONCLUIDO, usuarioLogado.uid)
      ),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });
}

/**
 * Registra No-Show. Aplicável a agendamentos Aprovados OU Sem Resposta
 * que ainda não tiveram check-in — cobre tanto "confirmou e não veio"
 * quanto "ninguém decidiu e também não veio" (a Portaria não precisa
 * esperar a varredura automática de expiração para registrar isso).
 */
export async function registrarNoShow(db, usuarioLogado, bookingId) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");

  const bookingRef = doc(db, "bookings", bookingId);
  let vagaFoiLiberada = false;

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(bookingRef);
    if (!snap.exists()) throw new Error("Agendamento não encontrado (pode já ter sido removido).");
    const dadosAtuais = normalizarBooking(snap.data());

    const aprovacaoElegivel = [APROVACAO.APROVADO, APROVACAO.SEM_RESPOSTA].includes(dadosAtuais.aprovacaoStatus);
    if (!aprovacaoElegivel || dadosAtuais.operacionalStatus !== OPERACIONAL.SEM_CHECKIN) {
      throw new Error(`Só é possível marcar No-Show em agendamentos Aprovados/Sem Resposta que ainda não tiveram check-in (situação atual: "${situacaoDetalhadaLabel(dadosAtuais)}"). Atualize a lista e tente novamente.`);
    }

    const precisaLiberarVaga = dadosAtuais.vagaLiberada !== true;
    let slotSnap = null;
    if (precisaLiberarVaga) {
      const slotRef = doc(db, "timeSlots", idSlotHorario(dadosAtuais.dataAgendada, dadosAtuais.horaInicio));
      slotSnap = await transaction.get(slotRef);
    }

    const novasDims = { aprovacaoStatus: dadosAtuais.aprovacaoStatus, comparecimentoStatus: COMPARECIMENTO.NAO_COMPARECEU, operacionalStatus: dadosAtuais.operacionalStatus };

    const payload = {
      aprovacaoStatus: novasDims.aprovacaoStatus,
      comparecimentoStatus: COMPARECIMENTO.NAO_COMPARECEU,
      operacionalStatus: novasDims.operacionalStatus,
      status: derivarStatusLegado(novasDims),
      historicoEstados: arrayUnion(_entradaHistorico("comparecimentoStatus", null, COMPARECIMENTO.NAO_COMPARECEU, usuarioLogado.uid)),
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    };

    if (precisaLiberarVaga) {
      _liberarVagaNaTransacao(transaction, slotSnap);
      payload.vagaLiberada = true;
      vagaFoiLiberada = true;
    }

    transaction.update(bookingRef, payload);
  });

  return { vagaLiberada: vagaFoiLiberada };
}

export async function criarEntradaEncaixe(db, usuarioLogado, dados) {
  if (!usuarioLogado || !usuarioLogado.uid) throw new Error("Usuário não identificado.");
  validarCamposObrigatorios(dados);

  const dimsIniciais = {
    aprovacaoStatus: APROVACAO.APROVADO,
    comparecimentoStatus: COMPARECIMENTO.COMPARECEU,
    operacionalStatus: OPERACIONAL.EM_PATIO
  };

  const bookingRef = await addDoc(collection(db, "bookings"), {
    usuarioId: null,
    transportadoraCadastrada: false,
    empresa: String(dados.empresa).trim(),
    tipoProcessoId: dados.tipoProcessoId,
    dataAgendada: dados.dataAgendada,
    horaInicio: dados.horaInicio,
    horaFim: minutosParaHora((horaParaMinutos(dados.horaInicio) + 60) % (24 * 60)),
    placaCavalo: String(dados.placaCavalo).trim().toUpperCase(),
    placaCarreta: dados.placaCarreta ? String(dados.placaCarreta).trim().toUpperCase() : "",
    motorista: String(dados.motorista).trim(),
    observacoes: dados.observacoes ? String(dados.observacoes).trim() : "",
    ...dimsIniciais,
    historicoEstados: [
      _entradaHistorico("aprovacaoStatus", null, dimsIniciais.aprovacaoStatus, usuarioLogado.uid),
      _entradaHistorico("comparecimentoStatus", null, dimsIniciais.comparecimentoStatus, usuarioLogado.uid),
      _entradaHistorico("operacionalStatus", null, dimsIniciais.operacionalStatus, usuarioLogado.uid)
    ],
    status: derivarStatusLegado(dimsIniciais),
    tipoAgendamento: TIPO_AGENDAMENTO.PORTARIA,
    vagaLiberada: false,
    checkIn: {
      dataHora: serverTimestamp(),
      pontualidade: PONTUALIDADE.PONTUAL,
      dadosConferidos: true,
      divergente: false
    },
    criadoEm: serverTimestamp(),
    criadoPor: usuarioLogado.uid,
    atualizadoEm: serverTimestamp(),
    atualizadoPor: usuarioLogado.uid
  });

  return { bookingId: bookingRef.id };
}

/* #######################################################################
   PARTE 8 — VARREDURA DE VAGAS PRESAS POR CANCELAMENTO DA TRANSPORTADORA
   ####################################################################### */

async function liberarVagaSemMudarStatus(db, usuarioLogado, booking) {
  const bookingRef = doc(db, "bookings", booking.id);
  const slotRef = doc(db, "timeSlots", idSlotHorario(booking.dataAgendada, booking.horaInicio));

  await runTransaction(db, async (transaction) => {
    const bookingSnap = await transaction.get(bookingRef);
    if (!bookingSnap.exists()) return;
    if (bookingSnap.data().vagaLiberada === true) return;

    const slotSnap = await transaction.get(slotRef);
    _liberarVagaNaTransacao(transaction, slotSnap);

    transaction.update(bookingRef, {
      vagaLiberada: true,
      aprovacaoStatus: APROVACAO.CANCELADO,
      comparecimentoStatus: null,
      operacionalStatus: OPERACIONAL.SEM_CHECKIN,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: usuarioLogado.uid
    });
  });
}

export async function liberarVagasCanceladasPelaTransportadora(db, usuarioLogado) {
  const snap = await getDocs(query(collection(db, "bookings"), where("status", "==", STATUS.CANCELADO)));

  const pendentesDeLiberacao = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => b.vagaLiberada !== true);

  let totalLiberadas = 0;
  for (const booking of pendentesDeLiberacao) {
    try {
      await liberarVagaSemMudarStatus(db, usuarioLogado, booking);
      totalLiberadas++;
    } catch (err) {
      console.error(`Erro ao liberar vaga do agendamento cancelado ${booking.id}:`, err);
    }
  }

  return totalLiberadas;
}
