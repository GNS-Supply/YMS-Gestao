// =====================================================================
// expirar-pendentes.mjs — Varredura de expiração de solicitações
//
// Roda via GitHub Actions (ver expirar-pendentes.yml) a cada 15 minutos,
// usando firebase-admin (fora das Firestore Rules do cliente, por isso
// precisa da própria validação de negócio aqui dentro).
//
// REGRA (alinhada com patioCore.js / APROVACAO.SEM_RESPOSTA):
//   Um agendamento só deve ser marcado EXPIRADO quando:
//     1) sua dimensão administrativa ainda está em aberto
//        (PENDENTE ou SEM_RESPOSTA — nunca RECUSADO/CANCELADO/APROVADO);
//     2) ele ainda NÃO teve check-in (operacionalStatus === SEM_CHECKIN)
//        — se o veículo já chegou, o check-in já resolveu a pendência
//        (ver registrarCheckIn em patioCore.js), então não há mais nada
//        para expirar aqui;
//     3) a janela agendada (data + horaInicio) + TOLERANCIA_HORAS de
//        carência já passou.
//
//   Isso vale tanto para quem nunca foi respondido pela Logística
//   (PENDENTE) quanto para quem passou de PENDENTE para SEM_RESPOSTA
//   por outro motivo — nos dois casos o resultado é EXPIRADO, e a vaga
//   é liberada em timeSlots.ocupados na mesma transação.
//
// Variáveis de ambiente (definidas no workflow):
//   FIREBASE_SERVICE_ACCOUNT_JSON — JSON da service account (secret)
//   TOLERANCIA_HORAS              — horas de carência após o início da
//                                    janela antes de expirar (padrão 2)
//   FUSO_OFFSET                   — offset do fuso do pátio, ex "-03:00"
//                                    (padrão "-03:00", horário de Brasília)
// =====================================================================

import { initializeApp, cert } from "firebase-admin/app";
import {
  getFirestore,
  FieldValue,
  Timestamp
} from "firebase-admin/firestore";

const APROVACAO = {
  PENDENTE: "PENDENTE",
  SEM_RESPOSTA: "SEM_RESPOSTA",
  EXPIRADO: "EXPIRADO"
};
const OPERACIONAL = { SEM_CHECKIN: "SEM_CHECKIN" };
const STATUS_EXPIRADO_LEGADO = "Expirado";

function carregarServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON não definido. Configure o secret no GitHub Actions.");
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON não é um JSON válido: " + err.message);
  }
}

function idSlotHorario(dataStr, horaInicio) {
  return `${dataStr}_${horaInicio.replace(":", "-")}`;
}

/**
 * Constrói o instante (UTC) em que a janela agendada + tolerância
 * expira, a partir de `dataAgendada` ("AAAA-MM-DD"), `horaInicio`
 * ("HH:MM") e o offset de fuso do pátio (ex.: "-03:00").
 */
function calcularInstanteLimite(dataAgendada, horaInicio, toleranciaHoras, fusoOffset) {
  // "AAAA-MM-DDTHH:MM:00-03:00" é um formato ISO 8601 válido — o motor
  // de Date do Node interpreta o offset corretamente e converte para o
  // instante UTC equivalente internamente.
  const isoComOffset = `${dataAgendada}T${horaInicio}:00${fusoOffset}`;
  const inicioJanela = new Date(isoComOffset);
  if (isNaN(inicioJanela.getTime())) return null;
  return new Date(inicioJanela.getTime() + toleranciaHoras * 60 * 60 * 1000);
}

