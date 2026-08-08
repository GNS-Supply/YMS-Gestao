// =====================================================================
// disponibilidade.js
//
// Motor de cálculo de horários/vagas disponíveis para uma data qualquer,
// sem precisar "gerar" janelas manualmente no calendário. Qualquer data
// futura já é automaticamente calculada combinando 3 camadas, em ordem
// de prioridade crescente:
//
//   1) timeSlotRules       -> Regra Padrão de Atendimento (recorrente por
//                              dia da semana). Ex: Seg a Sex, 06:00-00:00.
//   2) timeSlotExceptions  -> Exceções recorrentes por dia da semana, que
//                              sobrescrevem a regra padrão. Ex: Domingo
//                              sem atendimento; Seg a Sex 11:00-14:00
//                              limite de 1 veículo/hora.
//   3) timeSlots           -> Ajuste manual pontual para UMA data
//                              específica (prioridade máxima). Também é
//                              onde a ocupação real (contagem de
//                              agendamentos) fica registrada, criado de
//                              forma "preguiçosa" (lazy) no momento da
//                              primeira reserva daquele horário.
// =====================================================================
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

export function horaParaMinutos(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutosParaHora(min) {
  const h = String(Math.floor(min / 60)).padStart(2, "0");
  const m = String(min % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// ID determinístico do documento em timeSlots para uma data + horário.
export function idSlotHorario(dataStr, horaInicio) {
  return `${dataStr}_${horaInicio.replace(":", "-")}`;
}

// Converte um objeto { horaInicio, horaFim } em uma lista de blocos de 1h
// (representados pelo minuto de início, 0-1439), tratando corretamente
// intervalos que atravessam a meia-noite (ex: 06:00 às 00:00).
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
  return new Date(ano, mes - 1, dia).getDay(); // 0=domingo ... 6=sábado
}

/**
 * Calcula os horários "virtuais" de uma data específica, combinando
 * Regra Padrão + Exceções + Ajustes Manuais.
 *
 * @param {Firestore} db
 * @param {string} dataStr - formato "AAAA-MM-DD"
 * @param {object} [opcoes]
 *   - incluirFechados (default false): se true, mantém no resultado os
 *     horários fechados manualmente para aquela data (flag `fechado: true`)
 *     em vez de omiti-los. Útil na tela de gestão (para poder reabrir);
 *     na tela de agendamento da transportadora deve ficar false.
 * @returns {Promise<Array<{
 *   horaInicio: string, horaFim: string, capacidadeMax: number,
 *   ocupados: number, origem: "regra"|"excecao"|"manual", fechado: boolean,
 *   temAjusteManual: boolean
 * }>>}
 */
export async function buscarSlotsVirtuaisDoDia(db, dataStr, opcoes = {}) {
  const { incluirFechados = false } = opcoes;
  const diaSemana = diaSemanaDaData(dataStr);
  const mapa = {}; // horaInicio -> { capacidadeMax, origem, fechado? }

  // 1) Regra Padrão de Atendimento
  const snapRegras = await getDocs(query(collection(db, "timeSlotRules"), where("ativo", "==", true)));
  snapRegras.docs.forEach(d => {
    const r = d.data();
    if (!(r.diasSemana || []).includes(diaSemana)) return;
    calcularBlocosHorario(r).forEach(min => {
      mapa[minutosParaHora(min)] = { capacidadeMax: r.capacidadePorHora, origem: "regra" };
    });
  });

  // 2) Exceções recorrentes (sobrescrevem a regra padrão)
  const snapExc = await getDocs(query(collection(db, "timeSlotExceptions"), where("ativo", "==", true)));
  snapExc.docs.forEach(d => {
    const ex = d.data();
    if (!(ex.diasSemana || []).includes(diaSemana)) return;
    calcularBlocosHorario(ex).forEach(min => {
      const hora = minutosParaHora(min);
      if (Number(ex.capacidadePorHora) <= 0) {
        // 0 = sem atendimento nesse intervalo/dia
        delete mapa[hora];
      } else {
        mapa[hora] = { capacidadeMax: ex.capacidadePorHora, origem: "excecao" };
      }
    });
  });

  // 3) Ajustes manuais pontuais para esta data específica (prioridade máxima)
  //    Também é onde fica registrada a ocupação real já reservada.
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
    return {
      horaInicio: hora,
      horaFim: minutosParaHora((horaParaMinutos(hora) + 60) % (24 * 60)),
      capacidadeMax: info.capacidadeMax,
      ocupados: manual ? (manual.ocupados || 0) : 0,
      origem: info.origem,
      fechado: !!info.fechado,
      temAjusteManual: !!manual
    };
  });
}