async function main() {
  const toleranciaHoras = Number(process.env.TOLERANCIA_HORAS || "2");
  const fusoOffset = process.env.FUSO_OFFSET || "-03:00";

  const app = initializeApp({ credential: cert(carregarServiceAccount()) });
  const db = getFirestore(app);

  const agora = new Date();

  // Busca só o necessário: ainda sem check-in. Filtra PENDENTE/SEM_RESPOSTA
  // e a janela vencida em memória, para não depender de um índice
  // composto (aprovacaoStatus IN [...] + operacionalStatus ==) que o
  // projeto não declara em firestore.indexes.json.
  const snap = await db.collection("bookings")
    .where("operacionalStatus", "==", OPERACIONAL.SEM_CHECKIN)
    .get();

  const candidatos = snap.docs.filter(d => {
    const b = d.data();
    return [APROVACAO.PENDENTE, APROVACAO.SEM_RESPOSTA].includes(b.aprovacaoStatus)
      && b.dataAgendada && b.horaInicio;
  });

  let totalExpirados = 0;
  let totalIgnorados = 0;
  let totalErros = 0;

  for (const docSnap of candidatos) {
    const booking = docSnap.data();
    const instanteLimite = calcularInstanteLimite(booking.dataAgendada, booking.horaInicio, toleranciaHoras, fusoOffset);

    if (!instanteLimite || agora < instanteLimite) {
      totalIgnorados++;
      continue;
    }

    const bookingRef = db.collection("bookings").doc(docSnap.id);
    const slotRef = db.collection("timeSlots").doc(idSlotHorario(booking.dataAgendada, booking.horaInicio));

    try {
      await db.runTransaction(async (tx) => {
        const bookingSnapAtual = await tx.get(bookingRef);
        if (!bookingSnapAtual.exists) return;
        const dadosAtuais = bookingSnapAtual.data();

        // Revalida dentro da transação — outra execução ou um check-in
        // pode ter mudado o estado entre a consulta e agora.
        if (dadosAtuais.operacionalStatus !== OPERACIONAL.SEM_CHECKIN) return;
        if (![APROVACAO.PENDENTE, APROVACAO.SEM_RESPOSTA].includes(dadosAtuais.aprovacaoStatus)) return;

        const precisaLiberarVaga = dadosAtuais.vagaLiberada !== true;
        let slotSnapAtual = null;
        if (precisaLiberarVaga) {
          slotSnapAtual = await tx.get(slotRef);
        }

        const payload = {
          aprovacaoStatus: APROVACAO.EXPIRADO,
          status: STATUS_EXPIRADO_LEGADO,
          historicoEstados: FieldValue.arrayUnion({
            dataHora: Timestamp.now(),
            dimensaoAlterada: "aprovacaoStatus",
            valorAnterior: dadosAtuais.aprovacaoStatus,
            novoValor: APROVACAO.EXPIRADO,
            usuarioId: "sistema:expirar-pendentes"
          }),
          atualizadoEm: FieldValue.serverTimestamp(),
          atualizadoPor: "sistema:expirar-pendentes"
        };

        if (precisaLiberarVaga && slotSnapAtual && slotSnapAtual.exists) {
          const slotData = slotSnapAtual.data();
          const ocupadosAtuais = slotData.ocupados || 0;
          if (ocupadosAtuais > 0) {
            tx.set(slotRef, { ...slotData, ocupados: ocupadosAtuais - 1 }, { merge: true });
          }
          payload.vagaLiberada = true;
        }

        tx.update(bookingRef, payload);
      });

      await db.collection("auditLogs").add({
        bookingId: docSnap.id,
        usuarioId: "sistema:expirar-pendentes",
        acao: "Expirou",
        dataHora: FieldValue.serverTimestamp()
      });

      totalExpirados++;
    } catch (err) {
      totalErros++;
      console.error(`Erro ao expirar o agendamento ${docSnap.id}:`, err);
    }
  }

  console.log(
    `Varredura concluída: ${totalExpirados} expirado(s), ${totalIgnorados} ainda dentro do prazo, ${totalErros} erro(s). ` +
    `Tolerância: ${toleranciaHoras}h | Fuso: ${fusoOffset}.`
  );

  if (totalErros > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Falha fatal na varredura de expiração:", err);
  process.exitCode = 1;
});
